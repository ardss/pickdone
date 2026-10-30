/**
 * W20 (P2) — CalendarView fcEl delegate listeners survive the timeblock view swap.
 *
 * The keydown (keyboard task create) and click-capture (day expand/+ buttons) delegates used to
 * be attached ONCE in mounted() to whatever $refs.fcEl existed then. When the initial view was
 * 'timeblock' (route query/localStorage), the v-if swapped in a different fcEl afterwards and the
 * handlers stayed on the discarded element — keyboard task creation and the expand buttons were
 * dead for the whole session even after switching back to month/week (renderCalendar only
 * re-attached the ResizeObserver).
 *
 * Fix: bindFcElDelegates() — unbind from the previously bound element, bind to the CURRENT fcEl;
 * called from renderCalendar (which runs on every v-if rebuild) and from mounted.
 *
 * Tests: source anchors + a behavioral test that EXTRACTS the real bindFcElDelegates method body
 * from the .vue source and drives it against fake elements.
 *
 * Run: node --test tests/unit/renderer/w20-calendar-fcel-rebind.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const SRC = readFileSync(new URL('../../../renderer/js/views/CalendarView.vue', import.meta.url), 'utf8')

/** Extract a method's full source text by name (object-literal method, brace-balanced). */
function extractMethod (name) {
  const start = SRC.indexOf(`    ${name} (` )
  assert.ok(start !== -1, `method ${name} exists in CalendarView.vue`)
  const bodyStart = SRC.indexOf('{', start)
  let depth = 0
  for (let i = bodyStart; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++
    else if (SRC[i] === '}') { depth--; if (depth === 0) return SRC.slice(start, i + 1) }
  }
  throw new Error(`unbalanced braces extracting ${name}`)
}

function fakeEl () {
  const el = {
    keydown: [], clickCapture: [], clickBubble: [],
    addEventListener (type, fn, capture) {
      if (type === 'keydown') this.keydown.push(fn)
      else if (type === 'click') (capture ? this.clickCapture : this.clickBubble).push(fn)
    },
    removeEventListener (type, fn, capture) {
      const arr = type === 'keydown' ? this.keydown : (capture ? this.clickCapture : this.clickBubble)
      const i = arr.indexOf(fn)
      if (i !== -1) arr.splice(i, 1)
    }
  }
  return el
}

test('W20 source anchors: delegates are rebound in renderCalendar, not attached once in mounted', () => {
  const bind = extractMethod('bindFcElDelegates')
  // unbind-then-bind against the recorded element
  assert.match(bind, /removeEventListener\('keydown', this\._onKey\)/)
  assert.match(bind, /removeEventListener\('click', this\._onExpandClick, true\)/)
  assert.match(bind, /addEventListener\('keydown', this\._onKey\)/)
  assert.match(bind, /addEventListener\('click', this\._onExpandClick, true\)/)
  assert.match(bind, /this\._fcElBound = el/)

  const render = extractMethod('renderCalendar')
  assert.match(render, /bindFcElDelegates\(\)/,
    'renderCalendar must rebind delegates (it runs on every v-if fcEl rebuild)')

  // mounted defines both handlers then binds via the shared helper (bind call comes after both
  // handler definitions inside mounted) — no direct one-off attach
  const mounted = SRC.slice(SRC.indexOf('mounted ()'), SRC.indexOf('watch: {'))
  assert.ok(mounted.indexOf('this._onExpandClick = (e) => {') !== -1)
  assert.ok(mounted.indexOf('this.bindFcElDelegates()') > mounted.indexOf('this._onExpandClick = (e) => {'))
  assert.equal((mounted.match(/this\.bindFcElDelegates\(\)/g) || []).length, 1)
  assert.doesNotMatch(SRC, /\$refs\.fcEl\.addEventListener\('keydown'/,
    'mounted must not one-off-attach keydown to the then-current fcEl')
  assert.doesNotMatch(SRC, /\$refs\.fcEl\.addEventListener\('click', this\._onExpandClick/)

  // beforeUnmount tolerates the handlers living on an older swapped-out element
  const unmount = SRC.slice(SRC.indexOf('beforeUnmount ()'))
  assert.match(unmount, /this\._fcElBound \|\| this\.\$refs\.fcEl/)
})

test('W20 behavior: bindFcElDelegates (real source) rebinds both handlers to the new fcEl', () => {
  const bind = extractMethod('bindFcElDelegates')
  // eslint-disable-next-line no-new-func
  const bindFn = new Function(`return function bindFcElDelegates () { ${bind.slice(bind.indexOf('{') + 1, bind.lastIndexOf('}'))} }`)()

  const elA = fakeEl()
  const elB = fakeEl()
  const vm = { $refs: { fcEl: elA }, _onKey: function K () {}, _onExpandClick: function C () {} }

  // First bind (mounted-equivalent)
  bindFn.call(vm)
  assert.equal(vm._fcElBound, elA)
  assert.deepEqual(elA.keydown, [vm._onKey])
  assert.deepEqual(elA.clickCapture, [vm._onExpandClick])

  // v-if swap: renderCalendar now sees a NEW element
  vm.$refs.fcEl = elB
  bindFn.call(vm)
  assert.equal(vm._fcElBound, elB, 'binding recorded on the new element')
  assert.deepEqual(elA.keydown, [], 'old element fully unbound (keydown)')
  assert.deepEqual(elA.clickCapture, [], 'old element fully unbound (click capture)')
  assert.deepEqual(elB.keydown, [vm._onKey], 'new element carries keydown delegate')
  assert.deepEqual(elB.clickCapture, [vm._onExpandClick], 'new element carries click-capture delegate')

  // Idempotent: rebinding against the same element must not stack duplicates
  bindFn.call(vm)
  assert.equal(elB.keydown.length, 1)
  assert.equal(elB.clickCapture.length, 1)
})

test('W20 behavior: bindFcElDelegates is a no-op when fcEl is absent (timeblock view)', () => {
  const bind = extractMethod('bindFcElDelegates')
  const bindFn = new Function(`return function () { ${bind.slice(bind.indexOf('{') + 1, bind.lastIndexOf('}'))} }`)()
  const vm = { $refs: { fcEl: null }, _onKey: function K () {}, _onExpandClick: function C () {} }
  assert.doesNotThrow(() => bindFn.call(vm))
  assert.equal(vm._fcElBound, undefined)
})
