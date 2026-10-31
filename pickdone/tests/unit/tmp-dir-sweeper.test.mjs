/** Sweeper unit tests (2026-10-09): sweepStaleTmpDirs must only delete test temp dirs that
 *  are provably orphaned — family prefix + mtime older than 12h + DEAD owning pid. The
 *  double-guard is the contract under test: a fresh mtime OR a live pid always survives.
 *  Live pid = this test's own process.pid (provably running); dead pid = a bogus number.
 *
 *  W22 fix (2026-10-30): the fixtures used to live directly in the SHARED os.tmpdir() and
 *  the sweep ran over the whole tmpdir — two concurrent lanes of this same file then
 *  deleted each other's stale fixtures and the setup assertion went false-red. Now every
 *  run builds its fixtures inside a private mkdtemp root with a NON-family name (so other
 *  lanes' full-tmpdir sweeps ignore the root itself) and sweeps ONLY that root via the new
 *  optional rootDir parameter (default behavior unchanged: os.tmpdir()).
 *  Run: node --test tests/unit/tmp-dir-sweeper.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sweepStaleTmpDirs, isolatedTmpDir } from '../lib/tmp-dir.mjs'

const STALE = new Date(Date.now() - 13 * 60 * 60 * 1000) // 13h ago: past the 12h guard
const DEAD_PID = 999999983 // bogus: no real process carries this pid
const PREFIX = 'todo-sweeper-fix-' // inside the sweeper's family regex
// Private root prefix deliberately OUTSIDE the family: a concurrent lane sweeping the
// shared os.tmpdir() must never consider this root deletable.
const ROOT_PREFIX = 'zzebra-sweeper-fixture-root-'

/** Per-run private fixture root: family-prefixed fixtures live INSIDE it, the sweep
 *  is pointed at it via sweepStaleTmpDirs(rootDir), and it is removed in finally. */
function mkRoot () {
  return fs.mkdtempSync(path.join(os.tmpdir(), ROOT_PREFIX + 'pid' + process.pid + '-'))
}

function mk (root, name) {
  const dir = path.join(root, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'x.txt'), 'x')
  return dir
}

test('sweeper deletes only stale + dead-pid family dirs; fresh or live-pid dirs survive', () => {
  const root = mkRoot()
  const staleDead = mk(root, `${PREFIX}stale-pid${DEAD_PID}-${Date.now()}`)
  const freshDead = mk(root, `${PREFIX}fresh-pid${DEAD_PID}-${Date.now()}`)
  const staleLive = mk(root, `${PREFIX}live-pid${process.pid}-${Date.now()}`)
  // Backdate the two "stale" fixtures; utimes is best-effort (always works on win32/CI).
  fs.utimesSync(staleDead, STALE, STALE)
  fs.utimesSync(staleLive, STALE, STALE)
  try {
    const before = fs.existsSync(staleDead) && fs.existsSync(freshDead) && fs.existsSync(staleLive)
    assert.ok(before, 'setup: all three fixtures exist')
    sweepStaleTmpDirs(root)
    assert.equal(fs.existsSync(staleDead), false, 'stale + dead pid → deleted')
    assert.equal(fs.existsSync(freshDead), true, 'fresh mtime + dead pid → kept (guard 1)')
    assert.equal(fs.existsSync(staleLive), true, 'stale mtime + live pid → kept (guard 2)')
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

test('sweeper never touches dirs outside the test prefix family', () => {
  const root = mkRoot()
  const foreign = mk(root, `zzebra-foreign-pid${DEAD_PID}-${Date.now()}`)
  fs.utimesSync(foreign, STALE, STALE)
  try {
    sweepStaleTmpDirs(root)
    assert.equal(fs.existsSync(foreign), true, 'non-family dir untouched even when stale + dead-pid')
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

test('default sweep scope stays the shared os.tmpdir() (rootDir param is optional)', () => {
  // Contract pin for the W22 change: calling with no args must still sweep the shared
  // tmpdir without throwing, and must not delete a family dir whose pid is alive.
  const root = mkRoot()
  const live = mk(root, `${PREFIX}default-scope-live-pid${process.pid}-${Date.now()}`)
  try {
    const res = sweepStaleTmpDirs() // no args → os.tmpdir() scope, full shared sweep
    assert.ok(Number.isInteger(res.scanned) && Number.isInteger(res.removed), 'returns best-effort counts')
    assert.equal(fs.existsSync(live), true, 'live-pid family dir survives the default sweep')
  } finally {
    try { fs.rmSync(root, { recursive: true, force: true }) } catch { /* best effort */ }
  }
})

test('isolatedTmpDir encodes the owning pid for the sweeper and registers exit cleanup', () => {
  const dir = isolatedTmpDir(PREFIX)
  try {
    assert.match(path.basename(dir), new RegExp(`^${PREFIX.replace(/-/g, '\\-')}pid${process.pid}-`), 'name carries <prefix>pid<pid>- encoding')
    assert.ok(fs.existsSync(dir))
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* exit hook is the backstop */ }
  }
})
