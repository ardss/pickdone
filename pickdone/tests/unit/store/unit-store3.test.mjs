/**
 * todo store deep action-layer unit tests (second group) - init loading, addTodo, repeat renewal, purge,
 * persisted snapshot diff, writeCriticalBackup. window.todoAPI is driven by a programmable stub.
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import todo from '../../../renderer/js/store/todo.js'
import settings from '../../../renderer/js/store/settings.js'

const today0 = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() })()
const T = (over = {}) => ({
  taskId: 't' + Math.random().toString(36).slice(2),
  taskContent: '任务', dayStart: today0, todoTime: today0, createTime: Date.now(),
  updateTime: Date.now(), complete: false, delete: false, taskSort: 0, status: 'sync', version: 1,
  ...over
})

// Programmable stub: meta storage actually works; behavior can be injected per op
const metaStore = new Map()
const behavior = {} // op => injected exception/return
globalThis.window.todoAPI = {
  dbCall: async (op, params) => {
    if (behavior[op]) return behavior[op](params)
    switch (op) {
      case 'getAll': return [...globalThis.__stubLive || []]
      case 'getMeta': return metaStore.get(params) ?? null
      case 'setMeta': { const [k, v] = params; metaStore.set(k, v); return true }
      case 'upsert': case 'upsertMany': case 'hardDelete': case 'purgeRecycleBin': return true
      case 'getViews': return {}
      default: return true
    }
  },
  deleteTodoFilesRelevant: async () => true,
  // preload's real shape exposes purgeRecycleBin directly (src/preload/index.js:19) — it was missing
  // here and the old purge flow's ignore-failure hardRemove masked that; the success-gated flow needs it
  purgeRecycleBin: async () => true,
  writeCriticalStateBackup: async () => true,
  // Note: preload has no writeEventBackup - it is a todo store action that internally goes through runAutoBackup;
  // the stub only exposes preload's real shape, otherwise it would mask regressions like "the renderer calling a nonexistent IPC channel"
  runAutoBackup: async () => true,
  deleteFile: async () => true
}

const makeCtx = (todoState, settingsPatch = {}) => {
  const committed = []
  const dispatched = []
  const ctx = {
    commit (n, p) {
      committed.push([n, p])
      if (n === 'upsertLocal') todo.mutations.upsertLocal(todoState, p)
      else if (n === 'hardRemove') todo.mutations.hardRemove(todoState, p)
      else if (n === 'setAllRows') todo.mutations.setAllRows(todoState, p)
      else if (n === 'setViews') todo.mutations.setViews(todoState, p)
      else if (n === 'setMeta') todo.mutations.setMeta(todoState, p)
      else if (n === 'historyPush') todo.mutations.historyPush(todoState, p)
      else if (n === 'historyPushKeepRedo') todo.mutations.historyPushKeepRedo(todoState, p)
      else if (n === 'historyRestore') todo.mutations.historyRestore(todoState, p)
      else if (n === 'historyRedoPop') todo.mutations.historyRedoPop(todoState)
      else if (n === 'historyUndoPop') todo.mutations.historyUndoPop(todoState)
      else if (n === 'viewsClean') todo.mutations.viewsClean(todoState)
      else if (n === 'setLoaded') todoState.loaded = true
      else if (n === 'setRecentlyAdded') todoState.recentlyAddedTaskId = p
    },
    state: {
      todo: todoState, todoList: todoState.todoList, recycleList: todoState.recycleList || [],
      undoStack: todoState.undoStack, redoStack: todoState.redoStack
    },
    rootState: {
      settings: { ...settings.state, recycleBinAutoDeleteDays: 30, ...settingsPatch },
      auth: { user: { userId: 'u-test' } }
    }
  }
  const fakeThis = { state: { todo: todoState } }
  ctx.dispatch = async (n, p) => {
    dispatched.push([n, p])
    if (n === 'computeViews') return todo.actions.computeViews.call(fakeThis, ctx)
    if (n === 'updateTodoFields') return todo.actions.updateTodoFields.call(fakeThis, ctx, p)
    if (n === 'ensureNextRepeatInstance') return todo.actions.ensureNextRepeatInstance.call(fakeThis, ctx, p)
    if (n === 'addTodo') return todo.actions.addTodo.call(fakeThis, ctx, p)
  }
  return { ctx, committed, dispatched, fakeThis }
}

const freshState = (todoList = [], recycleList = []) => ({
  todoList, recycleList, todayTimestamp: Date.now(), holidayList: [],
  undoStack: [], redoStack: [], _histLastPushAt: 0, isSyncing: false,
  loaded: false, viewsDirty: true, recentlyAddedTaskId: null,
  todosVersion: 0, version: 1, search: ''
})

test('todo action: init - getAll loads rows, meta restores the version, loaded set', async () => {
  globalThis.__stubLive = [T({ taskId: 'i1' })]
  metaStore.set('todosVersion', '41')
  const st = freshState()
  const { ctx, committed, fakeThis } = makeCtx(st)
  await todo.actions.init.call(fakeThis, ctx)
  assert.equal(st.todoList.length, 1)
  assert.equal(st.todosVersion, 41)
  assert.equal(st.version, 42)
  assert.equal(st.loaded, true)
  assert.ok(committed.some(([n]) => n === 'setAllRows'))
  delete globalThis.__stubLive
})

test('todo action: addTodo - field assembly + sorting + dayStart derivation', async () => {
  const existing = T({ taskId: 'old', dayStart: today0, taskSort: 5 })
  const st = freshState([existing])
  const { ctx, fakeThis } = makeCtx(st)
  const t = await todo.actions.addTodo.call(fakeThis, ctx, {
    todoContent: '  新任务  ', todoDate: today0, todoSublist: [{ text: '子', checked: false }], addToTop: true
  })
  assert.equal(t.taskContent, '新任务')
  assert.equal(t.dayStart, today0)
  assert.equal(t.status, 'add')
  assert.equal(t.categoryId, 0)
  assert.ok(st.todoList.some(x => x.taskId === t.taskId))
  // addToTop: sort value = maxS+512 (applySort renders by taskSort descending, larger values first)
  assert.ok(t.taskSort > 5)
})

test('todo action: ensureNextRepeatInstance - renewal driven by the meta rule', async () => {
  const rid = 'rid-' + Math.random().toString(36).slice(2, 6)
  metaStore.set('repeatRule:' + rid, JSON.stringify({ repeatType: '天', repeatInterval: 1, repeatDayCount: 5 }))
  const done = T({ taskId: 'done', dayStart: today0, todoTime: today0, repeatId: rid, complete: true })
  const st = freshState([done])
  const { ctx, dispatched, fakeThis } = makeCtx(st)
  await todo.actions.ensureNextRepeatInstance.call(fakeThis, ctx, done)
  const add = dispatched.find(([n]) => n === 'addTodo')
  assert.ok(add, 'should dispatch addTodo for renewal')
  // Assert "+1 day" rather than "date+1": the date-number form would always fail-red at month end (e.g. running on 8/31)
  assert.equal(+new Date(add[1].todoDate), today0 + 86400000)
  assert.equal(add[1].repeatId, rid)
})

test('todo action: purgeIds / purgeAllRecycle - hardRemove + hardDelete persisted', async () => {
  const st = freshState([], [T({ taskId: 'p1', delete: true }), T({ taskId: 'p2', delete: true })])
  const { ctx, fakeThis } = makeCtx(st)
  await todo.actions.purgeIds.call(fakeThis, ctx, ['p1'])
  assert.equal(st.recycleList.length, 1)
  await todo.actions.purgeAllRecycle.call(fakeThis, ctx)
  assert.equal(st.recycleList.length, 0)
})

test('todo action: persistSnapshotDiff - diff upsert and undoing a creation via soft delete', async () => {
  const keep = T({ taskId: 'keep' })
  const added = T({ taskId: 'added', taskContent: '新' })
  const st = freshState([added])
  const { ctx, fakeThis } = makeCtx(st)
  const from = { todoList: [keep, added], recycleList: [] }
  const to = { todoList: [keep], recycleList: [] }
  await todo.actions.persistSnapshotDiff.call(fakeThis, ctx, { from, to })
  // Undo a creation: added should be soft-deleted into the recycle bin; keep has no from/to diff -> not persisted
  assert.ok(st.recycleList.some(t => t.taskId === 'added' && t.delete), 'undoing the creation should soft-delete it')
  assert.equal(st.todoList.some(t => t.taskId === 'keep'), false, 'a row with no diff is not upserted again')
})

test('todo action: redo - redo restores after undo', async () => {
  const nowRow = T({ taskId: 'r1', taskContent: '改' })
  const st = freshState([nowRow])
  st.undoStack = []
  st.redoStack = [JSON.stringify({ todoList: [T({ taskId: 'r1', taskContent: '原' })], recycleList: [] })]
  const { ctx, fakeThis } = makeCtx(st)
  const r = await todo.actions.redo.call(fakeThis, ctx)
  assert.equal(r.ok, true)
  assert.equal(st.todoList[0].taskContent, '原')
})

test('todo action: redo - multi-step redo keeps the remaining redo entries (regression: historyPush reset redoStack so only the first Ctrl+Y worked)', async () => {
  const st = freshState([T({ taskId: 'r1', taskContent: 's0' })])
  st.undoStack = []
  // Two pending redo steps: bottom = 's1', top = 's2'; current state = 's0'
  st.redoStack = [
    JSON.stringify({ todoList: [T({ taskId: 'r1', taskContent: 's1' })], recycleList: [] }),
    JSON.stringify({ todoList: [T({ taskId: 'r1', taskContent: 's2' })], recycleList: [] })
  ]
  const { ctx, fakeThis } = makeCtx(st)
  const r1 = await todo.actions.redo.call(fakeThis, ctx)
  assert.equal(r1.ok, true)
  assert.equal(st.todoList[0].taskContent, 's2')
  assert.equal(st.redoStack.length, 1, 'the remaining redo step must survive the first redo')
  const r2 = await todo.actions.redo.call(fakeThis, ctx)
  assert.equal(r2.ok, true, 'a second redo must still find its step')
  assert.equal(st.todoList[0].taskContent, 's1')
  assert.equal(st.redoStack.length, 0)
  assert.equal(st.undoStack.length, 2, 'both post-redo states were pushed onto the undo stack')
})

test('todo mutations: setMeta / removeLocal / hardRemove', () => {
  const st = freshState([T({ taskId: 'a', status: 'update' })], [T({ taskId: 'b', delete: true, status: 'delete' })])

  todo.mutations.setMeta(st, { todosVersion: 20 })
  assert.equal(st.todosVersion, 20)
  assert.equal(st.version, 21)

  todo.mutations.removeLocal(st, 'a')
  assert.equal(st.todoList.length, 0)
  todo.mutations.removeLocal(st, 'missing') // safe when it does not exist

  todo.mutations.hardRemove(st, ['b'])
  assert.equal(st.recycleList.length, 0)
})

test('todo getters: todayTodoList reads views directly', () => {
  const views = { todayTodoList: [{ taskId: 'z' }] }
  assert.equal(todo.getters.todayTodoList({ views })[0].taskId, 'z')
})

/* ---------- the today page's three sort modes (pure logic extracted into utils/sortMode) ---------- */
import { normalizeSortMode, sortByMode } from '../../../renderer/js/utils/sortMode.js'

