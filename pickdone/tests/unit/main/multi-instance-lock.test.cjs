'use strict'
// Multi-instance opt-in decision unit (src/main/multi-instance.js) — plain module, no Electron.
const { test } = require('node:test')
const assert = require('node:assert/strict')
const {
  isMultiEnabled, dirScopeHash, lockRequestArgs, shouldQuitOnLockLoss, titleSuffix,
  lockRetryCount, relaunchArgv, shouldRelaunchOnLockLoss, preLockDelayMs,
  clearStaleSingletonLockFileSync,
  LOCK_RETRY_FLAG, LOCK_RETRY_MAX, LOCK_RETRY_DELAY_MS
} = require('../../../src/main/multi-instance')

test('default mode (no env) is byte-identical to the historical global lock call', () => {
  assert.equal(isMultiEnabled({}), false)
  assert.equal(isMultiEnabled(undefined), false)
  assert.deepEqual(lockRequestArgs({}, 'K:/any/dir'), [])
  // no arguments -> the historical app.requestSingleInstanceLock() call shape
  assert.equal(shouldQuitOnLockLoss({ granted: false }), true)
  assert.equal(titleSuffix({}, 'K:/any/dir'), '')
})

test('PICKDONE_MULTI=1 opts in; other values do not', () => {
  assert.equal(isMultiEnabled({ PICKDONE_MULTI: '1' }), true)
  for (const v of ['0', 'true', '', 'yes', 1]) assert.equal(isMultiEnabled({ PICKDONE_MULTI: v }), false)
})

test('scoped lock tags the lock holder with the data-dir hash', () => {
  const args = lockRequestArgs({ PICKDONE_MULTI: '1' }, 'K:/tmp/duo-a')
  assert.equal(args.length, 1)
  assert.equal(args[0].pickdoneMultiScope, dirScopeHash('K:/tmp/duo-a'))
  assert.match(args[0].pickdoneMultiScope, /^[0-9a-f]{8}$/)
  // different dirs -> different scopes (the whole point)
  assert.notEqual(dirScopeHash('K:/tmp/duo-a'), dirScopeHash('K:/tmp/duo-b'))
  // stable across restarts (same dir -> same scope)
  assert.equal(dirScopeHash('K:/tmp/duo-a'), dirScopeHash('K:/tmp/duo-a'))
})

test('a lost lock still quits in multi mode: it means a same-dir duplicate', () => {
  assert.equal(shouldQuitOnLockLoss({ granted: true }), false)
  assert.equal(shouldQuitOnLockLoss({ granted: false }), true)
})

test('title suffix extends the [TEST] badge path only in multi mode', () => {
  const dir = 'K:/tmp/duo-b'
  assert.equal(titleSuffix({ PICKDONE_MULTI: '1' }, dir), ' [#' + dirScopeHash(dir) + ']')
  assert.equal(titleSuffix({}, dir), '')
})

// --- bounded relaunch-on-lock-loss (regression: crash-restart silently no-ops) ---
// Electron caches a failed requestSingleInstanceLock, so a stale holder right after a
// hard kill made the next launch quit cleanly with no logs. Multi mode relaunches a
// bounded number of times instead.

test('lock retry count parses the argv flag and defaults to 0', () => {
  assert.equal(lockRetryCount(['electron.exe', '.', '--remote-debugging-port=1234']), 0)
  assert.equal(lockRetryCount(['electron.exe', '.', LOCK_RETRY_FLAG + '3']), 3)
  assert.equal(lockRetryCount(['electron.exe', '.', LOCK_RETRY_FLAG + 'junk']), 0)
  assert.equal(lockRetryCount(['electron.exe', '.', LOCK_RETRY_FLAG + '-1']), 0)
  assert.equal(lockRetryCount(undefined), 0)
})

