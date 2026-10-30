/**
 * [J3 2026-10-22] 待办箱 "按截止日期" honesty fix — RED-first pins.
 *
 * Live finding (journey-audit J3): the todo box only ever holds UNDATED rows (dayStart 0, and
 * DB hydration derives dayStart from todoTime, so clean box rows have todoTime 0 too). The
 * 'due' comparator therefore falls back to createTime for the entire normal population — the
 * option is a silently duplicated 按创建时间, and "deadline" is a concept that cannot apply to
 * an undated collection. Fix: the option is removed from the box view; a legacy persisted
 * todoBoxSortMethod 'due' sorts as created (label falls back to 按创建时间, not the raw key).
 *
 * Run: node --test tests/unit/components/j3-box-due-sort-honesty.test.mjs
 */
import '../../setup.mjs'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const BOX_SFC = path.join(ROOT, 'renderer/js/views/TodoBoxView.vue')

let cleanupGlobals = () => {}

function loadScript (sfcPath, deps) {
  const src = fs.readFileSync(sfcPath, 'utf8')
  const m = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  assert.ok(m, sfcPath + ': <script> block not found')
  const code = m[1]
    .replace(/^\s*import\s+[^]+?$/gm, '')
    .replace(/\bas\s+any\b/g, '')
    .replace(/\bas\s+[A-Za-z_$][\w$]*(?:\.[\w$]+)*\b/g, '')
    .replace(/:\s*any(?=[\s,)\]=;])/g, '')
    .replace(/export\s+default\s*\{/, 'return {')
  const names = Object.keys(deps)
  const prelude = names.map(n => `const ${n} = deps[${JSON.stringify(n)}]`).join('\n')
  return new Function('deps', prelude + '\n' + code)(deps)
}

before(() => {
  const { JSDOM } = require('jsdom')
  const g = globalThis
  const prev = g.window || {}
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const w = dom.window
  for (const k of ['dayjs', 'pinyinPro', 'VueI18n', 'localStorage']) {
    if (prev[k] != null) { try { w[k] = prev[k] } catch { /* read-only on the dom window */ } }
  }
  const setGlobal = (k, v) => {
    try { g[k] = v } catch { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }) }
  }
  for (const [k, v] of Object.entries({
    window: w, document: w.document, navigator: w.navigator,
    HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node, SVGElement: w.SVGElement,
    CustomEvent: w.CustomEvent, KeyboardEvent: w.KeyboardEvent
  })) setGlobal(k, v)
  cleanupGlobals = () => {
    for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'CustomEvent', 'KeyboardEvent']) {
      try { delete g[k] } catch { Object.defineProperty(g, k, { value: undefined, configurable: true }) }
    }
    dom.window.close()
  }
})

after(() => { cleanupGlobals() })

function buildHarness (sortMethod) {
  const state = {
    todo: { todoList: [], initError: null },
    settings: { todoBoxSortMethod: sortMethod, todoBoxSortOrder: 'desc', todoBoxCategoryId: -1 },
    ui: { rightSidebarTodoEdit: false },
    category: { list: [] }
  }
  const deps = {
    taskContextMenu: () => {},
    DEFAULT_CAT_COLOR: '#bfbfbf',
    toggleCompleteWithUndo: () => {},
    batchMoveWithUndo: () => {},
    isRepeatTask: () => false,
    getEstimate: () => 0,
    estimateTier: () => 0,
    crossDayMovePatch: () => ({}),
    crossDayRevertPatch: () => ({}),
    EmptyState: { render: () => null },
    roleButtonActivate: fn => fn,
    roleCheckboxActivate: fn => fn
  }
  return { state, deps }
}

function mountBox ({ state, deps }) {
  const Comp = loadScript(BOX_SFC, deps)
  const Vue = require('vue')
  const store = { state, getters: {}, async dispatch () { return null }, commit () {} }
  const app = Vue.createApp(Comp)
  const props = {
    $t: (key) => key, // label keys asserted verbatim
    $announce: () => {},
    $message: { success () {}, error () {}, warning () {}, closeAll () {} },
    $route: { name: 'todo-list-todo-box', params: {} },
    $store: store
  }
  for (const [k, v] of Object.entries(props)) app.config.globalProperties[k] = v
  const host = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(host)
  return app.mount(host)
}

test('j3: the box sort dropdown no longer offers 按截止日期 (undated rows have no due to sort by)', () => {
  const h = buildHarness('created')
  const vm = mountBox(h)
  const values = vm.sortMethodOptions.map(o => o.value)
  assert.deepEqual(values, ['created', 'difficulty'],
    "the box holds only undated rows — a 'due' option duplicates 按创建时间 and must not be offered")
})

test('j3: a legacy persisted todoBoxSortMethod "due" labels as 按创建时间, not the raw key', () => {
  const h = buildHarness('due')
  const vm = mountBox(h)
  assert.equal(vm.sortMethodLabel, 'statsC.TodoBox.sortByCreate',
    "a persisted 'due' must not leak the raw key into the closed dropdown trigger")
})

test('j3: legacy persisted "due" sorts the box by createTime (created contract)', async () => {
  const todo = (await import('../../../renderer/js/store/todo.js')).default
  const settings = (await import('../../../renderer/js/store/settings.js')).default
  const T = over => ({
    taskId: 't' + Math.random().toString(36).slice(2),
    taskContent: '任务', dayStart: 0, todoTime: 0, createTime: Date.now(),
    updateTime: Date.now(), complete: false, delete: false, taskSort: 0,
    ...over
  })
  const todoState = {
    todoList: [
      T({ taskId: 'd2', todoTime: 200, createTime: 1 }),
      T({ taskId: 'd1', todoTime: 300, createTime: 2 }),
      T({ taskId: 'd3', todoTime: 100, createTime: 3 })
    ],
    recycleList: [], undoStack: [], redoStack: [], viewsDirty: true
  }
  const committed = []
  const ctx = {
    commit (n, p) { committed.push([n, p]); if (n === 'upsertLocal') todo.mutations.upsertLocal(todoState, p) },
    state: { todo: todoState, todoList: todoState.todoList, recycleList: todoState.recycleList },
    rootState: { settings: { ...settings.state, recycleBinAutoDeleteDays: 30, todoBoxCategoryId: -1, todoBoxSortMethod: 'due', todoBoxSortOrder: 'asc' } }
  }
  ctx.dispatch = async () => {}
  const fakeThis = { state: { todo: todoState } }
  todo.actions.computeViews.call(fakeThis, ctx)
  const v = committed.filter(([n]) => n === 'setViews').pop()[1]
  const byCreated = v.todoBox.map(t => t.createTime)
  assert.deepEqual(byCreated, [...byCreated].sort((a, b) => a - b),
    "legacy 'due' must sort by createTime (the created contract) — the old case honored orphaned drifted todoTime that DB hydration never produces")
})
