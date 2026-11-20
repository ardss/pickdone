#!/usr/bin/env node
/**
 * Affected-scope selection for the pre-commit unit stage (2026-10-23 perf wave, S2).
 *
 * Goal: a small commit should not pay for the whole ~727-file core tier. This module maps
 * STAGED files to the test directories whose suites exercise them, at DIRECTORY granularity
 * — deliberately coarse, because coarse only ever OVERSHOOTS (runs extra suites) while a
 * precise import graph could UNDERSHOOT (silent false green, the one unforgivable failure).
 * Source-anchor tests (fs-reading pins like d21/f4 anchors) contain no imports of their
 * target — directory mapping covers them naturally, an import graph would not.
 *
 * Fail-safe contract (every branch fails WIDE, never narrow):
 *   - any staged file outside the known map (unrecognized top dir, non-code extension) →
 *     fallback: full core tier (exit 0 + "full" verdict)
 *   - docs-only changes (all staged files matching the docs whitelist) → exit 0 + "skip"
 *     verdict with a loud line (a Markdown commit cannot break a unit assertion)
 *   - empty scope / scope error → fallback: full core tier
 *   - tests themselves staged → the touched test dirs run directly (plus their whole dir:
 *     a changed helper in tests/lib affects every suite importing it — coarse again)
 *
 * Staged-source contract (2026-10-28 W16-SCOPE-ARGV-P1, parameter-mode confusion fix):
 *   - REQUIRED when imported (check-test-summary.cjs --affected): `stagedFiles()` reads the
 *     GIT staged set (`git diff --cached`) ONLY. It MUST NOT read `process.argv` — argv
 *     belongs to the importing process (its flags like --core/--affected/--retry-once were
 *     being swallowed as staged "filenames", degrading every scoped run to full tier via
 *     "unmapped surface: --core").
 *   - Direct CLI positional args (`node cli/check-test-scope.cjs [staged-file...]`) remain
 *     supported, but ONLY in the require.main path, and flag-like tokens (`--*`) are always
 *     filtered out — flags are never filenames.
 *
 * Rebase note (2026-10-29 W16-SCOPE-W17-W18-REBASE-ISOLATED): this copy is the W16 separation
 * patch REBASED onto the evolved repo file — it KEEPS the W17 fix (ACMR: `git mv 源文件 + 文档`
 * must not degrade to docs-only skip) and the W18 fix (`-c core.quotePath=false`: non-ASCII
 * paths must not be octal-escaped into DOCS_ONLY misses). Neither fix is reverted by the
 * separation; the narrow tests lock both.
 *
 * Output contract (consumed by cli/check-test-summary.cjs --affected):
 *   stdout JSON: { verdict: "scoped" | "full" | "skip", dirs: ["tests/unit/store", ...],
 *                  reason: string }
 *   exit 0 always (decisions are data, not errors) — the consumer applies the verdict.
 *
 * Usage: node cli/check-test-scope.cjs [staged-file...]   (defaults to git diff --cached)
 */
const { execFileSync } = require('node:child_process')
const path = require('node:path')
// W28 fix(2026-11-01): git 子进程剥离 hook 注入的 GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE
//（共享 lib-git-env.cjs，同 check-file-size/check-boot-order 的 W18 修复）——否则本门禁
// 在 fixture 树/嵌套 cwd 下读错仓库。
const { gitEnv } = require('./lib-git-env.cjs')

const ROOT = path.join(__dirname, '..')

