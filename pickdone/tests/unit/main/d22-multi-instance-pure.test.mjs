/**
 * D22 maintenance round — multi-instance pure-function coverage (test-infra companion:
 * the journey J4 lock-loss relaunch tolerance works against this contract, so the pure
 * decision layer gets executing tests, not just source pins).
 * Run: node --test tests/unit/main/d22-multi-instance-pure.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const mi = createRequire(import.meta.url)('../../../src/main/multi-instance.js')

test('isMultiEnabled: only the exact literal "1" opts in', () => {
  assert.equal(mi.isMultiEnabled({}), false)
  assert.equal(mi.isMultiEnabled({ PICKDONE_MULTI: 'true' }), false)
  assert.equal(mi.isMultiEnabled({ PICKDONE_MULTI: '1' }), true)
})

test('dirScopeHash: deterministic 8-hex scope id, distinct per dir', () => {
  const a = mi.dirScopeHash('/tmp/alpha')
  assert.match(a, /^[0-9a-f]{8}$/)
  assert.equal(a, mi.dirScopeHash('/tmp/alpha'))
  assert.notEqual(a, mi.dirScopeHash('/tmp/beta'))
})

test('lockRequestArgs: default mode passes no additionalData, multi mode tags the scope hash', () => {
  assert.deepEqual(mi.lockRequestArgs({}, '/tmp/alpha'), [])
  const [arg] = mi.lockRequestArgs({ PICKDONE_MULTI: '1' }, '/tmp/alpha')
  assert.deepEqual(arg, { pickdoneMultiScope: mi.dirScopeHash('/tmp/alpha') })
})

test('lock loss always quits (both modes) — SQLite single-writer safety', () => {
  assert.equal(mi.shouldQuitOnLockLoss({ granted: true }), false)
  assert.equal(mi.shouldQuitOnLockLoss({ granted: false }), true)
})

test('titleSuffix: empty by default, [#hash] only in multi mode', () => {
  assert.equal(mi.titleSuffix({}, '/tmp/alpha'), '')
  assert.equal(mi.titleSuffix({ PICKDONE_MULTI: '1' }, '/tmp/alpha'), ' [#' + mi.dirScopeHash('/tmp/alpha') + ']')
})

test('lockRetryCount parses the retry flag; relaunchArgv bumps it and resolves the app path', () => {
  assert.equal(mi.lockRetryCount(['electron', '.', mi.LOCK_RETRY_FLAG + '2']), 2)
  assert.equal(mi.lockRetryCount(['electron', '.']), 0)
  // cwd must be a REAL absolute dir for the resolution assertion to mean the same thing on
  // every platform ('K:/app' is only absolute on win32).
  const cwd = os.tmpdir()
  const next = mi.relaunchArgv(['electron.exe', '.', '--remote-debugging-port=1234', mi.LOCK_RETRY_FLAG + '1'], 2, cwd)
  assert.ok(next.includes(mi.LOCK_RETRY_FLAG + '2'), 'retry counter bumped')
  assert.ok(next.includes('--remote-debugging-port=1234'), 'other argv preserved')
  assert.ok(!next.some(a => String(a).startsWith(mi.LOCK_RETRY_FLAG + '1')), 'old counter dropped')
  assert.equal(next[0], path.join(cwd, '.'), 'app path resolved against cwd (relaunch cwd-loss guard)')
})

test('shouldRelaunchOnLockLoss: multi mode below the cap only', () => {
  assert.equal(mi.shouldRelaunchOnLockLoss({}, ['e', '.']), false)
  assert.equal(mi.shouldRelaunchOnLockLoss({ PICKDONE_MULTI: '1' }, ['e', '.']), true)
  const atCap = ['e', '.', mi.LOCK_RETRY_FLAG + mi.LOCK_RETRY_MAX]
  assert.equal(mi.shouldRelaunchOnLockLoss({ PICKDONE_MULTI: '1' }, atCap), false)
})

test('preLockDelayMs: only retry launches sleep before the lock request', () => {
  assert.equal(mi.preLockDelayMs(['e', '.']), 0)
  assert.equal(mi.preLockDelayMs(['e', '.', mi.LOCK_RETRY_FLAG + '1']), mi.LOCK_RETRY_DELAY_MS)
})

test('lockfileHolderPid reads the trailing pid out of a lockfile blob; pidAlive rejects dead pids', async () => {
  assert.equal(mi.lockfileHolderPid('pid C:\\Users\\u\\app-1337'), 1337, 'trailing -<pid> token')
  assert.equal(mi.lockfileHolderPid('no pid here'), null)
  // A reaped child's pid is guaranteed free — kill(-1,0) is "every process" on POSIX, so a
  // negative pid is NOT a portable not-alive probe.
  const dead = spawn(process.execPath, ['-e', 'process.exit(0)'])
  await new Promise(resolve => dead.on('exit', resolve))
  assert.equal(mi.pidAlive(dead.pid), false, 'reaped pid is not alive')
  assert.equal(mi.pidAlive(process.pid), true, 'own pid is alive')
})
