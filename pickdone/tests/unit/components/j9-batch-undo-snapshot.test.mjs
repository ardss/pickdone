/**
 * [J9 batch-undo fix 2026-10-22] TodoBoxView batch ops must snapshot the UNDO values BEFORE the
 * awaited dispatch.
 *
 * Defect (live-verified, docs/journey-findings/todo-loop-auditor.md [J10]): batchToday/batchCat
 * read the snapshot off the LIVE store row AFTER `await updateTodoFields` — but updateTodoFields's
 * upsertLocal mutates that row in place (Object.assign), so the snapshot recorded the NEW values
 * and the undo toast re-applied the move: a silent no-op, persisting through a page reload.
 * utils/core.js rescheduleExpired (snapshot BEFORE dispatch) is the in-repo correct shape.
 *
 * Harness: same extract+strip SFC loader as d4-views-interaction-round.test.mjs. The fake store's
 * updateTodoFields mimics upsertLocal's in-place merge — that in-place semantic IS the regression
 * this test pins. batchMoveWithUndo is stubbed to capture {snap, revertOf} so the test drives the
 * real revert closure against the fake store.
 *
 * Run: node --test tests/unit/components/j9-batch-undo-snapshot.test.mjs
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
    // TodoBoxView carries general TS casts too (tbTriggerKey: `e.currentTarget as HTMLElement`);
    // a bare `as` identifier only exists as a TS assertion in this codebase (English comments
    // keep working — stripping a word inside a comment cannot break syntax)
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

function buildHarness () {
  const TODAY0 = Number(new Date(new Date().toDateString()).getTime()) // local midnight, like window.dayjs().startOf('day')
  const state = {
    todo: { todoList: [], initError: null },
    settings: { todoBoxSortMethod: 'created', todoBoxSortOrder: 'desc', todoBoxCategoryId: -1 },
    ui: { rightSidebarTodoEdit: false },
    category: { list: [{ categoryId: 100001, categoryName: '工作', categoryColor: '#4076C4', delete: false }] }
  }
  const captured = []
  const deps = {
    taskContextMenu: () => {},
    DEFAULT_CAT_COLOR: '#bfbfbf',
    toggleCompleteWithUndo: () => {},
    // capture instead of toast: the defect IS what lands in snap / what revertOf writes back
    batchMoveWithUndo: (vm, opts) => { captured.push(opts) },
    isRepeatTask: () => false,
    getEstimate: () => 0,
    estimateTier: () => 0,
    crossDayMovePatch: undefined, // filled below with the REAL module functions
    crossDayRevertPatch: undefined,
    EmptyState: { render: () => null },
    roleButtonActivate: fn => fn,
    roleCheckboxActivate: fn => fn
  }
  return { TODAY0, state, captured, deps }
}

async function mountBox ({ state, deps }) {
  const crossDay = await import('../../../renderer/js/utils/crossDayMove.js')
  const core = await import('../../../renderer/js/utils/core.js')
  deps.crossDayMovePatch = crossDay.crossDayMovePatch
  deps.crossDayRevertPatch = crossDay.crossDayRevertPatch
  deps.DEFAULT_CAT_COLOR = core.DEFAULT_CAT_COLOR
  const Comp = loadScript(BOX_SFC, deps)
  const Vue = require('vue')
  // fake store: updateTodoFields mimics the REAL upsertLocal in-place Object.assign — the
  // in-place semantic is the regression under test
  const store = {
    state,
    getters: { 'category/byId': () => () => null },
    async dispatch (type, payload) {
      if (type === 'todo/updateTodoFields') {
        const { taskId, patch } = payload
        const row = state.todo.todoList.find(t => t.taskId === taskId)
        if (row) Object.assign(row, patch) // in-place, like store/todo.js upsertLocal
        return row
      }
      return null
    },
    commit () {}
  }
  const app = Vue.createApp(Comp)
  const props = {
    $t: (key, params) => key + (params ? ':' + JSON.stringify(params) : ''),
    $announce: () => {},
    $message: { success () {}, error () {}, warning () {}, closeAll () {} },
    $route: { name: 'todo-list-todo-box', params: {} },
    $store: store
  }
  for (const [k, v] of Object.entries(props)) app.config.globalProperties[k] = v
  const host = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(host)
  const vm = app.mount(host)
  return vm
}

const seed = state => {
  state.todo.todoList.push(
    { taskId: 't1', taskContent: 'U批量甲', dayStart: 0, todoTime: 0, categoryId: 0, complete: false, delete: false },
    { taskId: 't2', taskContent: 'U批量乙', dayStart: 0, todoTime: 0, categoryId: 0, complete: false, delete: false }
  )
}

test('j9 batch-undo: batchToday snapshots PRE-dispatch values, and the revert closure restores the undated state', async () => {
  const h = buildHarness()
  const vm = await mountBox(h)
  seed(h.state)
  vm.checkedIds = ['t1', 't2']
  await vm.batchToday()

  // rows moved to today
  assert.equal(h.state.todo.todoList[0].dayStart, h.TODAY0, 'move applied')
  assert.equal(h.state.todo.todoList[0].todoTime, h.TODAY0, 'no-time task anchored to the new day')
  // THE FIX UNDER TEST: the snapshot must hold the OLD (undated) values, not the post-dispatch ones
  const opts = h.captured[h.captured.length - 1]
  assert.equal(opts.snap.length, 2)
  assert.deepEqual(opts.snap[0].revert, { dayStart: 0, todoTime: 0 },
    'revert must be the pre-dispatch snapshot — the old code recorded the NEW values here')

  // drive the REAL revert closure: undo restores the undated state
  await opts.revertOf(opts.snap[0])
  await opts.revertOf(opts.snap[1])
  assert.equal(h.state.todo.todoList[0].dayStart, 0, 'undo restores dayStart 0')
  assert.equal(h.state.todo.todoList[0].todoTime, 0, 'undo restores todoTime 0')
})

test('j9 batch-undo: a second apply/undo pair does not double-apply', async () => {
  const h = buildHarness()
  const vm = await mountBox(h)
  seed(h.state)
  for (let round = 0; round < 2; round++) {
    vm.checkedIds = ['t1', 't2']
    await vm.batchToday()
    assert.equal(h.state.todo.todoList[0].dayStart, h.TODAY0, `round ${round}: moved to today`)
    const opts = h.captured[h.captured.length - 1]
    assert.deepEqual(opts.snap[0].revert, { dayStart: 0, todoTime: 0 },
      `round ${round}: snapshot still the pristine undated pair (no drift from the previous undo)`)
    await opts.revertOf(opts.snap[0])
    await opts.revertOf(opts.snap[1])
    assert.equal(h.state.todo.todoList[0].dayStart, 0, `round ${round}: undo restored`)
    assert.equal(h.state.todo.todoList[0].todoTime, 0, `round ${round}: undo restored todoTime`)
  }
})

test('j9 batch-undo: batchCat snapshots the PRE-dispatch categoryId', async () => {
  const h = buildHarness()
  const vm = await mountBox(h)
  seed(h.state)
  vm.checkedIds = ['t1']
  await vm.batchCat(100001)
  assert.equal(h.state.todo.todoList[0].categoryId, 100001, 'move applied')
  const opts = h.captured[h.captured.length - 1]
  assert.deepEqual(opts.snap, [{ id: 't1', categoryId: 0 }],
    'snapshot must hold the pre-dispatch categoryId 0 (the old code recorded 100001 here — silent no-op undo)')
  await opts.revertOf(opts.snap[0])
  assert.equal(h.state.todo.todoList[0].categoryId, 0, 'undo restores 未分类')
})

test('j9 batch-undo: a dispatch failure must not leave a phantom undo entry', async () => {
  const h = buildHarness()
  const vm = await mountBox(h)
  seed(h.state)
  // make t2's dispatch throw (dead row mid-batch) — per-row isolation keeps t1 moving
  const realDispatch = vm.$store.dispatch
  vm.$store.dispatch = async (type, payload) => {
    if (type === 'todo/updateTodoFields' && payload.taskId === 't2') throw new Error('dead row')
    return realDispatch(type, payload)
  }
  vm.checkedIds = ['t1', 't2']
  await vm.batchToday()
  const opts = h.captured[h.captured.length - 1]
  assert.deepEqual(opts.snap.map(s => s.id), ['t1'], 'failed row popped from the undo snapshot')
  assert.deepEqual(opts.snap[0].revert, { dayStart: 0, todoTime: 0 })
})
