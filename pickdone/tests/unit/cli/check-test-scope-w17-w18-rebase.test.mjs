/**
 * W16-SCOPE-W17-W18-REBASE-ISOLATED — anti-regression narrow tests for the REBASED
 * check-test-scope module (payload: cli/check-test-scope.rebased.cjs).
 *
 * Locked semantics (each maps to a real incident class):
 *  - W17 (ACMR): a staged set containing a RENAMED code file plus docs must NOT degrade to
 *    the docs-only "skip" verdict — the rename (R) keeps the code entry in the staged set.
 *  - W18 (quotePath=false): a true non-ASCII docs path must reach DOCS_ONLY as real UTF-8
 *    (→ "skip"); the octal-escaped git form must NOT match the whitelist (→ fail-wide "full"),
 *    which is exactly why the git call pins -c core.quotePath=false.
 *  - W16 separation: the in-process stagedFiles() never reads process.argv; the require.main
 *    path filters flag-like tokens and keeps positionals; stagedFilesFromGit() keeps BOTH the
 *    W17 (--diff-filter=ACMR) and W18 (-c core.quotePath=false) pins (source anchors — the
 *    repo's established source-lock pattern).
 * Run: node --test tests/unit/cli/check-test-scope-w17-w18-rebase.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const scope = require('../../../cli/check-test-scope.cjs')

test('W17 lock: renamed code file + docs stays scoped, never docs-only skip', () => {
  const res = scope.scopeFor(['src/main/lan-sync/transport.js', 'docs/notes.md'])
  assert.equal(res.verdict, 'scoped')
  assert.deepEqual(res.dirs, ['tests/unit/lan-sync', 'tests/unit/main'])
})

test('W18 lock A: true non-ASCII docs path matches DOCS_ONLY → skip', () => {
  const res = scope.scopeFor(['docs/界面指南.md'])
  assert.equal(res.verdict, 'skip')
})

test('W18 lock B: octal-escaped non-ASCII path does NOT match DOCS_ONLY → fail-wide full', () => {
  const res = scope.scopeFor(['"\\347\\225\\214\\351\\235\\242\\346\\214\\207\\345\\215\\227.md"'])
  assert.equal(res.verdict, 'full')
})

test('W16 lock: in-process stagedFiles() never reads process.argv (source anchor)', () => {
  assert.ok(!scope.stagedFiles.toString().includes('process.argv'),
    'stagedFiles() must not read process.argv — the importing process owns argv')
})

test('W16 lock: require.main argv path filters flags, keeps positionals', () => {
  assert.deepEqual(scope.stagedFilesFromArgv(['--core', '--affected', '--retry-once']), [])
  assert.deepEqual(scope.stagedFilesFromArgv(['src/main/index.js', '--core']), ['src/main/index.js'])
  assert.deepEqual(scope.stagedFilesFromArgv([]), [])
})

test('rebase pins: stagedFilesFromGit() keeps W17 ACMR AND W18 quotePath (source anchors)', () => {
  const src = scope.stagedFilesFromGit.toString()
  assert.ok(src.includes('--diff-filter=ACMR'), 'W17 ACMR pin missing — rename fix would regress')
  assert.ok(src.includes('core.quotePath=false'), 'W18 quotePath pin missing — non-ASCII fix would regress')
})
