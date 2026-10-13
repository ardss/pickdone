// Run the project's existing ESLint on staged source changes only.
// Shell-free Git and Node calls work when this repository is opened via UNC.
// Full-tree lint remains part of check:all; pre-commit checks only this commit.
import { execFileSync, spawnSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const staged = execFileSync('git', [
  'diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'
], { cwd: root }).toString('utf8').split('\0').filter(Boolean)
const selected = staged
  .filter(name => name.startsWith('pickdone/'))
  .map(name => name.slice('pickdone/'.length))
  .filter(name => /^(renderer\/js|cli|src|tests)\//.test(name))
  .filter(name => /\.(?:js|cjs|mjs|vue)$/.test(name))
if (selected.length === 0) {
  console.log('[pre-commit] ESLint: no staged source changes in lint scope')
} else {
  const cli = join(root, 'node_modules/eslint/bin/eslint.js')
  const result = spawnSync(process.execPath, [cli, ...selected, '--quiet', '--cache'], {
    cwd: root, stdio: 'inherit', shell: false
  })
  if (result.error) throw result.error
  if (result.status !== 0) process.exitCode = result.status || 1
}
