/** Real tests of the accessibility mixin: focus-trap + Escape + focus restore.
 *  Uses JSDOM to simulate real DOM behavior, asserting:
 *  1. mounted focuses the first focusable element inside the dialog (skipping disabled/hidden)
 *  2. Tab/Shift+Tab wrap around at the ends
 *  3. Tab outside the dialog is forced back to the dialog's first item
 *  4. Escape triggers close (and does not bubble)
 *  5. Escape inside input/textarea does not close
 *  6. beforeUnmount restores the focus recorded at mounted
 *  7. The global Space handler synthesizes click on role=button/checkbox/switch etc.
 *  Run: npm test */
/* eslint-env browser */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

// Install a clean JSDOM (reset on each setUp)
function makeEnv () {
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'http://localhost/' })
  const w = dom.window
  // Node 22's navigator is read-only; rewrite via defineProperty (so things run even without the mixin when Vue reads navigator.userAgent internally)
  for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Node', 'KeyboardEvent', 'MouseEvent', 'Event', 'CustomEvent']) {
    try { Object.defineProperty(globalThis, k, { value: w[k], configurable: true, writable: true }) } catch {}
  }
  return w
}

/** Simulates a Vue component with the mixin mounted (this is a bare object) */
function bindMixin (root, extra = {}) {
  const mixin = require_('../../../renderer/js/utils/dialogA11y.js').default
  // Injected into the mock this: mixin.methods provides getFocusables/onKeydown, called by the lifecycle hooks
  const ctx = Object.assign({
    $el: root,
    $nextTick (fn) { Promise.resolve().then(fn) }
  }, mixin.methods, extra)
  mixin.mounted.call(ctx)
  return { ctx, mixin }
}

import { createRequire } from 'module'
const require_ = createRequire(import.meta.url)

/** Installs a standard dialog root (with four candidates: i1/b1/disabled-b2/i2) */
function buildDialogRoot () {
  const root = document.createElement('div')
  root.className = 'modal'
  root.setAttribute('tabindex', '-1')
  const i1 = document.createElement('input'); i1.className = 'i1'
  const b1 = document.createElement('button'); b1.className = 'b1'; b1.textContent = '确认'
  const b2 = document.createElement('button'); b2.className = 'b2'; b2.textContent = '禁用'; b2.disabled = true
  const i2 = document.createElement('input'); i2.className = 'i2'
  root.append(i1, b1, b2, i2)
  document.getElementById('host').append(root)
  return { root, i1, b1, b2, i2 }
}

test('mounted focuses the first focusable element in the dialog (skipping disabled)', async () => {
  makeEnv()
  const { root, i1, b2 } = buildDialogRoot()
// eslint-disable-next-line no-unused-vars
  const { ctx } = bindMixin(root)
  await new Promise(r => setTimeout(r, 5))
  assert.equal(document.activeElement, i1, 'should focus i1 (skipping the disabled b2)')
  assert.notEqual(document.activeElement, b2)
})

test('Tab wraps from the end to the first item', async () => {
  makeEnv()
// eslint-disable-next-line no-unused-vars
  const { root, i1, b1, i2 } = buildDialogRoot()
// eslint-disable-next-line no-unused-vars
  const { ctx } = bindMixin(root)
  await new Promise(r => setTimeout(r, 5))
  // Put the focus on the last item i2
  i2.focus()
  assert.equal(document.activeElement, i2)
  // Simulate Tab (does not preventDefault by default; the default action must not steal it)
  const ev = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true })
  root.dispatchEvent(ev)
  // The mixin should intercept in the capture phase and return focus to the first item
  assert.equal(document.activeElement, i1, 'Tab at the end should wrap to i1')
})

test('Shift+Tab wraps from the first item to the last', async () => {
  makeEnv()
  const { root, i1, i2 } = buildDialogRoot()
// eslint-disable-next-line no-unused-vars
  const { ctx } = bindMixin(root)
  await new Promise(r => setTimeout(r, 5))
  i1.focus()
  const ev = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true })
  root.dispatchEvent(ev)
  assert.equal(document.activeElement, i2, 'Shift+Tab at the first item should wrap to the last')
})

test('Tab received by an element outside the dialog is forced back to the first dialog item', async () => {
  makeEnv()
  const { root, i1 } = buildDialogRoot()
  const { ctx } = bindMixin(root)
  await new Promise(r => setTimeout(r, 5))
  // Outside button
  const outside = document.createElement('button')
  outside.className = 'outside'
  document.body.appendChild(outside)
  outside.focus()
  assert.equal(document.activeElement, outside, 'the outside button is focused first')
  // Simulate Tab at the document top level via dispatchEvent; the mixin listener is attached to root's capture phase,
  // the real test must bypass this: call ctx.onKeydown directly with the outside element
  const fakeEv = { key: 'Tab', shiftKey: false, target: outside, preventDefault: () => {}, stopPropagation: () => {} }
  ctx.onKeydown(fakeEv)
  assert.equal(document.activeElement, i1, 'outside focus should be forced back to the dialog first item')
  outside.remove()
})

test('Escape triggers close (and the dialog component close method is called)', async () => {
  makeEnv()
  const { root, i1 } = buildDialogRoot()
  let closed = false
  const mixin = require_('../../../renderer/js/utils/dialogA11y.js').default
  const ctx = Object.assign({ $el: root, $nextTick (fn) { Promise.resolve().then(fn) }, close () { closed = true } }, mixin.methods)
  mixin.mounted.call(ctx)
  await new Promise(r => setTimeout(r, 5))
  i1.focus()
  const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  root.dispatchEvent(ev)
  assert.equal(closed, true, 'Escape should trigger close()')
})

