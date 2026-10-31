/* W22 (2026-10-30) regression round, two fixes:
 *   Fix 1  tomato-float.js rebuildAfterHandshakeFailure: the unconditional destroy + reopen used to
 *          TRAMPLE the user's close intent. Trigger window: the float page mounts but never delivers
 *          the render handshake, and the user hides()/dock()s the float inside the 10s watch window —
 *          reopen() unconditionally cleared dockedToTray and the tomatoFloatClosedByUser persisted
 *          marker (which the renderer main.js 6s auto-show gate reads), resurrecting a float the user
 *          had just closed. Now a present close intent (dockedToTray || isUserClosed()) takes a silent
 *          drop path: destroy only, no reopen, no marker clear; the next explicit open lazily rebuilds.
 *          The DB-not-open branch of isUserClosed() (returns false) keeps its semantics: rebuild proceeds.
 *   Fix 2  handlers/system.js 'notification' rate-cap warn: bare e.sender.id dereference (the sibling
 *          gates at allowWithinRatePerSender already had the guard) → same guard shape, warn degrades
 *          instead of throwing on a sender-less event.
 * Run: node --test tests/unit/main/w22-float-rebuild-intent.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Module = require('module')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'w22-float-'))
const electronStub = {
  app: { getPath: () => TMP, isPackaged: false, getVersion: () => '0.0.0' },
  BrowserWindow: class {},
  ipcMain: { handle: () => {}, on: () => {} },
  Notification: class { on () {} show () {} },
  shell: { openExternal: async () => {}, openPath: () => {} },
  screen: {
    getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1048 } }),
    getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1048 } }],
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    on () {},
  },
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const tomatoFloat = require('../../../src/main/tomato-float.js')
const db = require('../../../src/main/db.js')

const sleep = ms => new Promise(ok => setTimeout(ok, ms))
// [load-budget 2026-10-31] the rebuild timer fires at 500ms; the old sleep(700) left a 200ms
// margin that CI load regularly ate. Polls below replace the bare sleeps:
//   absence cases poll until the BAD condition appears (fail fast) or a window that comfortably
//   outlives the 500ms timer elapses; the positive case polls until the reopen lands (5s cap).
const WAIT_REOPEN_WINDOW = 900

/** Minimal stub window good enough for dock()/stopDrag()/stopHitPoll()/applyIgnore/destroy paths. */
function makeStubWin () {
  const win = {
    destroyed: false,
    destroyedCount: 0,
    isDestroyed: () => win.destroyed,
    isVisible: () => false,
    hide () {},
    destroy () { win.destroyed = true; win.destroyedCount++ },
    setIgnoreMouseEvents () {},
    setBounds () {},
    getBounds: () => ({ x: 0, y: 0, width: 240, height: 320 }),
    webContents: { isLoadingMainFrame: () => true, once () {}, removeListener () {} },
  }
  return win
}

/** Pin the db surface tomato-float reads for the close marker, per test. */
function stubDb ({ open, getMeta, calls }) {
  const origIsOpen = db.isOpen
  const origCall = db.call
  db.isOpen = () => open
  db.call = (op, params) => {
    if (calls) calls.push([op, params])
    if (op === 'getMeta') return getMeta ? getMeta(params) : null
    return undefined
  }
  return () => { db.isOpen = origIsOpen; db.call = origCall }
}

/* ---------- Fix 1: user close intent survives a handshake-failure rebuild ---------- */

test('W22 fix 1: docked float + handshake timeout → silent drop (no reopen, dock state and marker untouched)', async () => {
  tomatoFloat.crashRebuild.reset()
  const dbCalls = []
  const restoreDb = stubDb({ open: true, getMeta: () => null, calls: dbCalls })
  const win = makeStubWin()
  tomatoFloat.__forceWin(win)
  tomatoFloat.dock() // user intent #1: docked to tray
  assert.equal(tomatoFloat.isDocked(), true)

  const origReopen = tomatoFloat.reopen
  let reopens = 0
  tomatoFloat.reopen = () => { reopens++; return true }
  try {
    tomatoFloat.__rebuildAfterHandshakeFailure('render-handshake-timeout')
    assert.equal(win.destroyed, true, 'dead window is still destroyed')
    for (let t0 = Date.now(); Date.now() - t0 < WAIT_REOPEN_WINDOW && reopens === 0;) await sleep(25)
    assert.equal(reopens, 0, 'RED before the fix: reopen() ran and un-docked + cleared the close marker')
    assert.equal(tomatoFloat.isDocked(), true, 'docked state survives the failure path')
    assert.ok(!dbCalls.some(([op, p]) => op === 'deleteMeta' && p && p[0] === 'tomatoFloatClosedByUser'),
      'the persisted close marker is never deleted by the failure path')
    assert.equal(tomatoFloat.crashRebuild.count, 0, 'the silent drop does not consume the rebuild budget')
  } finally {
    tomatoFloat.reopen = origReopen
    restoreDb()
    tomatoFloat.__clearWin()
    tomatoFloat.crashRebuild.reset()
  }
  // leave module state clean: undock clears dockedToTray (win already cleared → lazy show via reopen)
  const origReopen2 = tomatoFloat.reopen
  tomatoFloat.reopen = () => true
  try { tomatoFloat.undock() } finally { tomatoFloat.reopen = origReopen2 }
  assert.equal(tomatoFloat.isDocked(), false, 'cleanup: module back to undocked')
})

