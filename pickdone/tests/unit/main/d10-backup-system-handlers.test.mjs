/** D10 (2026-09-27) handler fixes:
 *  - read-critical-state-backup: EACCES/EBUSY on an EXISTING critical backup must surface as a
 *    thrown read error, not be reported as "no backup exists" (null). Only ENOENT returns null.
 *  - open-external-url: honest result — unsafe scheme throws, opened URL returns true (was
 *    undefined on every path, so "opened" and "rejected by the scheme guard" were indistinguishable).
 * Run: node --test tests/unit/main/d10-backup-system-handlers.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Module = require('module')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'd10-handlers-'))
// electron is a path string under plain node, and electron-updater reads require('electron').app at
// REQUIRE time (system.js → ../updater → electron-updater) — the stub must be installed before the
// handler modules load, for the whole file. The shell spy is swapped per test via SHELL_SPY.
let SHELL_SPY = { opened: [] }
const ELECTRON_STUB = {
  app: { getPath: () => TMP, getVersion: () => '0.0.0-test' },
  Notification: class { show () {} },
  shell: {
    openExternal: u => SHELL_SPY.opened.push(u),
    openPath: async () => ''
  }
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  if (request === 'electron-updater') return { autoUpdater: { on: () => {}, checkForUpdates: async () => {}, downloadUpdate: async () => {}, quitAndInstall: () => {}, isUpdaterActive: () => false } }
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const backupHandlers = require('../../../src/main/handlers/backup.js')
const systemHandlers = require('../../../src/main/handlers/system.js')

const MAIN_WC = { id: 'main-wc' }
const eMain = { sender: MAIN_WC }
const noop = () => {}
const ctxBase = {
  isLocked: () => false,
  app: { getPath: () => TMP },
  getMainWindow: () => ({ webContents: MAIN_WC, isDestroyed: () => false }),
  isSafeExternal: url => typeof url === 'string' && /^https?:\/\//i.test(url),
  allowWithinRate: () => true,
  i18n: { mt: k => k },
  log: { warn: noop, error: noop, info: noop }
}

test('d10: read-critical-state-backup — ENOENT returns null, EACCES throws a read error', () => {
  const handlers = backupHandlers(ctxBase)
  const origRead = fs.readFileSync
  // missing file → null (normal empty state, unchanged)
  const missingErr = new Error('nope'); missingErr.code = 'ENOENT'
  fs.readFileSync = () => { throw missingErr }
  try { assert.equal(handlers['read-critical-state-backup'](eMain), null) } finally { fs.readFileSync = origRead }
  // locked/AV-blocked EXISTING backup → must THROW, never masquerade as "no backup"
  const eacces = new Error('EACCES: permission denied'); eacces.code = 'EACCES'
  fs.readFileSync = () => { throw eacces }
  try {
    assert.throws(() => handlers['read-critical-state-backup'](eMain), /unreadable/,
      'red before the fix: blanket catch returned null for a real disaster-recovery asset')
  } finally { fs.readFileSync = origRead }
})

test('d10: open-external-url — unsafe scheme throws, https returns true and opens', () => {
  SHELL_SPY = { opened: [] }
  const handlers = systemHandlers({ ...ctxBase })
  assert.throws(() => handlers['open-external-url'](eMain, 'javascript:alert(1)'), /unsafe external url/,
    'red before the fix: unsafe scheme silently returned undefined')
  assert.throws(() => handlers['open-external-url'](eMain, undefined), /unsafe external url/)
  assert.equal(SHELL_SPY.opened.length, 0, 'unsafe scheme never reaches the OS shell')
  const r = handlers['open-external-url'](eMain, 'https://example.com/release-notes')
  assert.equal(r, true, 'opened URL returns an honest true (was undefined)')
  assert.deepEqual(SHELL_SPY.opened, ['https://example.com/release-notes'])
})
