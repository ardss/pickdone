/* F4 regression #6 (2026-09-15): a route change unmounts the whole component tree, so Element Plus
 * destroys the Message without anyone calling msg.close() — the controller stayed in activeToasts
 * forever and the shared document keydown/keyup listeners leaked (accumulating per orphaned toast).
 * showUndoToast now passes an onClose callback (EP calls it after close, including destroy paths)
 * that runs the same idempotent unregister as the patched msg.close. No electron required.
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const doc = { map: new Map() }
const add = (type, fn) => {
  if (!doc.map.has(type)) doc.map.set(type, new Set())
  doc.map.get(type).add(fn)
}
const remove = (type, fn) => { doc.map.get(type)?.delete(fn) }
const count = type => (doc.map.get(type) || new Set()).size
globalThis.document = { addEventListener: add, removeEventListener: remove }

/** Message factory. Without `withClose` the instance has NO close() method (models the EP destroy
 * path where nothing ever calls msg.close()). With `withClose` the instance exposes a real base
 * close() (like EP's) that the toast util can patch — lets us exercise the close+onClose double path. */
const makeFactory = (withClose = false) => {
  const captured = { opts: null, baseCloseCalls: 0 }
  const messageFn = opts => {
    captured.opts = opts
    const st = { el: new EventTarget(), $el: null }
    st.el.setAttribute = () => {}
    st.$el = st.el
    if (withClose) st.close = () => { captured.baseCloseCalls++ }
    Object.assign(st, opts)
    return st
  }
  return { messageFn, captured }
}
globalThis.window = { Vue: { h: (tag, children) => ({ tag, children }) } }

const { showUndoToast } = await import('../../../renderer/js/utils/undoToast.js')

beforeEach(() => { doc.map.clear() })

test('F4: tree unmount (EP destroy, no msg.close call) still releases the controller via onClose', () => {
  const { messageFn, captured } = makeFactory()
  const msg = showUndoToast(messageFn, 'x')
  assert.equal(count('keydown'), 1, 'listeners installed while the toast is alive')
  assert.equal(count('keyup'), 1)
  assert.equal(typeof captured.opts.onClose, 'function', 'onClose registered on the message options')
  // Simulate the route-change destroy: EP invokes onClose, never close()
  captured.opts.onClose()
  assert.equal(count('keydown'), 0, 'keydown listener released after onClose (controller unregistered)')
  assert.equal(count('keyup'), 0, 'keyup listener released after onClose')
  // A late close() on the already-unregistered toast must not throw
  if (typeof msg.close === 'function') assert.doesNotThrow(() => msg.close())
  assert.equal(count('keydown'), 0, 'still released (idempotent)')
})

test('F4: both patched close and onClose firing still unregisters exactly once (idempotent)', () => {
  const { messageFn, captured } = makeFactory(true)
  const msg = showUndoToast(messageFn, 'y')
  assert.equal(count('keydown'), 1, 'listeners installed while the toast is alive')
  assert.equal(typeof msg.close, 'function', 'close() is patched onto the message instance')
  // Real-world sequence: EP fires close (✕ / auto-dismiss), then onClose after destroy
  msg.close()
  assert.equal(captured.baseCloseCalls, 1, 'patched close delegates to the base close exactly once')
  assert.equal(count('keydown'), 0, 'close() released the listeners')
  captured.opts.onClose()
  assert.equal(count('keydown'), 0, 'late onClose is a no-op — unregister is idempotent, never re-armed')
  assert.equal(captured.baseCloseCalls, 1, 'base close not re-invoked')
  assert.equal(count('keyup'), 0)
})
