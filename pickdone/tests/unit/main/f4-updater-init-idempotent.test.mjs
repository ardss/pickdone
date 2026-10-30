/**
 * F4 fix (2026-10-15): updater.init must be IDEMPOTENT across main-window recreations.
 * windows.js createMainWindow calls updater.init(win) every time the window is closed-to-tray and
 * reopened; without the _inited guard each init re-attaches autoUpdater.on(...) handlers, so
 * listeners (and the per-event broadcast) accumulate O(N) with window recreations. Regression:
 *  - a second init() attaches NO new autoUpdater listeners;
 *  - the second init() still re-binds the live window ref (broadcast reaches the NEW window only).
 * Run: node --test tests/unit/main/f4-updater-init-idempotent.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Module = require('module')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'f4-updater-'))

let autoUpdaterStub = null
const ELECTRON_STUB = { app: { getPath: () => TMP, getVersion: () => '0.0.0-test' } }
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  if (request === 'electron-updater') return { autoUpdater: autoUpdaterStub }
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

function fakeWin () {
  const sent = []
  return { sent, isDestroyed: () => false, webContents: { send: (...a) => sent.push(a) } }
}

function freshUpdater (stub) {
  autoUpdaterStub = stub
  const resolved = require.resolve('../../../src/main/updater.js')
  delete require.cache[resolved]
  return require('../../../src/main/updater.js')
}

test('F2: re-init attaches NO new listeners and re-binds the window ref (broadcast hits the new window)', () => {
  const handlers = new Map()
  let attachCount = 0
  const autoUpdater = {
    isUpdaterActive: () => true,
    autoDownload: false,
    on: (evt, fn) => { attachCount++; handlers.set(evt, fn) },
    checkForUpdates: async () => ({}),
    downloadUpdate: async () => ({}),
    quitAndInstall: () => {},
  }
  const updater = freshUpdater(autoUpdater)
  const win1 = fakeWin()
  updater.init(win1)
  const afterFirst = attachCount
  assert.ok(afterFirst > 0, 'first init must attach the event handlers')

  // close-to-tray → reopen: windows.js calls updater.init(win) again with the NEW window
  const win2 = fakeWin()
  updater.init(win2)
  assert.equal(attachCount, afterFirst, 'red before the _inited guard: second init stacked a fresh set of listeners')

  // an event fires: exactly ONE broadcast, to the NEW window only (stale ref must not receive it)
  handlers.get('update-not-available')({ version: '9.9.9' })
  assert.equal(win1.sent.length, 0, 'the old window must not receive updater events after recreation')
  assert.equal(win2.sent.length, 1, 'the live window receives the broadcast exactly once (not N-fold)')
  assert.equal(win2.sent[0][0], 'updater:event')
})
