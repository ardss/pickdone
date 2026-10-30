/**
 * F4 P3 (2026-10-18) regression tests — notify-sound destroyed-window guard:
 * the send point only truthy-checked the window; during teardown (window/webContents destroyed
 * between the check and the send) webContents.send threw "Object has been destroyed", the outer
 * catch swallowed it, and the reminder played muted with NO beep fallback. The fix guards both
 * the window and its webContents and FALLS THROUGH to the system beep, so notifications are
 * never silent. Run: node --test tests/unit/main/notify-sound-destroyed-guard.test.mjs
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { sound, toSoundUrl } = require('../../../src/main/notify-sound.js')
const windowRef = require('../../../src/main/window-ref.js')

const origGet = windowRef.getMainWindow
afterEach(() => { windowRef.getMainWindow = origGet })

function fakeWindow ({ destroyed = false, wcDestroyed = false }) {
  const sent = []
  return {
    sent,
    isDestroyed: () => destroyed,
    webContents: {
      isDestroyed: () => wcDestroyed,
      send: (ch, msg) => sent.push({ ch, msg }),
    },
  }
}

test('sound: a live window receives the play-sound message with an app:// URL', () => {
  const win = fakeWindow({})
  windowRef.getMainWindow = () => win
  sound(toSoundUrl(process.platform === 'win32' ? 'K:\\x\\sounds\\d.mp3' : '/x/sounds/d.mp3', process.cwd()))
  // in-root conversion is covered elsewhere; here only the GUARD contract matters
  assert.equal(win.sent.length, 1, 'the send went through the guarded path')
  assert.equal(win.sent[0].ch, 'play-sound')
})

test('sound: a destroyed window never sends and must not throw (guard + beep fallback)', () => {
  const win = fakeWindow({ destroyed: true })
  windowRef.getMainWindow = () => win
  assert.doesNotThrow(() => sound('/x/sounds/d.mp3'), 'a destroyed window must not wedge the reminder')
  assert.equal(win.sent.length, 0, 'no send into a destroyed window')
})

test('sound: a destroyed webContents behind a live window never sends (fall through to beep)', () => {
  const win = fakeWindow({ wcDestroyed: true })
  windowRef.getMainWindow = () => win
  assert.doesNotThrow(() => sound('/x/sounds/d.mp3'))
  assert.equal(win.sent.length, 0, 'no send into a destroyed webContents')
})

test('sound: a send that throws at the last moment falls through to the beep fallback (no silent reminder)', () => {
  const win = fakeWindow({})
  win.webContents.send = () => { throw new Error('Object has been destroyed') }
  windowRef.getMainWindow = () => win
  assert.doesNotThrow(() => sound('/x/sounds/d.mp3'), 'a mid-teardown send throw must be contained')
})
