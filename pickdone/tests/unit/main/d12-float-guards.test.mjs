/**
 * D12 float guards:
 *   Fault-11 — undock() ran a BARE setBounds() → defaultBounds() → screen.getPrimaryDisplay()
 *     chain out of the tray-menu click handler; a display unplug mid-undock threw an uncaught
 *     exception in the main process. undock now re-clamps through the C8 guarded safeReclamp().
 *   Fault-13 — dragStart() read screen.getCursorScreenPoint() unguarded; an RDP disconnect (or
 *     display teardown) threw synchronously out of the renderer invoke AND left the hit poll
 *     suspended (stopHitPoll had already run) — the float stayed click-through forever. The
 *     cursor read is now guarded: log, re-arm the poll, refuse the drag.
 *
 * Run: node --test tests/unit/main/d12-float-guards.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

// Controllable screen stub: `screenBroken` toggles whether the screen API throws (the
// display-unplug / RDP-disconnect simulation). Installed BEFORE tomato-float loads.
let screenBroken = false
const screenErr = () => { throw new Error('screen API unavailable (display gone)') }
const stubs = {
  electron: {
    app: { getPath: () => process.env.TEMP || '/tmp', isPackaged: false },
    BrowserWindow: class {},
    screen: {
      getPrimaryDisplay: () => { if (screenBroken) screenErr(); return { workArea: { x: 0, y: 0, width: 800, height: 600 }, bounds: { x: 0, y: 0, width: 800, height: 600 } } },
      getCursorScreenPoint: () => { if (screenBroken) screenErr(); return { x: 10, y: 10 } },
      on () {}, getAllDisplays: () => []
    }
  },
  '../db': { isOpen: () => false, call: () => null }
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request]
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const tf = require_('../../../src/main/tomato-float.js')

function stubWin () {
  return {
    isDestroyed: () => false,
    isVisible: () => false,
    showInactive () {},
    getBounds: () => ({ x: 100, y: 100, width: 240, height: 320 }),
    setBounds () {},
    setIgnoreMouseEvents () {},
    webContents: { id: 'float' }
  }
}

test('Fault-11: undock with the screen API throwing must not escape (guarded re-clamp)', () => {
  const w = stubWin()
  tf.__forceWin(w)
  screenBroken = true
  try {
    // red before the fix: undock called setBounds() → defaultBounds() → getPrimaryDisplay()
    // bare, so this threw "screen API unavailable" straight out of the tray click handler
    tf.undock()
  } finally {
    screenBroken = false
  }
})

test('Fault-11: undock on a healthy screen still re-clamps the window bounds', () => {
  const w = stubWin()
  let reclamped = false
  w.setBounds = () => { reclamped = true }
  tf.__forceWin(w)
  screenBroken = false
  tf.undock()
  assert.equal(reclamped, true, 'the undock re-clamp intent must survive the guard')
})

test('Fault-13: dragStart with the cursor unavailable refuses the drag without throwing', () => {
  const w = stubWin()
  tf.__forceWin(w)
  screenBroken = true
  try {
    // red before the fix: getCursorScreenPoint() threw out of dragStart as a raw IPC error
    const r = tf.dragStart(w.webContents)
    assert.equal(r, false, 'a drag without a readable cursor must be refused')
  } finally {
    screenBroken = false
  }
})

test('Fault-13: dragStart on a healthy screen still starts the drag', () => {
  const w = stubWin()
  w.isVisible = () => false // keep the poll self-stopping in the unit env
  tf.__forceWin(w)
  screenBroken = false
  const r = tf.dragStart(w.webContents)
  assert.equal(r, true, 'the healthy path must keep working')
  tf.dragStop(w.webContents) // clean up the 16ms drag timer
})