// Code surfaces → the test dirs that exercise them. Keys are repo-relative POSIX dir prefixes,
// values are tests/ dirs (relative to pickdone/). One test dir may serve several surfaces;
// unions dedupe. ORDER MATTERS: match takes the FIRST entry whose prefix hits (see scopeFor),
// so MORE-SPECIFIC prefixes must sit ABOVE their generic parents (src/main/lan-sync before
// src/main, shared/sync-* before shared, renderer/js/store before renderer/js).
const SURFACE_MAP = [
  // billing: server/billing/** is pinned by the tests/unit/billing suites (dynamic import —
  // an import graph would MISS these, the coarse map is exactly what covers them)
  ['server/billing', ['tests/unit/billing']],
  ['server/billing-service', ['tests/unit/billing']],
  // lan-sync + shared sync cores (2026-10-23 audit: these were unmapped — a scoped run on a
  // shared/sync-core change would have SKIPPED tests/unit/sync, an undershoot)
  ['server/sync-relay', ['tests/unit/lan-sync', 'tests/unit/sync']],
  ['src/main/lan-sync', ['tests/unit/lan-sync', 'tests/unit/main']],
  ['shared/sync-core', ['tests/unit/sync', 'tests/unit/lan-sync', 'tests/unit/main']],
  ['shared/sync-crypto', ['tests/unit/sync', 'tests/unit/lan-sync', 'tests/unit/security']],
  ['shared/sync-transport', ['tests/unit/lan-sync', 'tests/unit/sync']],
  ['renderer/js/store', ['tests/unit/store', 'tests/unit/components', 'tests/unit/renderer']],
  ['renderer/js/utils', ['tests/unit/renderer', 'tests/unit/utils', 'tests/unit/components']],
  ['renderer/js/components', ['tests/unit/components', 'tests/unit/renderer']],
  ['renderer/js/views', ['tests/unit/renderer', 'tests/unit/components']],
  ['renderer/js/i18n', ['tests/unit/cli', 'tests/unit/renderer']],
  ['renderer/js', ['tests/unit/renderer', 'tests/unit/components', 'tests/unit/store', 'tests/unit/utils']],
  ['src/main', ['tests/unit/main']],
  ['src/preload', ['tests/unit/main', 'tests/unit/renderer']],
  ['shared', ['tests/unit/main', 'tests/unit/store', 'tests/unit/lan-sync']],
  ['cli', ['tests/unit/cli']],
  ['scripts', ['tests/unit/cli']],
  // generic server fallback (specific server/* entries above): any other server-side change
  // runs both server-side consumers — overshoot by design, never an undershoot
  ['server', ['tests/unit/billing', 'tests/unit/lan-sync', 'tests/unit/cli']],
  ['tests/lib', ['tests/unit']],
  // the commit gate itself: gate-mechanics self-tests live in cli/ and meta/
  ['.githooks', ['tests/unit/cli', 'tests/unit/meta']],
]

// Changes that cannot affect code behavior. Only these may produce the "skip" verdict.
const DOCS_ONLY = /(^|\/)(docs\/.*|[^/]*\.md|[^/]*\.png|[^/]*\.jpe?g|[^/]*\.gif|[^/]*\.svg|\.gitignore|\.editorconfig|LICENSE.*)$/i

// Git is the ONLY staged-file source for in-process imports (W16-SCOPE-ARGV-P1).
function stagedFilesFromGit () {
  try {
    // W17 fix(2026-10-28): ACMR — `git mv 源文件 + 文档` 的 staged 集在 ACM 下只剩文档条目,
    // 被误判 docs-only → 单测整级 skip。R(改名)与 W16 其余门对齐。
    // W18 fix(2026-10-28): quotePath=false — git 默认把非 ASCII 路径引成八进制转义,
    // `docs/界面指南.md` 变成 `"\347\225\214..."`,DOCS_ONLY 白名单匹配不上 → 文档提交被误判
    // code/unmapped → 整级 full。与 W16 其余门禁同一 pin(`-c` 每次调用生效,不会传播,故此处也要)。
    const out = execFileSync('git', ['-c', 'core.quotePath=false', 'diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
      cwd: ROOT, encoding: 'utf8', env: gitEnv(),
    })
    return out.split(/\r?\n/).filter(Boolean).map(f => f.split(path.sep).join('/'))
  } catch {
    return null // git unavailable → caller treats as "cannot scope"
  }
}

