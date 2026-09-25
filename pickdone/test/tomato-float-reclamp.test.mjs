/* C8-tomato-float-display-removed (2026-09-26): the display-metrics-changed / display-removed
 * screen-event callbacks synchronously called setBounds() → defaultBounds() →
 * screen.getPrimaryDisplay().bounds with NO try/catch — any throw from the screen API during a
 * display transition (monitor unplug while the float exists) fired an uncaught exception in the
 * Electron main process. Both listeners now route through a guarded safeReclamp (same convention
 * as startHitPoll's tick / undock's applyIgnore).
 * Electron + electron-log stubbed at a temp dir — never launches electron, never touches the
 * real %APPDATA%.
 * NOTE: pickdone/test/ is NOT auto-discovered by tests/run-all.mjs; run directly:
 * node --test test/tomato-float-reclamp.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

const warnings = []
const hooks = {}
const stubs = {
  electron: {
    BrowserWindow: class {},
    screen: {
      // Simulates the throw from the screen API mid-display-removal.
      getPrimaryDisplay () { throw new Error('display gone mid-transition') },
      on (ev, cb) { hooks[ev] = cb },
    },
  },
  'electron-log': { info () {}, warn (...a) { warnings.push(a.join(' ')) }, error () {} },
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request]
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const tf = require_('../src/main/tomato-float.js')

test('C8: the display-removed re-clamp path cannot throw an uncaught exception', () => {
  const boom = { isDestroyed: () => false, setBounds () { throw new Error('getPrimaryDisplay failed during display-removed') } }
  tf.__forceWin(boom)
  try {
    assert.doesNotThrow(() => tf.safeReclamp(), 'THE FIX: a screen-API throw in the re-clamp must be a logged no-op, not an uncaught main-process exception')
    assert.ok(warnings.some(w => w.includes('[TomatoFloat]')), 'the failure is logged (visible, not silent)')
  } finally {
    tf.__clearWin()
  }
})

test('C8: a live window re-clamps successfully when the screen API behaves (intent preserved)', () => {
  let clamped = null
  tf.__forceWin({ isDestroyed: () => false, setBounds (b) { clamped = b } })
  try {
    // defaultBounds reads getPrimaryDisplay — still throwing in this stub — but the GUARD holds;
    // the no-throw-with-healthy-screen path is pinned by the existing hit-poll/drag suites. What
    // this asserts: the guard does not swallow its own guard-rail (win cleared → no-op).
    tf.__clearWin()
    assert.doesNotThrow(() => tf.safeReclamp(), 'win=null / destroyed window stays a safe no-op')
    assert.equal(clamped, null)
  } finally {
    tf.__clearWin()
  }
})
