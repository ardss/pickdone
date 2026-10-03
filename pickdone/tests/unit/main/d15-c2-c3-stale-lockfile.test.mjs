/* D15 C2 + C3 regression — stale singleton lockfile handling in multi mode.
 *   C2 (P1): the old unlink-probe loop relied on "a live holder keeps its lockfile
 *   undeletable" — true ONLY on Windows. On POSIX unlink() succeeds on a LIVE holder's open
 *   lockfile, so the loop deleted it and two instances could run one data dir (SQLite
 *   double-writer corruption). POSIX now proves staleness from the lockfile content's holder
 *   pid (Chromium writes 'hostname-pid') and never unlinks a proven-live holder.
 *   C3 (P2): the Windows wait was up to 20s of synchronous main-thread stall pre-window with
 *   no log; it is now bounded at 8s and logs at wait start.
 * Run: node --test tests/unit/main/d15-c2-c3-stale-lockfile.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const mi = require('../../../src/main/multi-instance')

function tmpDir (label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd15-' + label + '-'))
  return dir
}

test('C2: lockfileHolderPid parses Chromium hostname-pid content', () => {
  assert.equal(mi.lockfileHolderPid('somehost-12345'), 12345)
  assert.equal(mi.lockfileHolderPid('somehost-12345\n'), 12345)
  assert.equal(mi.lockfileHolderPid(''), null)
  assert.equal(mi.lockfileHolderPid('junk-without-pid'), null)
})

test('C2 (POSIX): a lockfile held by a LIVE pid is never unlinked — reported as liveHolder', () => {
  const ud = tmpDir('c2-live')
  const lockPath = path.join(ud, 'lockfile')
  fs.writeFileSync(lockPath, 'thishost-' + process.pid) // provably alive pid
  try {
    const res = mi.clearStaleSingletonLockFileSync(ud, { platform: 'linux', maxWaitMs: 1000, pollMs: 100 })
    assert.equal(res.cleared, false, 'a live holder must never be unlinked (red before the fix: unlink-loop deleted a live lockfile)')
    assert.equal(res.liveHolder, true, 'surface WHY: proven live holder')
    assert.equal(fs.existsSync(lockPath), true, 'the live holder\'s lockfile still exists')
  } finally { fs.rmSync(ud, { recursive: true, force: true }) }
})

test('C2 (POSIX): a lockfile whose holder pid is dead IS cleared as stale', () => {
  const ud = tmpDir('c2-dead')
  const lockPath = path.join(ud, 'lockfile')
  // a pid that cannot exist (overflow) — dead per the signal-0 probe
  fs.writeFileSync(lockPath, 'thishost-999999999')
  try {
    const res = mi.clearStaleSingletonLockFileSync(ud, { platform: 'linux', maxWaitMs: 1000, pollMs: 100 })
    assert.equal(res.cleared, true, 'dead holder = proven stale')
    assert.equal(fs.existsSync(lockPath), false)
  } finally { fs.rmSync(ud, { recursive: true, force: true }) }
})

test('C2 (POSIX): a lockfile with NO parseable pid is a leftover, cleared', () => {
  const ud = tmpDir('c2-junk')
  const lockPath = path.join(ud, 'lockfile')
  fs.writeFileSync(lockPath, 'junk')
  try {
    const res = mi.clearStaleSingletonLockFileSync(ud, { platform: 'linux', maxWaitMs: 1000, pollMs: 100 })
    assert.equal(res.cleared, true)
    assert.equal(fs.existsSync(lockPath), false)
  } finally { fs.rmSync(ud, { recursive: true, force: true }) }
})

test('C2 (POSIX): a missing lockfile reports cleared immediately', () => {
  const ud = tmpDir('c2-none')
  try {
    const res = mi.clearStaleSingletonLockFileSync(ud, { platform: 'linux', maxWaitMs: 1000, pollMs: 100 })
    assert.deepEqual(res, { cleared: true, waitedMs: 0 })
  } finally { fs.rmSync(ud, { recursive: true, force: true }) }
})

test('C3: the Windows stale-wait bound is no longer 20s (main-thread stall) and logs at start', () => {
  assert.ok(mi.STALE_LOCKFILE_MAX_WAIT_MS <= 10_000, 'red before the fix: 20s of synchronous pre-window stall')
  const ud = tmpDir('c3-log')
  const lockPath = path.join(ud, 'lockfile')
  fs.writeFileSync(lockPath, 'held')
  const orig = fs.unlinkSync
  let warned = ''
  const origWarn = console.warn
  console.warn = (...a) => { warned += a.join(' ') }
  // keep the file "held" (EBUSY) so the wait loop actually engages, with a short budget
  fs.unlinkSync = () => { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e }
  try {
    // Pin the Windows branch explicitly (the subject of this test): on POSIX the function
    // proves staleness from the holder pid and never enters the unlink-probe wait loop.
    const res = mi.clearStaleSingletonLockFileSync(ud, { platform: 'win32', maxWaitMs: 200, pollMs: 50 })
    assert.equal(res.cleared, false)
    assert.match(warned, /waiting out a possibly-stale singleton lockfile/, 'the stall must be attributable (logged before waiting)')
  } finally {
    fs.unlinkSync = orig
    console.warn = origWarn
    fs.rmSync(ud, { recursive: true, force: true })
  }
})
