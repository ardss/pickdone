/* W29 (P2) — data:relocate close-failed branch must re-arm the external db watch.
 *
 * stopLatestDbWatch() runs BEFORE dbm.close(); when close() threw, the best-effort
 * re-init produced a live handle but nothing re-armed the poll (unlike the
 * migration-failed branch, which probes + restarts) — external (CLI) write detection
 * stayed blind for the whole session. Fix: after a successful re-init (getMeta probe),
 * restartLatestDbWatch() is called, same rule as the migration path.
 *
 * Run: node --test tests/unit/main/w29-relocate-closefail-watch.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(import.meta.dirname, '../../..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'w29-relocate-'))
const UD = path.join(TMP, 'ud')
fs.mkdirSync(UD, { recursive: true })

// ---- module-load stubs: electron + electron-log ----
const captured = {}
const dialogCalls = []
const fakeSender = { id: 7 }
const fakeWin = { webContents: fakeSender, isDestroyed: () => false }
const ELECTRON_STUB = {
  app: { getPath: () => UD, getVersion: () => '0.0.0-test', relaunch: () => {}, exit: () => {} },
  dialog: {
    showMessageBox: async () => { dialogCalls.push('msgbox'); return { response: 0 } },
    showOpenDialog: async () => ({ canceled: true, filePaths: [] }),
    showMessageBoxSync: () => 0,
    showErrorBox: () => {},
  },
  Notification: function () { return { show: () => {} } },
  shell: { openExternal: async () => {} },
  protocol: { handle: (scheme, cb) => { captured[scheme] = cb } },
  BrowserWindow: function () { return {} },
}
const LOG_STUB = { info: () => {}, warn: () => {}, error: () => {}, hooks: [], transports: { file: {}, console: {} } }
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  if (request === 'electron-log') return LOG_STUB
  if (request === 'electron-updater') {
    return { autoUpdater: { on: () => {}, checkForUpdates: async () => ({}) , setFeedURL: () => {}, quitAndInstall: () => {} } }
  }
  if (request.endsWith('shortcut-defaults.mjs')) {
    return { DEFAULT_SHORTCUT_SETTINGS: {}, computeDefaultShortcutSettings: () => ({}) }
  }
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

// copy the whole src/main tree so the handler's relative requires resolve inside the sandbox
fs.cpSync(path.join(ROOT, 'src', 'main'), path.join(TMP, 'src', 'main'), { recursive: true })
const systemHandlers = require(path.join(TMP, 'src', 'main', 'handlers', 'system.js'))
const watchMod = require(path.join(TMP, 'src', 'main', 'external-db-watch.js'))

const calls = { stop: 0, restart: 0 }
watchMod.stopLatestDbWatch = () => { calls.stop++ }
watchMod.restartLatestDbWatch = () => { calls.restart++ }

function buildCtx (dbm) {
  return {
    isLocked: () => false,
    allowWithinRate: () => true,
    i18n: { mt: (k) => k },
    app: ELECTRON_STUB.app,
    getMainWindow: () => fakeWin,
    isSafeExternal: () => true,
    scheduler: { flushFiredNow: () => {} },
    dbm,
  }
}
const TARGET = path.join(TMP, 'target')

test('w29: relocate close() failure with a live re-init re-arms the external db watch', async () => {
  const closeCalls = { init: 0 }
  const dbm = {
    close: () => { throw new Error('w29 injected close failure') },
    init: () => { closeCalls.init++ },
    call: (op) => { if (op === 'getMeta') return '1'; throw new Error('unexpected op ' + op) },
  }
  const h = systemHandlers(buildCtx(dbm))
  calls.stop = 0; calls.restart = 0
  const r = await h['data:relocate']({ sender: fakeSender }, { targetDir: TARGET })
  assert.equal(r.ok, false, 'the close failure still aborts the migration')
  assert.match(r.error, /dataLocCloseFailed/)
  assert.equal(calls.stop, 1, 'the watch was stopped before close (unchanged)')
  assert.equal(calls.restart, 1, 'RED before the fix: the poll was never re-armed after close failed')
  assert.equal(closeCalls.init, 1, 'the best-effort re-init still runs')
})

test('w29: relocate close() failure with a DEAD re-init does NOT restart the poll', async () => {
  const dbm = {
    close: () => { throw new Error('w29 injected close failure 2') },
    init: () => {},
    call: () => { throw new Error('dead handle') },
  }
  const h = systemHandlers(buildCtx(dbm))
  calls.stop = 0; calls.restart = 0
  const r = await h['data:relocate']({ sender: fakeSender }, { targetDir: TARGET })
  assert.equal(r.ok, false)
  assert.equal(calls.restart, 0, 'restarting the poll over a dead handle must be skipped (probe rule)')
})
