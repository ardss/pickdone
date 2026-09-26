/**
 * R3-stability / U-12 (2026-09-26): a safeStorage decrypt failure used to downgrade verifyLockPassword
 * to "no password set" (expected='') so ANY input unlocked the app after a DPAPI reset / profile
 * migration, while enableSecurityLock stayed true — a silent fail-open. Now the verify FAILS and the
 * existing lockLoadFailedFallback runs (lock disabled + password cleared atomically + main window
 * restored): the user re-sets a password instead of the lock silently opening for arbitrary input.
 * SEMANTIC CHANGE vs the 2026-09-10 P1 fail-open — flagged to the orchestrator per wave rules.
 * Isolation: electron stubbed via Module._load (decryptString controllable); fresh temp
 * TODO_USER_DATA_DIR; no real %APPDATA%/pickdone and no Electron process.
 * Run: node --test test/security-lock-decrypt-fail.test.js
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('path')
const fs = require('fs')
const os = require('os')

process.env.TODO_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'seclock-ud-'))

let decryptImpl = () => { throw new Error('DPAPI reset: key not recoverable') }
const electronStub = {
  BrowserWindow: function () {},
  safeStorage: {
    decryptString: buf => decryptImpl(buf),
    encryptString: plain => Buffer.from('enc-sim')
  }
}
const Module = require('module')
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub
  return origLoad.call(this, request, parent, isMain)
}

const ROOT = path.resolve(__dirname, '..')
const { createSecurityLock } = require(path.join(ROOT, 'src/main/security-lock.js'))

function makeLock (stored) {
  const calls = { writes: [], showMainOrLock: 0 }
  // Stateful config (as the real store): writeConfig lands, so a second verify after the fallback
  // sees the cleared password — proving the fallback is effectively one-shot in production.
  let cfg = { enableSecurityLock: true, securityLockPassword: stored }
  const lock = createSecurityLock({
    getMainWindow: () => null,
    showMainOrLock: () => { calls.showMainOrLock++ },
    readConfig: () => cfg,
    writeConfig: patch => { calls.writes.push(patch); cfg = Object.assign({}, cfg, patch) },
    i18n: { mt: k => k },
    log: { info () {}, warn () {}, error () {} }
  })
  return { lock, calls }
}

test('U-12: decrypt failure no longer unlocks for arbitrary input — verify returns false and the disable-lock fallback runs', () => {
  decryptImpl = () => { throw new Error('DPAPI reset') }
  const { lock, calls } = makeLock('enc1:QUJD')
  assert.equal(lock.verifyLockPassword('anything'), false, 'arbitrary input must NOT unlock on an undecryptable blob')
  // By now the fallback has wiped the password, so the next verify takes the unchanged
  // no-password unlock path — that is the explicit one-time reset, not a bypass of an enabled lock.
  assert.equal(calls.writes.length, 1, 'fallback fired exactly once')
  assert.equal(calls.writes[0].enableSecurityLock, false, 'lock disabled — explicit one-time reset, not a silent bypass')
  assert.equal(calls.writes[0].securityLockPassword, '', 'password cleared: re-set required')
  assert.ok(calls.showMainOrLock >= 1, 'main window restored — availability preserved via reset')
})

test('U-12 control: a decryptable enc1 password still verifies correctly (no regression on the happy path)', () => {
  decryptImpl = buf => buf.toString('utf8')
  const { lock, calls } = makeLock('enc1:' + Buffer.from('secret-pw', 'utf8').toString('base64'))
  assert.equal(lock.verifyLockPassword('secret-pw'), true, 'correct input still unlocks')
  assert.equal(lock.verifyLockPassword('wrong'), false, 'wrong input still rejects')
  assert.equal(calls.writes.length, 0, 'no fallback on a healthy blob')
})

test('U-12 control: plain: storage and the no-password unlock path are unchanged', () => {
  decryptImpl = () => { throw new Error('must not be called') }
  assert.equal(makeLock('plain:hello').lock.verifyLockPassword('hello'), true)
  assert.equal(makeLock('plain:hello').lock.verifyLockPassword('nope'), false)
  assert.equal(makeLock('').lock.verifyLockPassword('anything'), true, 'no password ever set: any input unlocks (unchanged)')
})
