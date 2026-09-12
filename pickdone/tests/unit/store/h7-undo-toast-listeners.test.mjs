/* H6 regression (2026-09-12): showUndoToast's document keydown/keyup listeners are a single
 * ref-counted pair — repeated shows must not accumulate document listeners, and closing the
 * last toast must remove them. Previously one toast = two permanent document listeners whose
 * stale closures kept re-arming timers for already-closed messages.
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const realSetTimeout = globalThis.setTimeout
globalThis.setTimeout = (fn, ms) => realSetTimeout(fn, Math.min(ms || 0, 20))
const sleep = ms => new Promise(r => realSetTimeout(r, ms))

// Document mock that tracks live listener counts including removals
const doc = { map: new Map() }
const add = (type, fn) => {
  if (!doc.map.has(type)) doc.map.set(type, new Set())
  doc.map.get(type).add(fn)
}
const remove = (type, fn) => { doc.map.get(type)?.delete(fn) }
const count = type => (doc.map.get(type) || new Set()).size
const fire = type => [...(doc.map.get(type) || [])].forEach(fn => fn({ key: 'Shift' }))
globalThis.document = { addEventListener: add, removeEventListener: remove }

const makeEl = () => {
  const el = new EventTarget()
  el.setAttribute = () => {}
  return el
}
const mkMsg = () => {
  const st = { closes: 0, el: makeEl(), $el: null }
  st.$el = st.el
  st.close = () => { st.closes++ }
  return st
}
globalThis.window = { Vue: { h: (tag, children) => ({ tag, children }) } }

const { showUndoToast } = await import('../../../renderer/js/utils/undoToast.js')

beforeEach(() => { doc.map.clear() })

test('H6: repeated showUndoToast calls do not accumulate document listeners', () => {
  const toasts = []
  for (let i = 0; i < 5; i++) toasts.push(showUndoToast(() => mkMsg(), 'x' + i))
  assert.equal(count('keydown'), 1, 'exactly one shared keydown listener after 5 toasts')
  assert.equal(count('keyup'), 1, 'exactly one shared keyup listener after 5 toasts')
  // Shared listener still pauses ALL live toasts
  fire('keydown')
  toasts.forEach(t => t.close())
  assert.equal(count('keydown'), 0, 'keydown listener removed after the last toast closes')
  assert.equal(count('keyup'), 0, 'keyup listener removed after the last toast closes')
})

test('H6: auto-dismiss (timer close) also releases the listeners', async () => {
  showUndoToast(() => mkMsg(), 'auto')
  assert.equal(count('keydown'), 1)
  await sleep(50) // shrunk UNDO_TOAST_MS fires -> msg.close() -> release
  assert.equal(count('keydown'), 0, 'listeners released once the toast auto-dismissed')
  assert.equal(count('keyup'), 0)
})

test('H6: a still-open toast keeps listeners alive while others close (refcount)', async () => {
  const a = showUndoToast(() => mkMsg(), 'a')
  const b = showUndoToast(() => mkMsg(), 'b')
  a.close()
  assert.equal(count('keydown'), 1, 'kept while at least one toast is open')
  fire('keydown') // must not throw against the already-closed toast
  b.close()
  assert.equal(count('keydown'), 0)
})
