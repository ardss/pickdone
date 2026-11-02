/* w29 P2/P3 regression: Esc guards on abandon/rename inputs.
 *
 * P2 — TomatoAbandonModal: the root @keydown.esc closed the whole abandon (cancelled the
 * give-up) even while the reason input was focused and an IME composition was being cancelled
 * (isComposing / keyCode 229) — pressing Esc to dismiss the candidate window silently cancelled
 * the abandon. Fix: guarded onEsc; Esc inside a NON-empty reason input clears the text instead
 * of closing (second Esc on the empty input still cancels).
 *
 * P3 — SnManageCategoriesModal: the rename input's @keydown.esc lacked the IME guard its
 * sibling Enter binding already had — an IME-cancel Esc cancelled the rename mid-composition.
 * Fix: same `isComposing || keyCode === 229` guard shape as the Enter binding.
 *
 * Run: node --test tests/unit/components/w29-esc-ime-guard.test.mjs
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { focusedMinutesText } = await import('../../../renderer/js/utils/tomatoShared.js')

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SFC = path.join(ROOT, 'renderer/js/components/TomatoAbandonModal.vue')
const SN_SFC = path.join(ROOT, 'renderer/js/components/side-nav/SnManageCategoriesModal.vue')

let cleanupGlobals = () => {}

function loadComponent () {
  const src = fs.readFileSync(SFC, 'utf8')
  const m = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  assert.ok(m, 'TomatoAbandonModal.vue: <script> block not found')
  const code = m[1]
    .replace(/^\s*import\s+[^;]+?from\s+'[^']+'\s*$/mg, '')
    .replace(/\bas\s+any\b/g, '')
    .replace(/export\s+default\s*\{/, 'return {')
  const factory = new Function('dialogA11y', 'focusedMinutesText', code)
  return factory({}, focusedMinutesText)
}

before(() => {
  const { JSDOM } = require('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></body></html>'.replace('</body></body>', '</body>'), { url: 'http://localhost/' })
  const w = dom.window
  const g = globalThis
  const setGlobal = (k, v) => {
    try { g[k] = v } catch { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }) }
  }
  for (const [k, v] of Object.entries({
    window: w, document: w.document, navigator: w.navigator,
    HTMLElement: w.HTMLElement, SVGElement: w.SVGElement, Element: w.Element, Node: w.Node,
    CustomEvent: w.CustomEvent, KeyboardEvent: w.KeyboardEvent
  })) setGlobal(k, v)
  cleanupGlobals = () => {
    for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'SVGElement', 'Element', 'Node', 'CustomEvent', 'KeyboardEvent']) {
      try { delete g[k] } catch { Object.defineProperty(g, k, { value: undefined, configurable: true }) }
    }
    dom.window.close()
  }
})

after(() => { cleanupGlobals() })

function mount () {
  const Vue = require('vue')
  const Vuex = require('vuex')
  const Comp = loadComponent()
  const calls = { giveUp: 0, close: 0 }
  const store = Vuex.createStore({
    state: { tomato: { startedAt: Date.now() - 5 * 60000 }, ui: {} },
    actions: { 'tomato/giveUp': () => { calls.giveUp++ } },
    mutations: { 'ui/closeTomatoAbandon': () => { calls.close++ } }
  })
  const app = Vue.createApp(Comp)
  app.use(store)
  app.config.globalProperties.$t = (key) => key
  app.config.globalProperties.$announce = () => {}
  const host = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(host)
  const vm = app.mount(host)
  return { vm, calls }
}

/** jsdom KeyboardEvent with isComposing/keyCode patched on (matching real IME Esc) */
function escEvent ({ isComposing, keyCode, target }) {
  const ev = new globalThis.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'isComposing', { value: isComposing })
  Object.defineProperty(ev, 'keyCode', { value: keyCode })
  if (target) Object.defineProperty(ev, 'target', { value: target })
  return ev
}

test('P2: IME composition Esc (keyCode 229 / isComposing) does NOT cancel the abandon', () => {
  const { vm, calls } = mount()
  vm.onEsc(escEvent({ isComposing: true, keyCode: 229 }))
  vm.onEsc(escEvent({ isComposing: false, keyCode: 229 }))
  vm.onEsc(escEvent({ isComposing: true, keyCode: 27 }))
  assert.equal(calls.close, 0, 'IME-cancel Esc must not close the modal / cancel the abandon')
})

test('P2: Esc inside the reason input with typed text CLEARS the reason and keeps the modal open', () => {
  const { vm, calls } = mount()
  const input = globalThis.document.createElement('input')
  input.className = 'abandon-reason-input'
  vm.reason = '打字中'
  vm.onEsc(escEvent({ isComposing: false, keyCode: 27, target: input }))
  assert.equal(vm.reason, '', 'Esc in a non-empty reason input clears the text')
  assert.equal(calls.close, 0, 'the abandon stays open after the clear')
})

test('P2: Esc inside an EMPTY reason input cancels (second-Esc exit path)', () => {
  const { vm, calls } = mount()
  const input = globalThis.document.createElement('input')
  input.className = 'abandon-reason-input'
  vm.reason = ''
  vm.onEsc(escEvent({ isComposing: false, keyCode: 27, target: input }))
  assert.equal(calls.close, 1, 'empty-input Esc still cancels the abandon')
})

test('P2: a plain Esc outside the input still cancels the abandon', () => {
  const { vm, calls } = mount()
  const root = globalThis.document.createElement('div')
  vm.onEsc(escEvent({ isComposing: false, keyCode: 27, target: root }))
  assert.equal(calls.close, 1, 'plain Esc closes the modal')
})

test('P2: template wires the guarded onEsc on the modal root (was: bare cancelAbandon)', () => {
  const src = fs.readFileSync(SFC, 'utf8')
  assert.match(src, /@keydown\.esc="onEsc"/, 'root must bind onEsc, not cancelAbandon')
})

test('P3: SnManageCategoriesModal rename-input Esc carries the IME guard (same shape as its Enter)', () => {
  const src = fs.readFileSync(SN_SFC, 'utf8')
  const escLine = src.split('\n').find(l => l.includes('@keydown.esc') && l.includes('cancelMgrEdit'))
  assert.ok(escLine, 'esc binding on the rename input not found')
  assert.match(escLine, /isComposing \|\| e\.keyCode === 229/, 'Esc must be guarded for IME composition')
})
