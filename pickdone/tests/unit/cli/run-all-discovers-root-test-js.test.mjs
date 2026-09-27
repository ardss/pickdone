/* Regression (2026-09-28): tests/run-all.mjs discovered only *.test.mjs under tests/** — the
   double-extension fix ('.test.mjs' + '.test.js') was passed only to the SIBLING_DIR
   (pickdone/test/) discover() call, so the two tests/-root *.test.js specs
   (dayrail-resize-raf.test.js, depview-resize-raf.test.js) were silent orphans: never part of
   npm test, rotting undetected. Fix: the root discover() now takes both extensions via the
   shared TEST_EXTS constant (default arg + both call sites).
   Run: node --test tests/unit/cli/run-all-discovers-root-test-js.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const testsDir = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url)))) // pickdone/tests
const RUN_ALL = fs.readFileSync(path.join(testsDir, 'run-all.mjs'), 'utf8')

const TEST_EXTS = ['.test.mjs', '.test.js']
/** Mirror of run-all.mjs discover(): recursive, skips fixtures/ and dot-dirs, both extensions */
function discover(root, acc = []) {
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name)
    if (e.isDirectory()) {
      if (e.name === 'fixtures' || e.name.startsWith('.')) continue
      discover(p, acc)
    } else if (TEST_EXTS.some(x => e.name.endsWith(x)) && !e.name.startsWith('e2e')) acc.push(p)
  }
  return acc
}

test('the two tests/-root *.test.js specs exist and actually pass under node --test', async () => {
  const orphans = ['dayrail-resize-raf.test.js', 'depview-resize-raf.test.js']
  for (const name of orphans) {
    const p = path.join(testsDir, name)
    assert.ok(fs.existsSync(p), `${name} must exist at the tests/ root (this test pins its discovery)`)
  }
  // Behavioral: at least one orphan runs green standalone (pre-fix these were never executed
  // by the suite; if the file itself rots, this fails loudly rather than skipping).
  const { spawnSync } = await import('node:child_process')
  // Strip NODE_TEST_CONTEXT: when this spec itself runs under `node --test`, the env var leaks
  // into the child and node:test refuses to "run files recursively", producing empty output.
  const env = { ...process.env }
  for (const k of Object.keys(env)) if (/^NODE_TEST_CONTEXT|^TEST_/.test(k)) delete env[k]
  const r = spawnSync(process.execPath,
    ['--test', '--test-reporter=tap', path.join(testsDir, 'dayrail-resize-raf.test.js')],
    { encoding: 'utf8', env })
  const out = (r.stdout || '') + '\n' + (r.stderr || '')
  const pass = /# pass (\d+)/.exec(out)?.[1]
  const fail = /# fail (\d+)/.exec(out)?.[1]
  assert.ok(pass === '3' && fail === '0',
    `dayrail-resize-raf.test.js must report 3 pass / 0 fail, got pass=${pass} fail=${fail} status=${r.status} stderr=${r.stderr?.slice(0, 300)}`)
})

test('run-all discovery (mirrored rules incl. both extensions) covers the former orphans', () => {
  const files = discover(testsDir)
  for (const name of ['dayrail-resize-raf.test.js', 'depview-resize-raf.test.js']) {
    assert.ok(files.some(f => f.endsWith(name)),
      `${name} must be discovered by run-all's rules — an orphaned spec is a regression nobody sees`)
  }
})

test('run-all.mjs source passes TEST_EXTS to the tests/-root discover() (not just SIBLING_DIR)', () => {
  assert.match(RUN_ALL, /function discover\(root, acc = \[\], exts = TEST_EXTS\)/,
    'the default exts for the tests/ root discover() must include both .test.mjs and .test.js')
  assert.match(RUN_ALL, /discover\(dir\)\.concat\(discover\(SIBLING_DIR, \[\], TEST_EXTS\)\)/,
    'both call sites must share the TEST_EXTS constant — the original bug was the root call missing the double-extension list')
})