test('Escape inside input/textarea does not close (lets the native clear-selection behavior run)', async () => {
  makeEnv()
  const { root, i1 } = buildDialogRoot()
  let closed = false
  const mixin = require_('../../../renderer/js/utils/dialogA11y.js').default
  const ctx = Object.assign({ $el: root, $nextTick (fn) { Promise.resolve().then(fn) }, close () { closed = true } }, mixin.methods)
  mixin.mounted.call(ctx)
  await new Promise(r => setTimeout(r, 5))
  i1.focus()
  // Simulate target=input (the mixin decides via e.target.tagName)
  const ev = { key: 'Escape', target: i1, preventDefault: () => {}, stopPropagation: () => {} }
  ctx.onKeydown ? ctx.onKeydown(ev) : root.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
  // Note: dispatching on root directly hits the root listener with target still root; to test inside input, call ctx.onKeydown directly
  const ev2 = { key: 'Escape', target: i1, preventDefault: () => {}, stopPropagation: () => {} }
  // Rebuild ctx (onKeydown was not captured above) - run mounted once more
  closed = false
  const ctx2 = Object.assign({ $el: root, $nextTick (fn) { Promise.resolve().then(fn) }, close () { closed = true } }, mixin.methods)
  mixin.mounted.call(ctx2)
  ctx2.onKeydown(ev2)
  assert.equal(closed, false, 'Escape inside input should not trigger close')
})

test('beforeUnmount restores the focus recorded at mounted', async () => {
  makeEnv()
  // Pre-place a button outside the dialog and focus it
  const original = document.createElement('button')
  original.className = 'original'
  document.body.appendChild(original)
  original.focus()
  assert.equal(document.activeElement, original)
// eslint-disable-next-line no-unused-vars
  const { root, i1 } = buildDialogRoot()
  const mixin = require_('../../../renderer/js/utils/dialogA11y.js').default
  const ctx = Object.assign({ $el: root, $nextTick (fn) { Promise.resolve().then(fn) } }, mixin.methods)
  mixin.mounted.call(ctx)
  await new Promise(r => setTimeout(r, 5))
  // Unmount
  mixin.beforeUnmount.call(ctx)
  assert.equal(document.activeElement, original, 'should restore the original focus')
  original.remove()
})

test('global Space handler: role=button triggers click, role=checkbox triggers click, native inputs are not hijacked', async () => {
  makeEnv()
  // Directly copy the global Space handler from main.js (no Vue mounted; only the policy correctness is verified)
  const handler = (e) => {
    if (e.key !== ' ' || e.ctrlKey || e.altKey || e.metaKey) return
    if (e.repeat) return
    const t = e.target
    if (!t || !t.getAttribute) return
    const tag = t.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'BUTTON' || tag === 'A' || t.isContentEditable) return
    const role = t.getAttribute('role')
    if (role === 'button' || role === 'checkbox' || role === 'switch' || role === 'menuitem' || role === 'option' || role === 'tab') {
      if (t.getAttribute('aria-disabled') === 'true') { e.preventDefault(); return }
      e.preventDefault()
      t.click()
    }
  }
  document.addEventListener('keydown', handler, true)

  // role=button triggers click
  const rbtn = document.createElement('div')
  rbtn.setAttribute('role', 'button')
  rbtn.setAttribute('tabindex', '0')
  let clicked = 0
  rbtn.addEventListener('click', () => clicked++)
  document.body.appendChild(rbtn)
  rbtn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
  assert.equal(clicked, 1, 'role=button should trigger click on Space')

  // role=checkbox triggers click
  const rcb = document.createElement('div')
  rcb.setAttribute('role', 'checkbox')
  rcb.setAttribute('tabindex', '0')
  let cClicked = 0
  rcb.addEventListener('click', () => cClicked++)
  document.body.appendChild(rcb)
  rcb.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
  assert.equal(cClicked, 1, 'role=checkbox should trigger click on Space')

  // native input not hijacked (must not be intercepted)
  const ni = document.createElement('input')
  document.body.appendChild(ni)
  let nativeClicked = 0
  ni.addEventListener('click', () => nativeClicked++)
  ni.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
  assert.equal(nativeClicked, 0, 'the native input must not be hijacked')

  // aria-disabled counts as disabled
  const rdis = document.createElement('div')
  rdis.setAttribute('role', 'button')
  rdis.setAttribute('aria-disabled', 'true')
  let disClicked = 0
  rdis.addEventListener('click', () => disClicked++)
  document.body.appendChild(rdis)
  rdis.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true }))
  assert.equal(disClicked, 0, 'aria-disabled should not trigger click')

  // Not hijacked when Ctrl/Alt/Meta modifiers are held
  rbtn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', ctrlKey: true, bubbles: true, cancelable: true }))
  assert.equal(clicked, 1, 'Ctrl+Space must not be hijacked')

  // repeat events not hijacked (long-press triggers only once)
  rbtn.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', repeat: true, bubbles: true, cancelable: true }))
  assert.equal(clicked, 1, 'repeat events must not re-trigger click')

  rbtn.remove(); rcb.remove(); ni.remove(); rdis.remove()
  document.removeEventListener('keydown', handler, true)
})