// CLI-only: the require.main path may accept explicit staged names from ITS OWN argv.
// Flag-like tokens are filtered unconditionally — `--core` is an option, never a filename.
function stagedFilesFromArgv (argv = []) {
  return argv
    .filter(a => !a.startsWith('--'))
    .map(f => f.split(path.sep).join('/'))
}

// In-process contract: git staged set only. NEVER reads process.argv (the importing
// process's flags must not be mistaken for staged filenames — W16-SCOPE-ARGV-P1).
function stagedFiles () {
  return stagedFilesFromGit()
}

// Strip the optional "pickdone/" repo-root prefix and normalize ".." segments so traversal
// paths like renderer/js/../store cannot sneak past prefix matching (found by the scope
// golden self-tests: renderer/js/../../escape.js used to match the generic renderer entry).
function normalize (f) {
  const noRoot = f.startsWith('pickdone/') ? f.slice('pickdone/'.length) : f
  return path.posix.normalize(noRoot)
}

/* ---- version-only manifest bumps (2026-11-20 commit-speed) -------------------------------
 * `npm run pack` bumps the version in package.json + package-lock.json; neither file is a code
 * surface, so both used to hit "unmapped surface → full core tier": a 5-minute-per-commit tax on
 * a change that cannot alter an assertion. Version-only is recognised by comparing the STAGED
 * blob with HEAD after stripping the "version" field — any dependency/script/build edit still
 * fails wide (real surface, real risk).
 *
 * Untracked/new manifests (no HEAD blob) and unreadable git → not version-only → fail wide. */

function blob (spec) {
  try {
    return execFileSync('git', ['show', spec], { cwd: ROOT, encoding: 'utf8', env: gitEnv(), stdio: ['ignore', 'pipe', 'ignore'] })
  } catch {
    return null
  }
}

/** Pure: does `staged` differ from `head` ONLY in version fields? Identical content → false
 *  ("nothing staged" is not a licence to skip tests — the golden self-tests feed synthetic file
 *  lists against a clean worktree and must keep getting "package.json → fail wide"). Unparseable
 *  JSON → false (fail wide). */
function versionOnlyChange (staged, head, isLock = false) {
  if (staged == null || head == null) return false
  if (staged === head) return false
  const strip = s => {
    try {
      const o = JSON.parse(s)
      delete o.version
      if (isLock && o.packages && o.packages['']) delete o.packages[''].version
      return JSON.stringify(o)
    } catch { return s }
  }
  return strip(staged) === strip(head)
}

/** true iff package.json's staged content differs from HEAD ONLY in the version field.
 *  Path specs are repo-root relative ('pickdone/...'): the worktree root ALSO carries a
 *  package.json (the workspace manifest), so a bare ':0:package.json' silently reads the
 *  WRONG manifest — git resolves show paths against the repository root, not the cwd. */
function pkgVersionOnly () {
  return versionOnlyChange(blob(':0:pickdone/package.json'), blob('HEAD:pickdone/package.json'))
}

/** version field of a staged manifest, or null when unreadable */
function stagedVersion (name) {
  const raw = blob(`:0:pickdone/${name}`)
  if (raw == null) return null
  try {
    const o = JSON.parse(raw)
    return o.version || null
  } catch {
    return null
  }
}

/** package-lock.json is neutral when it did not change at all, or when the only change is the
 *  version fields riding a version-only manifest bump.
 *
 *  2026-11-21 (beta.41 drift): an UNTOUCHED lockfile used to be neutral unconditionally, so
 *  "hand-edited package.json bump, lockfile left at the old version" was neutral on both sides
 *  (pkg: version-only; lock: unchanged) → the unit stage was skipped wholesale and the skew only
 *  existed as a P1-4h assertion that the same gate had deferred. Neutrality now requires the two
 *  manifests to AGREE; a skew fails wide, and cli/check-version-consistency.cjs blocks it outright. */
