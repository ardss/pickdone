// Run the project's existing ESLint on staged source changes only.
// Shell-free Git and Node calls work when this repository is opened via UNC.
// Full-tree lint remains part of check:all; pre-commit checks only this commit.
import { execFileSync, spawnSync } from 'node:child_process'
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
const staged = execFileSync('git', [
  '-c', 'core.quotePath=false',
  'diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'
], { cwd: root }).toString('utf8').split('\0').filter(Boolean)
const selected = staged
  .filter(name => name.startsWith('pickdone/'))
  .map(name => name.slice('pickdone/'.length))
  .filter(name => /^(renderer\/js|cli|src|tests)\//.test(name))
  .filter(name => /\.(?:js|cjs|mjs|vue)$/.test(name))
if (selected.length === 0) {
  // [fail-closed 2026-10-26, mirrors pre-commit stage-1 guard in 021f905b]: a staged file
  // that satisfies the scope+extension contract only via the OPTIONAL pickdone/ prefix
  // means real in-scope source is staged but the prefix-strip/scope normalization selected
  // none of it — historically this path exited 0 green for the gate's whole life
  // (same shape as the check-file-size --staged zero-file no-op). Refuse loudly.
  const inScopeUnselected = staged.filter(name =>
    /^(?:pickdone\/)?(?:renderer\/js|cli|src|tests)\//.test(name) &&
    /\.(?:js|cjs|mjs|vue)$/.test(name))
  if (inScopeUnselected.length > 0) {
    console.error(`✗ [pre-commit] ESLint breaker: ${inScopeUnselected.length} staged in-scope source file(s) exist but 0 survived prefix/scope normalization (path normalization failure) — refusing fake green`)
    for (const n of inScopeUnselected.slice(0, 20)) console.error('  ' + n)
    process.exit(1)
  }
  console.log('[pre-commit] ESLint: no staged source changes in lint scope')
} else {
  const cli = join(root, 'node_modules/eslint/bin/eslint.js')
  const result = spawnSync(process.execPath, [cli, ...selected, '--quiet', '--cache'], {
    cwd: root, stdio: 'inherit', shell: false
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exitCode = result.status || 1
}
