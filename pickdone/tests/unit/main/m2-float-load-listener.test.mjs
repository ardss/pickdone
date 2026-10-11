/* M2 fix 5 (2026-10-09): tomato-float reopen() during an in-flight frame load appended a FRESH
 * did-finish-load once-listener on EVERY wake — N wakes during one load queued N closures and
 * ALL of them fired when the load finished (N redundant showInactive + flushPaint rounds).
 * Fix: bound single-handler pattern (windows.js replay shape) — mount removes the previous
 * handler first, so at most one is ever attached.
 * Red before the fix: 3 reopens during load → 3 listeners → 3 shows.
 * Run: node --test tests/unit/main/m2-float-load-listener.test.mjs */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Module = require('module')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-float-'))
const electronStub = {
  app: { getPath: () => TMP },
  BrowserWindow: class {},
  ipcMain: { on: () => {} },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }],
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const db = require('../../../src/main/db.js')
const tomatoFloat = require('../../../src/main/tomato-float.js')

db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'm2-float-db-')))

function makeFakeWin () {
  const listeners = { 'did-finish-load': [] }
  const wc = {
    isLoadingMainFrame: () => true, // stay "loading" for the whole test
    once (ev, fn) { listeners[ev].push(fn) },
    removeListener (ev, fn) { const i = listeners[ev].indexOf(fn); if (i >= 0) listeners[ev].splice(i, 1) },
  }
  const state = { shows: 0 }
  const win = {
    webContents: wc,
    isDestroyed: () => false,
    isVisible: () => true,
    showInactive () { state.shows++ },
    getBounds: () => ({ x: 0, y: 0, width: 240, height: 320 }),
    setBounds () {},
    setIgnoreMouseEvents () {},
    hide () {},
  }
  return { win, wc, state, listeners }
}

test('M2 fix5: 3 reopens during one load → exactly 1 did-finish-load listener, 1 show', () => {
  const { win, wc, state, listeners } = makeFakeWin()
  tomatoFloat.__forceWin(win)
  try {
    tomatoFloat.reopen()
    tomatoFloat.reopen()
    tomatoFloat.reopen()
    assert.equal(listeners['did-finish-load'].length, 1,
      'RED before the fix: 3 wakes during load queued 3 once-listeners')
    // the load finishes: a real webContents emits the event ONCE, invoking every listener and
    // auto-removing `once` registrations afterwards (emulated here)
    for (const fn of [...listeners['did-finish-load']]) { fn(); wc.removeListener('did-finish-load', fn) }
    assert.equal(state.shows, 1,
      'RED before the fix: all queued closures fired → 3 redundant show rounds')
    assert.equal(listeners['did-finish-load'].length, 0, 'the single handler consumed itself')
    // a later wake during a NEW load mounts exactly one fresh handler
    tomatoFloat.reopen()
    assert.equal(listeners['did-finish-load'].length, 1)
  } finally {
    tomatoFloat.hide() // stop the 40ms hit-poll timer before the process ends
    tomatoFloat.__clearWin()
  }
})
