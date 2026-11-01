// Run the project's existing ESLint on staged source changes only.
// Shell-free Git and Node calls work when this repository is opened via UNC.
// Full-tree lint remains part of check:all; pre-commit checks only this commit.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

// GATE_ROOT override (gate-must-fail-golden fixture convention): fixture trees exercise the
// gate against a temp checkout; real pre-commit usage never sets it and keeps the script-dir
// anchor.
const root = process.env.GATE_ROOT ? resolve(process.env.GATE_ROOT) : join(dirname(fileURLToPath(import.meta.url)), '..')
// W20 fix (2026-10-30): pin -c core.quotePath=false. Without it git emits non-ASCII paths as
// quoted octal escapes ("\346\226\207..."), so startsWith('pickdone/') and the scope regex
// matched nothing while real staged source existed — the inScopeUnselected fail-closed tripwire
// below caught it, but the gate degenerated to that path for every CJK-named file (same family
// as the W17/W18 quotePath pins in check-i18n.js / check-boot-order.cjs / pre-commit stage 1).
// W23 #6 (2026-10-31): scope widened to the eslint-covered source roots — shared|scripts|server|
// browser-dev now stage real .js/.mjs/.cjs source that eslint applies to, but the old regex
// silently skipped them (gate hole: a broken script under scripts/ committed green).
// NOTE: check-all.js:84 keeps its own eslint argument list — THAT file's list must be widened
// identically, but check-all.js is out of this lane's territory (another agent owns it); tracked
// as a TODO for the main session to sync.
const staged = execFileSync('git', [
  '-c', 'core.quotePath=false',
  'diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'
], { cwd: root }).toString('utf8').split('\0').filter(Boolean)
const LINT_SCOPE = /^(?:renderer\/js|cli|src|tests|shared|scripts|server|browser-dev)\//
const selected = staged
  .filter(name => name.startsWith('pickdone/'))
  .map(name => name.slice('pickdone/'.length))
  .filter(name => LINT_SCOPE.test(name))
  .filter(name => /\.(?:js|cjs|mjs|vue)$/.test(name))
if (selected.length === 0) {
  // [fail-closed 2026-10-26, mirrors pre-commit stage-1 guard in 021f905b]: a staged file
  // that satisfies the scope+extension contract only via the OPTIONAL pickdone/ prefix
  // means real in-scope source is staged but the prefix-strip/scope normalization selected
  // none of it — historically this path exited 0 green for the gate's whole life
  // (same shape as the check-file-size --staged zero-file no-op). Refuse loudly.
  const inScopeUnselected = staged.filter(name =>
    /^(?:pickdone\/)?(?:renderer\/js|cli|src|tests|shared|scripts|server|browser-dev)\//.test(name) &&
    /\.(?:js|cjs|mjs|vue)$/.test(name))
  if (inScopeUnselected.length > 0) {
    console.error(`✗ [pre-commit] ESLint breaker: ${inScopeUnselected.length} staged in-scope source file(s) exist but 0 survived prefix/scope normalization (path normalization failure) — refusing fake green`)
    for (const n of inScopeUnselected.slice(0, 20)) console.error('  ' + n)
    process.exit(1)
  }
  console.log('[pre-commit] ESLint: no staged source changes in lint scope')
} else {
  // W25 fix (2026-11-01): eslint used to lint the WORKTREE file — with `git add -p` partial
  // staging the committed index blob was never linted (bad hunk staged + worktree cleaned up
  // afterwards = broken code lands green). When the staged blob differs from the worktree
  // (probe = bare `git diff`, index vs worktree — NOT --cached, which diffs index vs HEAD and
  // reads "differs" for every staged file),
  // extract `git show :<path>` into a temp dir INSIDE the tree (keeps config resolution
  // walking up to the project root; basename + extension preserved) and lint THAT. Identical
  // content — the overwhelming majority of commits — keeps the zero-overhead original path.
  // Temp dir lives under root and is removed after the run; per-file prefix avoids basename
  // collisions across sibling dirs. Git failures fail closed: a diff probe error is treated as
  // "differs" and the subsequent blob extraction throws (red), never silently lints worktree.
  // eol note: with core.autocrlf=true a same-content LF file can probe as "differs" (eol
  // roundtrip) — harmless, linting the index blob then is still exactly the committed truth.
  const tmpDir = join(root, '.tmp-staged-lint-' + process.pid)
  let tmpMade = false
  const lintTargets = selected.map((name, i) => {
    const rel = 'pickdone/' + name
    const probe = spawnSync('git', ['diff', '--quiet', '--', ':/' + rel], { cwd: root })
    if (!probe.error && probe.status === 0) return join(root, ...name.split('/'))
    if (!tmpMade) { fs.mkdirSync(tmpDir, { recursive: true }); tmpMade = true }
    const blob = execFileSync('git', ['-c', 'core.quotePath=false', 'show', ':0:' + rel], { cwd: root, maxBuffer: 64 * 1024 * 1024 })
    // W27 fix (2026-11-01): mirror the file's ORIGINAL relative directory under tmpDir instead
    // of flattening to `i-<basename>` at the root. Flat paths broke two things:
    //   (a) eslint resolved .eslintrc.cjs directory-level overrides from tmpDir's ancestor
    //       chain only — tests/|cli/|src/main files were linted under the browser-env root rule
    //       (fake reds on node/console globals, fake greens the other way);
    //   (b) --cache keyed entries by the flat `i-<basename>` paths, which never repeat across
    //       runs (the `i-` index depends on the staged set) — the cache never hit.
    // Mirrored `tests/unit/foo.test.mjs` keeps both config resolution and the cache key stable.
    const dest = join(tmpDir, ...name.split('/'))
    fs.mkdirSync(dirname(dest), { recursive: true })
    fs.writeFileSync(dest, blob)
    return dest
  })
  const cli = join(root, 'node_modules/eslint/bin/eslint.js')
  try {
    const result = spawnSync(process.execPath, [cli, ...lintTargets, '--quiet', '--cache'], {
      cwd: root, stdio: 'inherit', shell: false
    })
    if (result.error) throw result.error
    if (result.status !== 0) process.exitCode = result.status || 1
  } finally {
    if (tmpMade) { try { fs.rmSync(tmpDir, { recursive: true, force: true }) } catch { /* next run overwrites */ } }
  }
}