test('relaunch argv drops the electron exe, strips stale retry flags, appends the bumped count', () => {
  const argv = ['electron.exe', '.', '--remote-debugging-port=1234']
  assert.deepEqual(relaunchArgv(argv, 1), ['.', '--remote-debugging-port=1234', LOCK_RETRY_FLAG + '1'])
  // a retry launch re-bumps from its own argv without accumulating flags
  const retryArgv = ['electron.exe', '.', LOCK_RETRY_FLAG + '1']
  assert.deepEqual(relaunchArgv(retryArgv, 2), ['.', LOCK_RETRY_FLAG + '2'])
  assert.equal(relaunchArgv(retryArgv, 2).filter(a => String(a).startsWith(LOCK_RETRY_FLAG)).length, 1)
})

test('relaunch on lock loss is multi-mode only and bounded', () => {
  // default mode: historical instant quit, never relaunch
  assert.equal(shouldRelaunchOnLockLoss({}, ['electron.exe', '.']), false)
  assert.equal(shouldRelaunchOnLockLoss(undefined, ['electron.exe', '.']), false)
  // multi mode: relaunch while below the cap
  assert.equal(shouldRelaunchOnLockLoss({ PICKDONE_MULTI: '1' }, ['electron.exe', '.']), true)
  assert.equal(
    shouldRelaunchOnLockLoss({ PICKDONE_MULTI: '1' }, ['electron.exe', '.', LOCK_RETRY_FLAG + (LOCK_RETRY_MAX - 1)]),
    true)
  // at the cap: give up (a real duplicate must terminate, not loop)
  assert.equal(
    shouldRelaunchOnLockLoss({ PICKDONE_MULTI: '1' }, ['electron.exe', '.', LOCK_RETRY_FLAG + LOCK_RETRY_MAX]),
    false)
})

test('pre-lock delay applies only to retry launches', () => {
  assert.equal(preLockDelayMs(['electron.exe', '.']), 0)
  assert.equal(preLockDelayMs(['electron.exe', '.', LOCK_RETRY_FLAG + '1']), LOCK_RETRY_DELAY_MS)
  assert.equal(LOCK_RETRY_DELAY_MS > 0, true)
  assert.equal(LOCK_RETRY_MAX >= 1, true)
})

// --- stale singleton lockfile clear (regression: crash-restart silently no-ops) ---
// After a hard kill the dead instance's crashpad handler holds <userData>/lockfile
// ~10s; Chromium then fails the lock ("Lock file can not be created! code 32") and the
// relaunch used to quit with no window and no log.

test('stale lockfile clear: no file reports cleared immediately', () => {
  const { execSync } = require('node:child_process')
  const dir = execSync('powershell -NoProfile -Command "[System.IO.Path]::GetRandomFileName()"', { encoding: 'utf8' }).trim()
  const os = require('node:os')
  const path = require('node:path')
  const fs = require('node:fs')
  const ud = path.join(os.tmpdir(), 'mi-lock-none-' + dir)
  fs.mkdirSync(ud, { recursive: true })
  try {
    const res = clearStaleSingletonLockFileSync(ud, { maxWaitMs: 1000, pollMs: 100 })
    assert.deepEqual(res, { cleared: true, waitedMs: 0 })
  } finally { fs.rmSync(ud, { recursive: true, force: true }) }
})

test('stale lockfile clear: an unreferenced stale file is removed', () => {
  const { execSync } = require('node:child_process')
  const nonce = execSync('powershell -NoProfile -Command "[System.IO.Path]::GetRandomFileName()"', { encoding: 'utf8' }).trim()
  const os = require('node:os')
  const path = require('node:path')
  const fs = require('node:fs')
  const ud = path.join(os.tmpdir(), 'mi-lock-stale-' + nonce)
  fs.mkdirSync(ud, { recursive: true })
  fs.writeFileSync(path.join(ud, 'lockfile'), 'gone-host-1234')
  try {
    const res = clearStaleSingletonLockFileSync(ud, { maxWaitMs: 2000, pollMs: 100 })
    assert.equal(res.cleared, true)
    assert.equal(fs.existsSync(path.join(ud, 'lockfile')), false)
  } finally { fs.rmSync(ud, { recursive: true, force: true }) }
})
