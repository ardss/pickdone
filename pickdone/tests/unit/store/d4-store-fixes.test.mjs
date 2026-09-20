/**
 * D4 maintenance round regressions (store domain):
 *  [2] addTodo's implicit addToTop follows settings.newTodoDefaultSort (explicit caller value wins)
 *  [3] giveUp books focus by MEASURED duration capped at FOCUS_MAX_MINUTES, not the current setting
 *  [4] completeFocus's bumpSnow goes through a pending-retry queue (no silent fire-and-forget drop)
 *  [5] syncTodos drops a version-stale commitSyncBatch (db layer rejects it permanently) instead of
 *      re-enqueueing a doomed batch forever; transient failures still re-enqueue
 * Run: node --test tests/unit/store/d4-store-fixes.test.mjs
 */
import '../../setup.mjs'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// ---------- shared stubs ----------
const LS = {}
if (!globalThis.localStorage) {
  globalThis.localStorage = {
    getItem: k => (k in LS ? LS[k] : null),
    setItem: (k, v) => { LS[k] = String(v) },
    removeItem: k => { delete LS[k] }
  }
}
const lsRef = globalThis.localStorage

// ---------- [2] addTodo default sort follows the setting ----------
globalThis.window.location = { hash: '' }
globalThis.window.todoAPI = { dbCall: async () => null }

const todoMod = await import('../../../renderer/js/store/todo.js')
const todoActions = todoMod.default.actions

function addCtx (sortSetting) {
  return {
    state: { todoList: [{ taskId: 'seed', delete: false, taskSort: 1024 }] },
    rootState: { settings: { newTodoDefaultSort: sortSetting }, auth: { user: { userId: 'u' } } },
    commit: () => {},
    dispatch: async () => {}
  }
}

test('addTodo without explicit addToTop respects settings.newTodoDefaultSort=bottom', async () => {
  const a = await todoActions.addTodo.call({}, addCtx('bottom'), { todoContent: 'b1' })
  assert.ok(Math.abs(a.taskSort - (1024 - 512)) < 64, 'no-date pool insert goes below the min (bottom), got ' + a.taskSort)
  const b = await todoActions.addTodo.call({}, addCtx('top'), { todoContent: 't1' })
  assert.ok(Math.abs(b.taskSort - (1024 + 512)) < 64, 'default top inserts above the max, got ' + b.taskSort)
})

test('explicit addToTop keeps precedence over the setting', async () => {
  const a = await todoActions.addTodo.call({}, addCtx('bottom'), { todoContent: 'x', addToTop: true })
  assert.ok(Math.abs(a.taskSort - (1024 + 512)) < 64, 'caller-passed addToTop=true wins over bottom setting, got ' + a.taskSort)
  const b = await todoActions.addTodo.call({}, addCtx('top'), { todoContent: 'y', addToTop: false })
  assert.ok(Math.abs(b.taskSort - (1024 - 512)) < 64, 'caller-passed addToTop=false wins over top setting, got ' + b.taskSort)
})

// ---------- [3] giveUp books measured minutes ----------
const tomato = (await import('../../../renderer/js/store/tomato.js')).default

function giveUpCtx (statePatch = {}) {
  const state = Object.assign({}, tomato.state, {
    status: 'startTomatoTime', startedAt: Date.now(),
    tomatoTime: 25, restTime: 5, enableNotification: false,
    attachTodo: null,
    tomatoRecordList: [], todayTomatoCount: 0
  }, statePatch)
  return {
    state,
    rootState: { todo: { todoList: [] }, settings: {} },
    commit: (m, p) => tomato.mutations[m](state, p),
    dispatch: async () => {}
  }
}

beforeEach(() => { lsRef.removeItem('tomatoLastPhaseDone') })

test('giveUp: duration setting lowered mid-focus books MEASURED minutes, not the new setting', () => {
  const startedAt = Date.now() - (5 * 60 + 30) * 1000 // 5.5 focused minutes
  const ctx = giveUpCtx({ startedAt, tomatoTime: 3 }) // user lowered the duration to 3 mid-focus
  tomato.actions.giveUp(ctx, { record: true, reason: '' })
  assert.equal(ctx.state.tomatoRecordList.length, 1)
  assert.equal(ctx.state.tomatoRecordList[0].focusDuration, 6,
    'measured round(5.5) minutes booked (D5 2026-09-20 unified with completeFocus; old code capped at the current setting=3)')
})

test('giveUp: measured minutes are clamped at FOCUS_MAX_MINUTES (600)', () => {
  const startedAt = Date.now() - 700 * 60 * 1000
  const ctx = giveUpCtx({ startedAt, tomatoTime: 25 })
  tomato.actions.giveUp(ctx, { record: true, reason: '' })
  assert.equal(ctx.state.tomatoRecordList[0].focusDuration, 600, 'FOCUS_MAX_MINUTES cap applies')
})

