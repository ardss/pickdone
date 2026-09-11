/* F6 regression (2026-09-12): undo toast — keyboard parity for the hover-pause timer (any keydown pauses,
 * keyup re-arms) and role="status" on the toast element for screen readers. No visual change.
 * setTimeout is shrunk to keep the test fast. No electron required.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn, ms) => realSetTimeout(fn, Math.min(ms || 0, 25))
const sleep = ms => new Promise(r => realSetTimeout(r, ms))

const listeners = {}
globalThis.document = {
  addEventListener: (type, fn) => { (listeners[type] = listeners[type] || []).push(fn) },
  removeEventListener: () => {}
}
const fireKey = type => (listeners[type] || []).forEach(fn => fn({ key: 'Shift' }))

const makeEl = () => {
  const el = new EventTarget()
  const attrs = {}
  el.setAttribute = (k, v) => { attrs[k] = v }
  el.getAttr = k => attrs[k]
  return el
}
const mkMsg = () => {
  const el = makeEl()
  const st = { closes: 0 }
  st.close = () => { st.closes++ }
  st.el = el
  st.$el = el
  return st
}
globalThis.window = {
  Vue: { h: (tag, children) => ({ tag, children }) },
  // Minimal Element-plus-style Message handle: $el + close()
  $message: null
}

const { showUndoToast, UNDO_TOAST_MS } = await import('../../../renderer/js/utils/undoToast.js')
assert.equal(UNDO_TOAST_MS, 5000)

test('F6: toast auto-dismisses, pauses while a key is down, and resumes on keyup', async () => {
  const msg = showUndoToast(() => mkMsg(), 'undo text')
  assert.equal(msg.$el.getAttr('role'), 'status', 'role=status announced to screen readers')
  await sleep(60)
  assert.equal(msg.closes, 1, 'auto-dismiss still works without keyboard')

  const msg2 = showUndoToast(() => mkMsg(), 'second')
  fireKey('keydown') // pause before the (shrunk) timer fires
  await sleep(60)
  assert.equal(msg2.closes, 0, 'keydown pauses the dismiss timer')
  fireKey('keyup') // re-arm
  await sleep(60)
  assert.equal(msg2.closes, 1, 'keyup resumes the timer and the toast dismisses')
})

test('F6: repeated keydown/keyup cycles keep the toast alive across cycles', async () => {
  const msg = showUndoToast(() => mkMsg(), 'third')
  for (let i = 0; i < 3; i++) { fireKey('keydown'); await sleep(40); fireKey('keyup') }
  assert.equal(msg.closes, 0, 'held/paused cycles prevent dismissal')
  await sleep(60)
  assert.equal(msg.closes, 1, 'final timer fires after last keyup')
})