const ST = (id, taskSort, createTime, difficulty = 0) => ({ taskId: id, taskSort, createTime, difficulty })

test('sortMode: legacy Chinese values normalize to stable keys', () => {
  assert.equal(normalizeSortMode('自定义'), 'custom')
  assert.equal(normalizeSortMode('按创建日期'), 'created')
  assert.equal(normalizeSortMode('按难度'), 'difficulty')
  assert.equal(normalizeSortMode('custom'), 'custom')
  assert.equal(normalizeSortMode(undefined), 'custom')
})

test('sortMode: custom sorts by taskSort descending with createTime ascending as the stability tiebreak', () => {
  const out = sortByMode([ST('a', 1, 100), ST('b', 5, 50), ST('c', 1, 200), ST('d', 5, 60)], 'custom')
  assert.deepEqual(out.map(t => t.taskId), ['b', 'd', 'a', 'c'])
})

test('sortMode: created newest first / difficulty highest first (missing counts as 0)', () => {
  const arr = [ST('old', 9, 100), ST('new', 1, 900)]
  assert.deepEqual(sortByMode(arr, 'created').map(t => t.taskId), ['new', 'old'])
  const diff = [ST('easy', 1, 1, 0), ST('hard', 1, 2, 3), ST('none', 1, 3)]
  assert.deepEqual(sortByMode(diff, 'difficulty').map(t => t.taskId), ['hard', 'easy', 'none'])
})

test('sortMode: does not mutate the input array (returns a new array)', () => {
  const arr = [ST('a', 1, 1), ST('b', 9, 1)]
  sortByMode(arr, 'custom')
  assert.deepEqual(arr.map(t => t.taskId), ['a', 'b'])
})