function lockVersionOnly () {
  const staged = blob(':0:pickdone/package-lock.json')
  const head = blob('HEAD:pickdone/package-lock.json')
  if (staged == null || head == null) return false
  const pkgV = stagedVersion('package.json')
  let lockV = null
  try {
    lockV = JSON.parse(staged).version || null
  } catch {
    return false // unparseable lockfile is a real surface problem, not a neutral bump
  }
  if (pkgV && lockV && pkgV !== lockV) return false
  if (staged === head) return true // untouched lockfile that still agrees with the manifest
  return pkgVersionOnly() && versionOnlyChange(staged, head, true)
}

function scopeFor (files = stagedFiles()) {
  if (!files || !files.length) return { verdict: 'full', dirs: [], reason: 'no staged files readable — fail wide' }
  const code = []
  let docsOnly = true
  let manifestNeutral = false
  for (const raw of files) {
    const f = normalize(raw)
    if (DOCS_ONLY.test(f)) continue
    // version-only manifest bumps cannot alter an assertion (git reads happen only when one of
    // these two files is actually in the staged set)
    if (f === 'package.json' && pkgVersionOnly()) { manifestNeutral = true; continue }
    if (f === 'package-lock.json' && lockVersionOnly()) { manifestNeutral = true; continue }
    docsOnly = false
    if (f.startsWith('tests/') || f.startsWith('test/')) { code.push(f); continue }
    const hit = SURFACE_MAP.find(([prefix]) => f.startsWith(prefix + '/'))
    if (!hit) return { verdict: 'full', dirs: [], reason: `unmapped surface: ${f} — fail wide` }
    code.push(f)
  }
  if (docsOnly && !manifestNeutral) return { verdict: 'skip', dirs: [], reason: 'docs-only change — unit stage not meaningful' }
  if (!code.length && manifestNeutral) return { verdict: 'skip', dirs: [], reason: 'version-only manifest bump — no test surface' }
  if (!code.length) return { verdict: 'full', dirs: [], reason: 'no code files after filtering — fail wide' }

  const dirs = new Set()
  for (const raw of code) {
    const f = normalize(raw)
    if (f.startsWith('tests/') || f.startsWith('test/')) {
      // The staged TEST files' own dirs (a changed helper/helper-adjacent spec) — plus, coarse
      // again, tests/lib changes touch everything.
      if (f.startsWith('tests/lib/')) { dirs.add('tests/unit'); continue }
      // W34 fix: capture the DIR component only. A file DIRECTLY under tests/unit/ (no second
      // slash) used to make [^/]+ swallow the filename, so the FILE path itself became a --dirs
      // entry and run-all fail-closed with "entry matching no discovered test file".
      const m = /^(tests\/unit\/[^/]+)\//.exec(f)
      if (m) { dirs.add(m[1]); continue }
      if (/^tests\/unit\/[^/]+$/.test(f)) { dirs.add('tests/unit'); continue }
      return { verdict: 'full', dirs: [], reason: `staged non-unit test: ${f} — fail wide` }
    }
    const hit = SURFACE_MAP.find(([prefix]) => f.startsWith(prefix + '/'))
    for (const d of hit[1]) dirs.add(d)
  }
  if (!dirs.size) return { verdict: 'full', dirs: [], reason: 'empty scope — fail wide' }
  return { verdict: 'scoped', dirs: [...dirs].sort(), reason: `${code.length} staged code file(s) → ${dirs.size} test dir(s)` }
}

if (require.main === module) {
  const cliFiles = stagedFilesFromArgv(process.argv.slice(2))
  const result = scopeFor(cliFiles.length ? cliFiles : stagedFilesFromGit())
  console.log(JSON.stringify(result))
  process.exit(0)
}

module.exports = { scopeFor, stagedFiles, stagedFilesFromGit, stagedFilesFromArgv, SURFACE_MAP, DOCS_ONLY, versionOnlyChange }
