/* W29 (P2) — security lock must re-arm on main-window rebuild.
 *
 * The startup arming lived only in index.js (once('did-finish-load') on the FIRST window).
 * A window destroyed and recreated before its first load completed (X-close→tray→
 * showMainOrLock) left the rebuilt window permanently unlocked: enableSecurityLock was on
 * but data rendered in the clear. Fix: arming moved into createMainWindow (windows.js) so
 * EVERY creation arms; the fire-time isLocked() guard keeps it from double-triggering with
 * the load-failure fallback (windows.js did-fail-load retries-exhausted path).
 *
 * Run: node --test tests/unit/main/w29-securitylock-rearm.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import Module from 'node:module'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(import.meta.dirname, '../../..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'w29-lock-'))
const UD = path.join(TMP, 'ud')
fs.mkdirSync(UD, { recursive: true })

// ---- stubs ----
const LOG_STUB = { info: () => {}, warn: () => {}, error: () => {} }
let config = { winBounds: null, enableSecurityLock: true }
let locked = false
let lockCalls = 0
function fakeWebContents () {
  const wc = new EventEmitter()
  wc.loadURL = async () => {}
  wc.setWindowOpenHandler = () => {}
  wc.executeJavaScript = async () => {}
  return wc
}
let lastWin = null
class FakeBrowserWindow {
  constructor () {
    this.webContents = fakeWebContents()
    this.loadURL = async () => {}
    this.maximize = () => {}
    this.setTitle = () => {}
    this.isDestroyed = () => false
    this.once = (ev, h) => { this._once = this._once || {}; (this._once[ev] = this._once[ev] || []).push(h) }
    this.on = (ev, h) => { this._on = this._on || {}; (this._on[ev] = this._on[ev] || []).push(h) }
    this.removeListener = () => {}
    lastWin = this
  }
}
const ELECTRON_STUB = {
  app: { getPath: () => UD, getVersion: () => '0.0.0-test', relaunch: () => {}, quit: () => {}, exit: () => {} },
  BrowserWindow: FakeBrowserWindow,
  shell: { openExternal: async () => {} },
  dialog: { showErrorBox: () => {} },
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  if (request === 'electron-log') return LOG_STUB
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

fs.cpSync(path.join(ROOT, 'src', 'main'), path.join(TMP, 'src', 'main'), { recursive: true })
const windows = require(path.join(TMP, 'src', 'main', 'windows.js'))

function buildCtx () {
  return {
    readConfig: () => config,
    writeConfig: () => {},
    i18n: { mt: (k) => k },
    log: LOG_STUB,
    windowRef: { setMainWindow: () => {} },
    closeBehavior: {},
    tomatoTaskbar: { init: () => {} },
    updater: { init: () => {} },
    applyShortcuts: () => {},
    shortcuts: { unregisterAll: () => {} },
    scheduler: { flushFiredNow: () => {} },
    isLocked: () => locked,
    lockAppNow: () => { lockCalls++; locked = true },
    showMainOrLock: () => {},
    isQuitting: () => false,
    getState: () => ({}),
    getTray: () => null,
    requestUserQuit: async () => false,
    onRendererGone: () => {},
  }
}

test('w29: every created main window arms the lock; a rebuilt window locks even if the first never finished loading', () => {
  const wm = windows.createWindowManager(buildCtx())
  lockCalls = 0; locked = false
  // window A created, destroyed BEFORE its load completed (the regression shape)
  wm.createMainWindow()
  const wcA = lastWin.webContents
  // rebuild: close-then-tray path creates a fresh window
  wm.createMainWindow()
  const wcB = lastWin.webContents
  // A's (stale) handler never fires; B finishes loading — the new window must lock
  wcB.emit('did-finish-load')
  assert.equal(lockCalls, 1, 'RED before the fix: the rebuilt window had nobody to lockAppNow')
})

test('w29: no double-trigger with the load-failure fallback or a repeated fire', () => {
  const wm = windows.createWindowManager(buildCtx())
  lockCalls = 0; locked = false
  wm.createMainWindow()
  const wc = lastWin.webContents
  wc.emit('did-finish-load') // arm fires, sets locked
  wc.emit('did-finish-load') // once() consumed; even a stray second fire must be a no-op
  assert.equal(lockCalls, 1, 'fire-time isLocked guard: exactly one lockAppNow')
})

test('w29: arming is inert when enableSecurityLock is off', () => {
  config = { winBounds: null, enableSecurityLock: false }
  const wm = windows.createWindowManager(buildCtx())
  lockCalls = 0; locked = false
  wm.createMainWindow()
  lastWin.webContents.emit('did-finish-load')
  assert.equal(lockCalls, 0)
  config = { winBounds: null, enableSecurityLock: true } // restore default for later tests
})
