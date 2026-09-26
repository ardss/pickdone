/* round3-stability-finding-1 (2026-09-26): a corrupt config.json used to be quarantined to
 * config.json.bad FULLY SILENTLY — the security lock stayed off and user settings reset for
 * the session with no notice anywhere (only the FAILED rename path logged). config-store now
 * raises a consume-once quarantine notice on the successful-quarantine path; index.js consumes
 * it at startup to surface a user-visible notification. Fail-open semantics are unchanged:
 * this test also pins that a quarantined config still yields defaults (enableSecurityLock
 * absent — the pre-existing behavior a notice must not alter).
 * Plain Node, temp dir via __setConfigDir — the real %APPDATA% is never touched.
 * Run directly: node --test test/quarantine-notice.test.js */
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

function freshStore () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-quarantine-'))
  // Fresh module instance per case (the flag is module state); config-store is plain-node safe.
  delete require.cache[require.resolve('../pickdone/src/main/config-store.js')]
  const store = require('../pickdone/src/main/config-store.js')
  store.__setConfigDir(dir)
  return { store, dir }
}

test('corrupt config raises the quarantine notice exactly once (read-and-clear)', () => {
  const { store, dir } = freshStore()
  // A previously-locked config truncates (the corrupted-write shape from the finding)
  fs.writeFileSync(path.join(dir, 'config.json'), '{"enableSecurityLock":true,"locale":"zh","bro')
  const c = store.readConfig()
  assert.equal(store.consumeQuarantineNotice(), true,
    'THE FIX: a successful quarantine raises the user-visible notice flag')
  assert.equal(store.consumeQuarantineNotice(), false, 'the notice is consume-once')
  assert.equal(c.enableSecurityLock, undefined,
    'fail-open preserved: quarantined config yields defaults (lock off) — notice-only fix')
  assert.ok(fs.existsSync(path.join(dir, 'config.json.bad')),
    'precondition: evidence preserved in config.json.bad')
})

test('healthy config does NOT raise the notice', () => {
  const { store } = freshStore()
  // (no file at all = first install, must stay silent too)
  store.readConfig()
  assert.equal(store.consumeQuarantineNotice(), false, 'missing file: first-install silence kept')
})

test('failed quarantine (rename blocked) still gates writes via isReadFailed and raises no false notice', () => {
  const { store, dir } = freshStore()
  fs.writeFileSync(path.join(dir, 'config.json'), '{broken')
  // Occupy the .bad target: renameSync fails -> the write gate must engage (pre-existing P2 behavior)
  fs.mkdirSync(path.join(dir, 'config.json.bad'))
  store.readConfig()
  assert.equal(store.isReadFailed(), true, 'pre-existing write gate still engages when rename fails')
  assert.equal(store.consumeQuarantineNotice(), false, 'no quarantine notice when quarantine itself failed')
})
