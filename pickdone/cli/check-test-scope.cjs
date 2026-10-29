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
 * Output contract (consumed by cli/check-test-summary.cjs --affected):
 *   stdout JSON: { verdict: "scoped" | "full" | "skip", dirs: ["tests/unit/store", ...],
 *                  reason: string }
 *   exit 0 always (decisions are data, not errors) — the consumer applies the verdict.
 *
 * Usage: node cli/check-test-scope.cjs [staged-file...]   (defaults to git diff --cached)
 */
const { execFileSync } = require('node:child_process')
const path = require('node:path')

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
]

// Changes that cannot affect code behavior. Only these may produce the "skip" verdict.
const DOCS_ONLY = /(^|\/)(docs\/.*|[^/]*\.md|[^/]*\.png|[^/]*\.jpe?g|[^/]*\.gif|[^/]*\.svg|\.gitignore|\.editorconfig|LICENSE.*)$/i

function stagedFiles () {
  const args = process.argv.slice(2)
  if (args.length) return args.map(f => f.split(path.sep).join('/'))
  try {
    // W17 fix(2026-10-28): ACMR — `git mv 源文件 + 文档` 的 staged 集在 ACM 下只剩文档条目,
    // 被误判 docs-only → 单测整级 skip。R(改名)与 W16 其余门对齐。
    // W18 fix(2026-10-28): quotePath=false — git 默认把非 ASCII 路径引成八进制转义,
    // `docs/界面指南.md` 变成 `"\347\225\214..."`,DOCS_ONLY 白名单匹配不上 → 文档提交被误判
    // code/unmapped → 整级 full。与 W16 其余门禁同一 pin(`-c` 每次调用生效,不会传播,故此处也要)。
    const out = execFileSync('git', ['-c', 'core.quotePath=false', 'diff', '--cached', '--name-only', '--diff-filter=ACMR'], {
      cwd: ROOT, encoding: 'utf8',
    })
    return out.split(/\r?\n/).filter(Boolean).map(f => f.split(path.sep).join('/'))
  } catch {
    return null // git unavailable → caller treats as "cannot scope"
  }
}

// Strip the optional "pickdone/" repo-root prefix and normalize ".." segments so traversal
// paths like renderer/js/../store cannot sneak past prefix matching (found by the scope
// golden self-tests: renderer/js/../../escape.js used to match the generic renderer entry).
function normalize (f) {
  const noRoot = f.startsWith('pickdone/') ? f.slice('pickdone/'.length) : f
  return path.posix.normalize(noRoot)
}

function scopeFor (files = stagedFiles()) {
  if (!files || !files.length) return { verdict: 'full', dirs: [], reason: 'no staged files readable — fail wide' }
  const code = []
  let docsOnly = true
  for (const raw of files) {
    const f = normalize(raw)
    if (DOCS_ONLY.test(f)) continue
    docsOnly = false
    if (f.startsWith('tests/') || f.startsWith('test/')) { code.push(f); continue }
    const hit = SURFACE_MAP.find(([prefix]) => f.startsWith(prefix + '/'))
    if (!hit) return { verdict: 'full', dirs: [], reason: `unmapped surface: ${f} — fail wide` }
    code.push(f)
  }
  if (docsOnly) return { verdict: 'skip', dirs: [], reason: 'docs-only change — unit stage not meaningful' }
  if (!code.length) return { verdict: 'full', dirs: [], reason: 'no code files after filtering — fail wide' }

  const dirs = new Set()
  for (const raw of code) {
    const f = normalize(raw)
    if (f.startsWith('tests/') || f.startsWith('test/')) {
      // The staged TEST files' own dirs (a changed helper/helper-adjacent spec) — plus, coarse
      // again, tests/lib changes touch everything.
      if (f.startsWith('tests/lib/')) { dirs.add('tests/unit'); continue }
      const m = /^(tests\/unit\/[^/]+)/.exec(f)
      if (m) { dirs.add(m[1]); continue }
      return { verdict: 'full', dirs: [], reason: `staged non-unit test: ${f} — fail wide` }
    }
    const hit = SURFACE_MAP.find(([prefix]) => f.startsWith(prefix + '/'))
    for (const d of hit[1]) dirs.add(d)
  }
  if (!dirs.size) return { verdict: 'full', dirs: [], reason: 'empty scope — fail wide' }
  return { verdict: 'scoped', dirs: [...dirs].sort(), reason: `${code.length} staged code file(s) → ${dirs.size} test dir(s)` }
}

if (require.main === module) {
  const result = scopeFor(stagedFiles())
  console.log(JSON.stringify(result))
  process.exit(0)
}

module.exports = { scopeFor, stagedFiles, SURFACE_MAP, DOCS_ONLY }
