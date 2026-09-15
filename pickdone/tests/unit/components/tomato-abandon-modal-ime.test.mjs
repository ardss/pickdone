/**
 * TomatoAbandonModal IME Enter guard — behavior regression test.
 *
 * Bug: @keydown.enter.prevent="confirmAbandon" fired while an IME composition was
 * being committed (keyCode 229 / isComposing), instantly abandoning the focus
 * session when the user typed a Chinese reason and pressed Enter to commit text.
 *
 * Fix: onReasonEnter guards `e.isComposing || e.keyCode === 229` (same pattern as
 * QuickAdd.vue) before calling confirmAbandon.
 *
 * The synthetic events here are real jsdom KeyboardEvents dispatched with
 * isComposing/keyCode patched on (jsdom's KeyboardEventInit does not carry them),
 * exercising the same handler the template binds.
 *
 * Run: node --test tests/unit/components/tomato-abandon-modal-ime.test.mjs
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SFC = path.join(ROOT, 'renderer/js/components/TomatoAbandonModal.vue')

let cleanupGlobals = () => {}

function loadComponent () {
  const src = fs.readFileSync(SFC, 'utf8')
  const m = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  assert.ok(m, 'TomatoAbandonModal.vue: <script> block not found')
  const code = m[1]
    .replace(/^\s*import\s+dialogA11y\s+from\s+'[^']+'\s*$/m, '')
    .replace(/\bas\s+any\b/g, '')
    .replace(/export\s+default\s*\{/, 'return {')
  const factory = new Function('dialogA11y', code)
  return factory({}) // a11y mixin not needed for the guard behavior
}

before(() => {
  const { JSDOM } = require('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
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

/** jsdom KeyboardEvent with isComposing/keyCode patched on (matching real IME Enter) */
function imeEnter ({ isComposing, keyCode }) {
  const ev = new globalThis.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'isComposing', { value: isComposing })
  Object.defineProperty(ev, 'keyCode', { value: keyCode })
  return ev
}

test('IME composition Enter (keyCode 229 / isComposing) does NOT confirm the abandon', () => {
  const { vm, calls } = mount()
  vm.onReasonEnter(imeEnter({ isComposing: true, keyCode: 229 }))
  vm.onReasonEnter(imeEnter({ isComposing: false, keyCode: 229 }))
  vm.onReasonEnter(imeEnter({ isComposing: true, keyCode: 13 }))
  assert.equal(calls.giveUp, 0, 'composition-commit Enter must not dispatch tomato/giveUp')
  assert.equal(calls.close, 0, 'composition-commit Enter must not close the modal')
})

test('a plain (non-IME) Enter still confirms the abandon', () => {
  const { vm, calls } = mount()
  vm.onReasonEnter(imeEnter({ isComposing: false, keyCode: 13 }))
  assert.equal(calls.giveUp, 1, 'plain Enter dispatches tomato/giveUp')
  assert.equal(calls.close, 1, 'plain Enter closes the modal')
})

test('template binds the guarded handler on the reason input (wiring check)', () => {
  const src = fs.readFileSync(SFC, 'utf8')
  assert.match(src, /abandon-reason-input[^>]*@keydown\.enter\.prevent="onReasonEnter"/, 'input must bind onReasonEnter')
})
