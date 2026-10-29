import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// W16-SCOPE-ARGV-P1 regressions (parameter-mode confusion fix):
// check-test-scope.cjs used to read process.argv in `stagedFiles()`, so when imported by
// check-test-summary.cjs (--core --affected --retry-once) the caller's FLAGS were swallowed
// as staged "filenames" → "unmapped surface: --core" → every scoped run degraded to full.
// Contract after fix: in-process import = git staged set ONLY (never argv); argv-as-staged
// is accepted ONLY in the require.main path with flag-like tokens filtered.

const require_ = createRequire(import.meta.url)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const { scopeFor, stagedFilesFromArgv, stagedFiles } = require_(path.join(HERE, '../../../cli/check-test-scope.cjs'))

test('T1a scoped positive: explicit staged list maps a real surface to its test dirs', () => {
  const v = scopeFor(['pickdone/src/main/lan-sync/transport.js'])
  assert.equal(v.verdict, 'scoped')
  assert.deepEqual(v.dirs, ['tests/unit/lan-sync', 'tests/unit/main'])
})

test('T1b scoped positive: a staged unit test file maps to its own dir', () => {
  const v = scopeFor(['pickdone/tests/unit/cli/c1-parse-ux.test.mjs'])
  assert.equal(v.verdict, 'scoped')
  assert.deepEqual(v.dirs, ['tests/unit/cli'])
})

test('T2a fail-wide preserved: unknown surface still degrades to full', () => {
  // v2 fixture fix (GPT 14:38): the old path renderer/js/… actually matches the generic
  // `renderer/js` SURFACE_MAP entry (scoped is CORRECT there — production code right);
  // a true unknown top-dir is required to exercise the unmapped fail-wide branch.
  const v = scopeFor(['pickdone/unknown-zone/foo.js'])
  assert.equal(v.verdict, 'full')
  assert.match(v.reason, /unmapped surface/)
})

test('T2b REGRESSION (the W16 bug): caller flags are never staged filenames', () => {
  // The exact shape check-test-summary.cjs used to leak in (summary L123-125 → scopeFor()
  // → stagedFiles() → process.argv.slice(2)):
  const flags = ['--core', '--affected', '--retry-once']
  // 1) the CLI-argv extractor filters flag-like tokens unconditionally
  assert.deepEqual(stagedFilesFromArgv(flags), [])
  assert.deepEqual(stagedFilesFromArgv(['qa/ok.js', '--retry-once']), ['qa/ok.js'])
  // 2) handing flags to scopeFor cannot produce a narrow (scoped/skip) verdict — fail-wide
  const v = scopeFor(flags)
  assert.equal(v.verdict, 'full')
})

test('T2c REGRESSION invariant: in-process stagedFiles() must not read process.argv', () => {
  // Pin the fix structurally: the in-process stagedFiles body contains no argv access.
  // (execFileSync('git', …) remains the only staged source on this path.)
  const src = stagedFiles.toString()
  assert.ok(!src.includes('process.argv'), 'stagedFiles() must not read process.argv (W16 regression)')
  assert.ok(src.includes('stagedFilesFromGit'), 'stagedFiles() must delegate to the git-only source')
})
