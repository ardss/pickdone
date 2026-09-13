/**
 * TodoGroups fold behavior — MOUNTED component test (not source-string assertions).
 *
 * Regression for the 2026-09-09 incident: TodoGroups.toggle() added the fold key and
 * pruneExpiredFoldKeys immediately deleted it, so expired groups could never collapse.
 * The pure-function tests all stayed green because nothing executed the actual
 * "user clicks group header -> state survives in settings" chain.
 *
 * Skeleton: real Vue 3 + real Vuex 4 mounted into a jsdom document. The SFC script is
 * extracted from TodoGroups.vue, its two imports are replaced with test doubles
 * (TodoItem stub, the real dayjs UMD build), and the component is mounted for real.
 * Every assertion reads component state / store state after a toggle — never the source text.
 *
 * Run: node --test tests/unit/components/todogroups-fold-behavior.test.mjs
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SFC = path.join(ROOT, 'renderer/js/components/TodoGroups.vue')

let cleanupGlobals = () => {}
let dayjs

/** Minimal SFC loader: pull the <script lang="ts"> block, strip imports / TS casts,
 *  turn `export default` into a return value, inject dependency doubles. */
function loadTodoGroupsComponent () {
  const src = fs.readFileSync(SFC, 'utf8')
  const m = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  assert.ok(m, 'TodoGroups.vue: <script> block not found')
  const code = m[1]
    .replace(/^\s*import\s+TodoItem\s+from\s+'\.\/TodoItem\.vue'\s*$/m, '')
    .replace(/^\s*import\s*\{\s*dayjs\s*\}\s+from\s+'[^']+'\s*$/m, '')
    .replace(/\bas\s+any\b/g, '')
    .replace(/export\s+default\s*\{/, 'return {')
  const factory = new Function('TodoItem', 'dayjs', code)
  // TodoItem stub: the fold logic under test never touches row rendering
  return factory({ name: 'TodoItem', props: ['todo'], template: '<div class="todo-item-stub"></div>' }, dayjs)
}

before(() => {
  // Fresh jsdom as the renderer-ish environment (jsdom is already a devDependency)
  const { JSDOM } = require('jsdom')
  const dom = new JSDOM('<!doctype html><html><body><div id="host"></div></body></html>', { url: 'http://localhost/' })
  const w = dom.window
  const g = globalThis
  const setGlobal = (k, v) => {
    try { g[k] = v } catch { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }) }
  }
  for (const [k, v] of Object.entries({
    window: w, document: w.document, navigator: w.navigator,
    HTMLElement: w.HTMLElement, SVGElement: w.SVGElement, Element: w.Element, Node: w.Node,
    localStorage: w.localStorage,
    requestAnimationFrame: cb => setTimeout(() => cb(Date.now()), 0),
    cancelAnimationFrame: id => clearTimeout(id)
  })) setGlobal(k, v)
  cleanupGlobals = () => {
    for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'SVGElement', 'Element', 'Node', 'localStorage', 'requestAnimationFrame', 'cancelAnimationFrame']) {
      try { delete g[k] } catch { Object.defineProperty(g, k, { value: undefined, configurable: true }) }
    }
    dom.window.close()
  }

  // dayjs via plain CJS require — the same library the UMD bundle wraps, without the
  // vm-context load whose timing flaked under parallel test load (2026-09-13)
  dayjs = require('dayjs')
  assert.equal(typeof dayjs, 'function', 'dayjs failed to load')
})


after(() => { cleanupGlobals() })

function makeStore (Vue, Vuex, initialFolded = []) {
  const store = Vuex.createStore({
    state: { settings: { foldedTodoList: [...initialFolded] } },
    mutations: {
      'settings/updateSettings' (state, patch) { Object.assign(state.settings, patch) }
    }
  })
  return store
}

/** Mount TodoGroups with a group fixture and a real Vuex store; returns { vm, store } */
function mountTodoGroups (groups, initialFolded = []) {
  const Vue = require('vue')
  const Vuex = require('vuex')
  const Comp = loadTodoGroupsComponent()
  const store = makeStore(Vue, Vuex, initialFolded)
  const app = Vue.createApp(Comp)
  app.use(store)
  app.config.globalProperties.$t = (key, params) => key // i18n not needed for behavior
  const host = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(host)
  const vm = app.mount(host)
  return { vm, store, app, host }
}

const DAY = 86400000
const today0 = () => +dayjs().startOf('day')
const group = (key, extra = {}) => ({ key, label: key, todos: [{ taskId: 't-' + key, text: 'x', done: false }], ...extra })

/* ---------- Scenario 1: the incident itself — yesterday's expired group can collapse ---------- */

test('expired group from yesterday: toggle persists the fold key, second toggle re-expands', () => {
  const yKey = `expired-${today0() - DAY}`
  const { vm, store } = mountTodoGroups([group(yKey)])

  // user clicks the collapsed-target group header
  assert.equal(vm.isOpen(yKey), true, 'group starts expanded')
  vm.toggle(yKey)

  // THE bug: the key must SURVIVE the prune that runs inside toggle
  const afterFold = store.state.settings.foldedTodoList
  assert.ok(afterFold.includes(yKey), `fold key must survive in settings.foldedTodoList, got ${JSON.stringify(afterFold)}`)
  assert.equal(vm.isOpen(yKey), false, 'group must read back as collapsed after toggle')

  // and clicking again re-expands (round trip)
  vm.toggle(yKey)
  assert.equal(store.state.settings.foldedTodoList.includes(yKey), false, 'fold key removed after second toggle')
  assert.equal(vm.isOpen(yKey), true, 'group re-expanded')
})

/* ---------- Scenario 2: normal (today) group round trip ---------- */

test('today group: collapse/expand round trip via store state', () => {
  const key = 'today'
  const { vm, store } = mountTodoGroups([group(key)])

  vm.toggle(key)
  assert.ok(store.state.settings.foldedTodoList.includes(key), 'today key persisted when folded')
  assert.equal(vm.isOpen(key), false)

  vm.toggle(key)
  assert.equal(store.state.settings.foldedTodoList.includes(key), false, 'today key removed when expanded')
  assert.equal(vm.isOpen(key), true)
})

/* ---------- Scenario 3: anti-accumulation — keys older than the 7-day grace window are pruned ---------- */

test('prune still runs: an 8-day-old expired key is dropped on the next toggle', () => {
  const ancientKey = `expired-${today0() - 8 * DAY}`
  const key = 'today'
  // seed settings with a stale key from 8 days ago, then fold a live group
  const { vm, store } = mountTodoGroups([group(key)], [ancientKey])

  assert.ok(store.state.settings.foldedTodoList.includes(ancientKey), 'precondition: stale key seeded')
  vm.toggle(key)

  const after = store.state.settings.foldedTodoList
  assert.ok(after.includes(key), 'new fold key written')
  assert.equal(after.includes(ancientKey), false, 'stale >7-day key pruned by the same toggle (settings do not grow unbounded)')
})
