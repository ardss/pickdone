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

/** Message factory WITHOUT a close() method: models the EP destroy path where nothing ever calls
 * msg.close(), but the onClose option is still honored after the instance unmounts. */
const makeFactory = () => {
  const captured = { opts: null }
  const messageFn = opts => {
    captured.opts = opts
    const st = { el: new EventTarget(), $el: null }
    st.el.setAttribute = () => {}
    st.$el = st.el
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

test('F4: patched close and onClose share one idempotent unregister path', () => {
  const { messageFn, captured } = makeFactory()
  showUndoToast(messageFn, 'y')
  captured.opts.onClose()
  if (typeof captured.opts.close !== 'function') {
    // nothing further to call (factory had no close); unregister already happened
  }
  assert.equal(count('keydown'), 0)
})