test('W22 fix 1: persisted user-closed marker + handshake timeout → silent drop (no reopen, no deleteMeta)', async () => {
  tomatoFloat.crashRebuild.reset()
  const dbCalls = []
  const restoreDb = stubDb({ open: true, getMeta: () => '1', calls: dbCalls }) // user intent #2: closed marker in DB
  const win = makeStubWin()
  tomatoFloat.__forceWin(win)
  assert.equal(tomatoFloat.isUserClosed(), true)

  const origReopen = tomatoFloat.reopen
  let reopens = 0
  tomatoFloat.reopen = () => { reopens++; return true }
  try {
    tomatoFloat.__rebuildAfterHandshakeFailure('render-handshake-timeout')
    assert.equal(win.destroyed, true, 'dead window destroyed, rebuild deferred to the next explicit open')
    for (let t0 = Date.now(); Date.now() - t0 < WAIT_REOPEN_WINDOW && reopens === 0;) await sleep(25)
    assert.equal(reopens, 0, 'no auto reopen while the user-closed marker stands')
    assert.ok(!dbCalls.some(([op]) => op === 'deleteMeta'), 'marker not cleared behind the user\'s back')
  } finally {
    tomatoFloat.reopen = origReopen
    restoreDb()
    tomatoFloat.__clearWin()
    tomatoFloat.crashRebuild.reset()
  }
})

test('W22 fix 1: no close intent → behavior unchanged (destroy + delayed reopen; DB-not-open keeps isUserClosed=false semantics)', async () => {
  tomatoFloat.crashRebuild.reset()
  // DB not initialized (early startup / bare env): isUserClosed() must read false → rebuild proceeds
  const restoreDb = stubDb({ open: false, getMeta: () => { throw new Error('should not be called') } })
  const win = makeStubWin()
  tomatoFloat.__forceWin(win)
  assert.equal(tomatoFloat.isUserClosed(), false, 'DB-not-open branch keeps returning false')

  const origReopen = tomatoFloat.reopen
  let reopens = 0
  tomatoFloat.reopen = () => { reopens++; return true }
  try {
    tomatoFloat.__rebuildAfterHandshakeFailure('render-handshake-timeout')
    assert.equal(win.destroyed, true)
    for (let t0 = Date.now(); reopens < 1 && Date.now() - t0 < 5000;) await sleep(25)
    assert.equal(reopens, 1, 'RED before the fix would pass here too: the rebuild path is unchanged without user intent')
  } finally {
    tomatoFloat.reopen = origReopen
    restoreDb()
    tomatoFloat.__clearWin()
    tomatoFloat.crashRebuild.reset()
  }
})

/* ---------- Fix 2: notification rate-cap warn guards a sender-less event ---------- */

test('W22 fix 2: notification handler rate-cap warn no longer dereferences e.sender.id bare', async () => {
  // source-level anchor: the warn uses the same guard shape as allowWithinRatePerSender (:31)
  const src = fs.readFileSync(path.resolve(import.meta.dirname, '../../../src/main/handlers/system.js'), 'utf8')
  assert.ok(src.includes("log.warn('[IPC] notification rate-capped, sender:', e && e.sender && e.sender.id)"),
    'RED before the fix: bare e.sender.id at the notification rate-cap warn')

  // behavioral: a sender-less event must degrade to the warn, never throw
  const handlers = require('../../../src/main/handlers/system.js')({
    isLocked: () => false,
    allowWithinRate: () => false, // force the rate-capped branch — the old bare dereference site
    i18n: { mt: k => k },
    app: electronStub.app,
    getMainWindow: () => null,
    isSafeExternal: () => true,
  })
  const ev = {} // no .sender at all
  assert.equal(handlers.notification(ev, { title: 't' }), false, 'rate-capped call returns false without throwing')
  // and a normal-shaped event still works end to end
  assert.equal(handlers.notification({ sender: { id: 7 } }, { title: 't' }), false, 'guarded event flows through the same branch')
})
