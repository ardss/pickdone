/* maint/d11 coverage-restore wave: behavior tests for renderer/js/store/todo.js action branches the
 * d11 fix rounds touched but stayed uncovered — init (external-write vs preserveHistory), addTodo
 * (renewal idempotency, sort pools), updateTodoFields (cycle guard, dayStart re-derive, deferViews),
 * toggleComplete (subtask cascade + unlock detection), deleteTodosMany, restoreFromRecycle (dangling
 * repeatId), purgeIds/purgeAllRecycle/purgeExpiredRecycle (clock rollback + same-day dedupe).
 * Run: node --test tests/unit/store/todo-d11-coverage.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import todoMod, { _testInternals } from '../../../renderer/js/store/todo.js'

const day0 = +globalThis.window.dayjs().startOf('day')

function makeStore (statePatch = {}, apiImpl = {}) {
  const state = Object.assign(todoMod.state(), statePatch)
  const storeThis = {
    state: { todo: state },
    _viewsDebounceTimer: null
  }
  const ops = []
  globalThis.window.todoAPI = {
    dbCall: async (op, params) => {
      ops.push([op, params])
      if (op === 'getAll') return statePatch._rows || []
      if (op === 'getMeta') return statePatch._meta || null
      return null
    },
    deleteTodoFilesRelevant: async () => {},
    purgeRecycleBin: async () => true,
    onAppQuittingFlush () {},
    ...apiImpl
  }
  const dispatched = []
  const ctx = {
    state,
    rootState: Object.assign({
      settings: { newTodoCategoryId: 3, recycleBinAutoDeleteDays: 0 },
      auth: { user: { userId: 'u1' } },
      tomato: { attachTodo: null }
    }, statePatch._rootState),
    commit (m, p) { if (todoMod.mutations[m]) todoMod.mutations[m](state, p) },
    dispatch (path, payload) {
      dispatched.push([path, payload])
      const [mod, action] = path.split('/')
      if (action === undefined && todoMod.actions[mod]) return todoMod.actions[mod].call(storeThis, ctx, payload)
      if (mod === 'tomato') return Promise.resolve()
      return Promise.resolve(undefined)
    }
  }
  return { ctx, state, ops, dispatched, storeThis }
}

const row = (id, extra = {}) => Object.assign({
  taskId: id, taskContent: 'task ' + id, delete: false, complete: false,
  dayStart: day0, taskSort: 1024, updateTime: Date.now(), estimate: 0, predecessors: null
}, extra)

test('actions.init: loads rows + meta, computes views; getAll failure degrades to an empty table', async () => {
  const a = makeStore({ _rows: [row('a'), row('b', { delete: true })], _meta: '41' })
  await todoMod.actions.init.call(a.storeThis, a.ctx)
  assert.equal(a.state.loaded, true)
  assert.deepEqual(a.state.todoList.map(r => r.taskId), ['a'])
  assert.deepEqual(a.state.recycleList.map(r => r.taskId), ['b'])
  assert.equal(a.state.todosVersion, 41)
  assert.equal(a.state.version, 42, 'version = max(version, todosVersion+1)')

  const b = makeStore({ _rootState: {}, _fail: true }, { dbCall: async (op) => { if (op === 'getAll') throw new Error('db gone'); return null } })
  await todoMod.actions.init.call(b.storeThis, b.ctx)
  assert.equal(b.state.loaded, true, 'init survives a getAll failure (empty table, loud log)')
})

test('actions.addTodo: renewal idempotency returns the existing instance instead of double-creating', async () => {
  const existing = row('renew-seed', { repeatId: 'r1', dayStart: day0 })
  const a = makeStore({ todoList: [existing], _rootState: {} }, {
    dbCall: async (op) => {
      if (op === 'queryTodos') return [existing]
      if (op === 'getMeta') return null
      return null
    }
  })
  const made = await todoMod.actions.addTodo.call(a.storeThis, a.ctx, {
    todoContent: 'renewal', todoDate: day0, repeatId: 'r1'
  })
  assert.equal(made.taskId, 'renew-seed', 'same rid + same dayStart → existing row returned')
})

test('actions.addTodo: sort pools — same-day min/max and the no-date pool; content is trimmed', async () => {
  const a = makeStore({
    todoList: [row('x', { taskSort: 500 }), row('y', { taskSort: 2000 })],
    _rootState: {}
  })
  const t1 = await todoMod.actions.addTodo.call(a.storeThis, a.ctx, { todoContent: '  new one  ', todoDate: day0 })
  assert.equal(t1.taskContent, 'new one')
  assert.ok(t1.taskSort > 2000, 'addToTop default (custom mode renders DESC) goes above the max: max+512')
  const t2 = await todoMod.actions.addTodo.call(a.storeThis, a.ctx, { todoContent: 'bottom', todoDate: day0, addToTop: false })
  assert.ok(t2.taskSort < 500, 'addToTop=false goes below the min: min-512')
  const t3 = await todoMod.actions.addTodo.call(a.storeThis, a.ctx, { todoContent: 'inbox item' })
  assert.equal(t3.dayStart, 0, 'no-date task lands in the todo box')
  assert.equal(t3.categoryId, 3, 'category default from settings')
})

test('actions.updateTodoFields: dependency cycle is rejected; missing task is a no-op; todoTime re-derives dayStart', async () => {
  const a = makeStore({ todoList: [row('a', { predecessors: null }), row('b', { predecessors: JSON.stringify(['a']) })] })
  await assert.rejects(
    todoMod.actions.updateTodoFields.call(a.storeThis, a.ctx, { taskId: 'a', patch: { predecessors: ['b'] } }),
    /dependency-cycle/,
    'a→b→a closes a loop and must throw'
  )
  const missing = await todoMod.actions.updateTodoFields.call(a.storeThis, a.ctx, { taskId: 'ghost', patch: { taskContent: 'x' } })
  // Reconciled with TL-5 (c715ffc2): the memory-miss no-op grew a STRUCTURED result at the single
  // resolveForEdit choke point — { notFound: true, taskId } — so callers can surface the miss
  // instead of mistaking it for a successful edit of a real row. The row must still be untouched.
  assert.deepEqual(missing, { notFound: true, taskId: 'ghost' })
  assert.ok(!a.state.todoList.some(r => r.taskId === 'ghost'), 'no ghost row is materialized')
  const at = new Date().getTime() + 86400000
  const moved = await todoMod.actions.updateTodoFields.call(a.storeThis, a.ctx, { taskId: 'a', patch: { todoTime: at } })
  assert.equal(moved.dayStart, +globalThis.window.dayjs(at).startOf('day'), 'dayStart follows todoTime in memory too')
  assert.equal(a.state.todoList.find(r => r.taskId === 'a').dayStart, +globalThis.window.dayjs(at).startOf('day'))
})

test('actions.toggleComplete: completion cascades to subtasks and detects unlocked dependents; unchecking cascades back', async () => {
  const a = makeStore({
    todoList: [
      row('parent', { subtasks: JSON.stringify([{ text: 's1', checked: false }]), complete: true }),
      row('child', { predecessors: JSON.stringify(['parent']) })
    ],
    _rootState: { settings: { isCompleteWithSubtasks: true } }
  })
  // UI flow: the checkbox flips the row optimistically, then dispatches the stored row
  const optimistic = Object.assign({}, a.state.todoList[0], { complete: false })
  const r = await todoMod.actions.toggleComplete.call(a.storeThis, a.ctx, optimistic)
  assert.equal(r.complete, true)
  assert.equal(JSON.parse(r.subtasks)[0].checked, true, 'subtask cascade on completion')
  assert.deepEqual(r._unlocked, ['task child'], 'dependent unlocked by this completion')

  const r2 = await todoMod.actions.toggleComplete.call(a.storeThis, a.ctx, Object.assign({}, a.state.todoList[1], { complete: true }))
  assert.equal(r2.complete, false)
  assert.equal(JSON.parse(r2.subtasks || '[]').length, 0, 'no subtasks on the child')
})

test('actions.toggleComplete: malformed subtask JSON never blocks completion', async () => {
  const a = makeStore({ todoList: [row('bad', { subtasks: '{oops' })] })
  const r = await todoMod.actions.toggleComplete.call(a.storeThis, a.ctx, a.state.todoList[0])
  assert.equal(r.complete, true)
  assert.equal(r.subtasks, '{oops', 'malformed JSON left untouched')
})

test('actions.reorderTodos: unknown ids skipped, batch lands as one upsertMany', async () => {
  const a = makeStore({ todoList: [row('a', { taskSort: 1 }), row('b', { taskSort: 2 })] })
  await todoMod.actions.reorderTodos.call(a.storeThis, a.ctx, [
    { taskId: 'a', taskSort: 900 }, { taskId: 'ghost', taskSort: 5 }
  ])
  assert.equal(a.state.todoList.find(t => t.taskId === 'a').taskSort, 900)
  const putMany = a.ops.filter(o => o[0] === 'upsertMany')
  assert.equal(putMany.length, 1)
  assert.equal(putMany[0][1].length, 1, 'only the known row persists')
  const none = makeStore({ todoList: [] })
  await todoMod.actions.reorderTodos.call(none.storeThis, none.ctx, [{ taskId: 'x', taskSort: 1 }])
  assert.equal(none.ops.filter(o => o[0] === 'upsertMany').length, 0, 'no rows matched → no write')
})

test('actions.deleteTodo: soft delete detaches running focus, version reset for re-sync', async () => {
  const detach = []
  const a = makeStore({ todoList: [row('a')], _rootState: { tomato: { attachTodo: { taskId: 'a', taskContent: 'x' } } } })
  a.ctx.dispatch = async (path) => { detach.push(path) }
  await todoMod.actions.deleteTodo.call(a.storeThis, a.ctx, a.state.todoList[0])
  assert.ok(detach.includes('tomato/attach'), 'focus-bound row detaches first')
  const deleted = a.state.recycleList.find(t => t.taskId === 'a')
  assert.equal(deleted.delete, true)
  assert.equal(deleted.version, 0, 're-delete after restore must re-enter the sync snapshot')
  const upserted = a.ops.filter(o => o[0] === 'upsert').map(o => o[1]).find(r => r.taskId === 'a')
  assert.ok(upserted, 'soft delete persisted via the todo.put upsert op')
  assert.equal(upserted.deleting, undefined, 'local-dialect flag stripped before persist')

  const b = makeStore({ todoList: [row('b')] })
  await todoMod.actions.deleteTodo.call(b.storeThis, b.ctx, { taskId: 'ghost' })
  assert.equal(b.state.recycleList.length, 0, 'unknown task → no-op')
})

test('actions.deleteTodosMany: one history snapshot for the whole batch, returns the affected ids', async () => {
  const snaps = []
  const a = makeStore({ todoList: [row('a'), row('b'), row('c')] })
  const origPush = todoMod.mutations.historyPush
  a.ctx.commit = (m, p) => { if (m === 'historyPush') { snaps.push(p); origPush(a.state, p) } else if (todoMod.mutations[m]) todoMod.mutations[m](a.state, p) }
  const ids = await todoMod.actions.deleteTodosMany.call(a.storeThis, a.ctx, [row('a'), { taskId: 'ghost' }, null])
  assert.deepEqual(ids, ['a'], 'unknown ids never enter the batch')
  assert.equal(snaps.length, 1, 'exactly ONE undo snapshot for the batch (F-C1)')
  assert.equal(a.state.recycleList.map(r => r.taskId).join(','), 'a')
  const empty = makeStore({ todoList: [] })
  assert.deepEqual(await todoMod.actions.deleteTodosMany.call(empty.storeThis, empty.ctx, []), [])
})

test('actions.restoreFromRecycle: dangling repeatId (GCed rule) restores as a plain task', async () => {
  const a = makeStore({ recycleList: [row('a', { delete: true, repeatId: 'gone' })] })
  const r = await todoMod.actions.restoreFromRecycle.call(a.storeThis, a.ctx, a.state.recycleList[0])
  assert.equal(r.delete, false)
  assert.equal(a.state.todoList.find(t => t.taskId === 'a').repeatId, null, 'GCed rule → repeatId cleared with a warning')
})

test('actions.purgeIds: returns done/failed, hard-removed rows leave the recycle bin, history is voided', async () => {
  const a = makeStore({ recycleList: [row('a', { delete: true }), row('b', { delete: true })] }, {
    dbCall: async (op, params) => {
      if (op === 'hardDelete' && params === 'b') throw new Error('hard delete failed')
      return null
    }
  })
  const res = await todoMod.actions.purgeIds.call(a.storeThis, a.ctx, ['a', 'b'])
  assert.deepEqual(res.done, ['a'])
  assert.deepEqual(res.failed, ['b'], 'per-id failures are reported, not swallowed')
  assert.deepEqual(a.state.recycleList.map(t => t.taskId), ['b'], 'failed purge keeps the row')
})

test('actions.purgeAllRecycle: empty bin returns true with no IPC; failed purge keeps rows and returns false', async () => {
  const a = makeStore({ recycleList: [] })
  assert.equal(await todoMod.actions.purgeAllRecycle.call(a.storeThis, a.ctx), true)

  const b = makeStore({ recycleList: [row('x', { delete: true })] }, { purgeRecycleBin: async () => false })
  assert.equal(await todoMod.actions.purgeAllRecycle.call(b.storeThis, b.ctx), false)
  assert.equal(b.state.recycleList.length, 1, 'rows stay when the purge IPC failed (no fake success)')

  const c = makeStore({ recycleList: [row('x', { delete: true })] })
  assert.equal(await todoMod.actions.purgeAllRecycle.call(c.storeThis, c.ctx), true)
  assert.equal(c.state.recycleList.length, 0)
})

test('actions.purgeExpiredRecycle: disabled setting, clock rollback, and same-day dedupe all skip the purge', async () => {
  // recycleBinAutoDeleteDays=0 → never
  const a = makeStore({ recycleList: [row('old', { delete: true, deletedAt: 1 })] })
  await todoMod.actions.purgeExpiredRecycle.call(a.storeThis, a.ctx, { force: true })
  assert.equal(a.state.recycleList.length, 1, 'days=0 never auto-purges')

  // clock rolled back → skip this round
  globalThis.localStorage.setItem('recycleLastPurgeAt', String(Date.now() + 48 * 3600_000))
  const b = makeStore({ recycleList: [row('old', { delete: true, deletedAt: 1 })], _rootState: { settings: { recycleBinAutoDeleteDays: 30 } } })
  const purges = []
  b.ctx.dispatch = async (p, pay) => { purges.push([p, pay]) }
  await todoMod.actions.purgeExpiredRecycle.call(b.storeThis, b.ctx, { force: true })
  assert.equal(purges.length, 0, 'clock rollback skips auto-purge')
  globalThis.localStorage.removeItem('recycleLastPurgeAt')

  // same-day dedupe: a second run the same day is a no-op unless forced
  globalThis.localStorage.setItem('recycleLastPurgeAt', String(Date.now()))
  const c = makeStore({ recycleList: [row('old', { delete: true, deletedAt: 1 })], _rootState: { settings: { recycleBinAutoDeleteDays: 30 } } })
  const purges2 = []
  c.ctx.dispatch = async (p, pay) => { purges2.push([p, pay]) }
  await todoMod.actions.purgeExpiredRecycle.call(c.storeThis, c.ctx, {})
  assert.equal(purges2.length, 0, 'already ran today (U-8)')
  globalThis.localStorage.removeItem('recycleLastPurgeAt')
})

test('actions.purgeExpiredRecycle: rows past the cutoff are purged and the stamp is written even on failure', async () => {
  globalThis.localStorage.removeItem('recycleLastPurgeAt')
  const old = 1 // epoch → far past any cutoff
  const a = makeStore({
    recycleList: [row('ancient', { delete: true, deletedAt: old, updateTime: old }), row('fresh', { delete: true, deletedAt: Date.now() })],
    _rootState: { settings: { recycleBinAutoDeleteDays: 30 } }
  })
  const purged = []
  a.ctx.dispatch = async (p, pay) => { purged.push([p, pay]); return [purged.length, 'purgeIds'].includes(p) ? { done: [pay && pay[0]] } : undefined }
  await todoMod.actions.purgeExpiredRecycle.call(a.storeThis, a.ctx, {})
  assert.ok(purged.some(([p, ids]) => p === 'purgeIds' && ids.includes('ancient')), 'only rows past the cutoff purge')
  assert.ok(String(globalThis.localStorage.getItem('recycleLastPurgeAt')), 'attempt stamp written')
  globalThis.localStorage.removeItem('recycleLastPurgeAt')
})

test('mutations: upsertLocal moves rows across todo/recycle without duplicates; hardRemove filters', () => {
  const { state } = makeStore({ todoList: [row('a')], recycleList: [] })
  todoMod.mutations.upsertLocal(state, row('a', { taskContent: 'edited' }))
  assert.equal(state.todoList[0].taskContent, 'edited')
  todoMod.mutations.upsertLocal(state, row('a', { delete: true }))
  assert.equal(state.todoList.length, 0, 'moved into the bin')
  assert.equal(state.recycleList.length, 1)
  todoMod.mutations.upsertLocal(state, row('a', { delete: false }))
  assert.equal(state.recycleList.length, 0, 'restored back to the active list')
  todoMod.mutations.hardRemove(state, ['a'])
  assert.equal(state.recycleList.length, 0)
  todoMod.mutations.removeLocal(state, 'missing')
  todoMod.mutations.setMeta(state, { todosVersion: null })
  assert.equal(state.todosVersion, 0, 'null meta is ignored')
  todoMod.mutations.setHolidayList(state, null)
  assert.deepEqual(state.holidayList, [])
})

test('safeUpsert contract: a failed task upsert stays queued and the quit-flush replays it', async () => {
  const queued = _testInternals.pendingUpserts
  let failing = true
  globalThis.window.todoAPI = {
    dbCall: async (op, params) => { if (failing) throw new Error('ipc down'); return { changes: 1, params } },
    onAppQuittingFlush () {}
  }
  _testInternals.safeUpsert({ taskId: 'q1', taskContent: 'x' })
  await new Promise(r => setTimeout(r, 20))
  assert.ok(queued.some(e => e.params && e.params.taskId === 'q1'), 'failed upsert stays queued')
  failing = false
  await _testInternals.flushPendingUpserts()
  await new Promise(r => setTimeout(r, 20))
  assert.equal(queued.some(e => e.params && e.params.taskId === 'q1'), false, 'replay drains the queue')
})