// ---------- [4] bumpSnow pending-retry ----------
const calls = { getById: [], bumpSnow: [] }
let bumpSnowFailures = 0
globalThis.window.todoAPI = {
  dbCall: async (op, params) => {
    if (op === 'getById') { calls.getById.push(params); return { taskId: params, delete: false } }
    if (op === 'bumpSnow') {
      calls.bumpSnow.push(params)
      if (bumpSnowFailures > 0) { bumpSnowFailures--; throw new Error('ipc down') }
      return true
    }
    return null
  }
}
const origError = console.error
beforeEach(() => { calls.getById.length = 0; calls.bumpSnow.length = 0; bumpSnowFailures = 0; lsRef.removeItem('tomatoLastPhaseDone') })

test('completeFocus: first bumpSnow rejects → retried → succeeds → snow recorded', async () => {
  const errors = []
  console.error = (...a) => errors.push(a.join(' '))
  const LS_KEY = 'tomatoState'
  const mk = startedAt => {
    const state = Object.assign({}, tomato.state, {
      status: 'startTomatoTime', startedAt, tomatoTime: 25, restTime: 5,
      enableNotification: false, attachTodo: { taskId: 't-d4', taskContent: 'd4' },
      tomatoRecordList: [], todayTomatoCount: 0
    })
    lsRef.setItem(LS_KEY, JSON.stringify({ schemaV: 1, status: 'startTomatoTime', startedAt, tomatoTime: 25, restTime: 5 }))
    const ctx = {
      state,
      rootState: { todo: { todoList: [{ taskId: 't-d4', taskContent: 'd4', delete: false }], recycleList: [] }, settings: {} },
      commit: (m, p) => tomato.mutations[m] && tomato.mutations[m](state, p),
      dispatch: async () => {}
    }
    const storeLike = { state: { todo: ctx.rootState.todo }, rootState: ctx.rootState }
    return { ctx, storeLike }
  }
  try {
    const startedAt = Date.now()
    bumpSnowFailures = 1
    const a = mk(startedAt)
    await tomato.actions.completeFocus.call(a.storeLike, a.ctx)
    assert.equal(calls.bumpSnow.length, 1, 'first (failing) bumpSnow was issued')
    // retry happens on the next snow write; trigger one via a second completion
    lsRef.removeItem('tomatoLastPhaseDone')
    const b = mk(startedAt + 60000)
    await tomato.actions.completeFocus.call(b.storeLike, b.ctx)
    await new Promise(r => setTimeout(r, 20))
    assert.ok(calls.bumpSnow.length >= 2, 'failed call was retried (got ' + calls.bumpSnow.length + ')')
    assert.ok(errors.some(e => e.includes('bumpSnow')), 'failure is logged, not silent')
    assert.ok(errors.some(e => e.includes('queued for retry')), 'entry kept in the retry queue')
  } finally {
    console.error = origError
  }
})

// ---------- [5] syncTodos version-fence ----------
const ROOT5 = { settings: { backupDir: '' }, auth: { user: { userId: 1 } }, category: { list: [] }, habits: { habits: [], moments: [], savedAt: 0 } }
const syncCalls = []
let dbHandler5 = null
const prevDbCall = globalThis.window.todoAPI.dbCall
globalThis.window.todoAPI.dbCall = (op, params) => {
  syncCalls.push([op, params])
  return dbHandler5 ? dbHandler5(op, params) : prevDbCall(op, params)
}
const makeSyncCtx = state => ({
  state,
  rootState: ROOT5,
  rootGetters: {},
  commit: (type) => { if (type === 'bumpVersion') state.version++ },
  dispatch: async () => null
})
const row = (taskId, over = {}) => Object.assign({
  taskId, taskContent: 't-' + taskId, delete: false, complete: false,
  updateTime: 1, status: 'add', version: 0
}, over)

beforeEach(() => { syncCalls.length = 0; dbHandler5 = null; todoMod._testInternals.pendingUpserts.splice(0, todoMod._testInternals.pendingUpserts.length) })

test('syncTodos: stale-version rejection DROPS the batch (no doomed re-enqueue)', async () => {
  const rows = [row('a', { status: 'update' })]
  const state = { todoList: rows, recycleList: [], version: 0, isSyncing: false }
  dbHandler5 = async () => { throw new Error('[TodoDB] commitSyncBatch: version 1 < current todosVersion 5 — stale batch rejected') }
  await todoActions.syncTodos.call(todoMod.default, makeSyncCtx(state))
  assert.equal(todoMod._testInternals.pendingUpserts.length, 0, 'stale batch is not re-enqueued')
})

test('syncTodos: transient (non-stale) failure still re-enqueues for retry', async () => {
  const rows = [row('a', { status: 'update' })]
  const state = { todoList: rows, recycleList: [], version: 0, isSyncing: false }
  dbHandler5 = async () => { throw new Error('network down') }
  await todoActions.syncTodos.call(todoMod.default, makeSyncCtx(state))
  const queued = todoMod._testInternals.pendingUpserts
  assert.equal(queued.length, 1, 'transient failure keeps the retry-enqueue')
  assert.equal(queued[0].op, 'commitSyncBatch')
})
