/* Round-5 store-domain regression tests (renderer store layer):
 *  - P1-1 purgeAllRecycle converges on purge success only (failed purge no longer hard-removes locally
 *    + clears the undo stack, which resurrected rows after restart)
 *  - P1-2 coerceNumericSettings: CLI string-typed numeric settings are corrected at load/restore time
 *  - P2-4 restoreFromRecycle: row restore first, one-shot chip snapshot consumed only after it succeeds
 *  - P2-5 reorderTodos: a failed upsertMany batch is queued for the quit-flush replay (no silent loss)
 *  - P2-6 addTodo: dayStart derives from todoTime when todoDate is missing (matches the DB rule)
 *  - P2-7 resolveFocusedTask: a deleted/missing attach target books a free focus, never bumpSnow
 *  - P2-8 category softDelete cleans projectStatus/projectDeadline meta + prunes projectIds (CLI parity)
 * Pure-function extraction pattern, mirroring tests/store-fixes-domain.test.mjs. No electron required.
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// ---- env mocks (must exist before any renderer module is imported) ----
const startOfDayTs = ts => { const d = new Date(ts); d.setHours(0, 0, 0, 0); return d.getTime() }
const ymdOf = ts => {
  const d = new Date(ts)
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
const mkDayjs = ts => {
  const t = ts == null ? Date.now() : (ts && typeof ts === 'object' && ts.valueOf ? ts.valueOf() : ts)
  const o = {
    format: f => f === 'YYYY-MM-DD' ? ymdOf(t) : String(t),
    valueOf: () => t,
    startOf: u => u === 'day' ? mkDayjs(startOfDayTs(t)) : o,
    add: () => o,
    subtract: () => o,
    isSame: () => false,
    hour: () => ({ minute: () => ({ second: () => ({ valueOf: () => t }) }) })
  }
  return o
}
const dayjsModule = ts => mkDayjs(ts == null ? undefined : ts)
globalThis.dayjs = dayjsModule
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
try { globalThis.navigator = { language: 'zh-CN' } } catch { /* Node >=21 exposes a read-only navigator */ }

const dbCalls = []
let dbHandler = (op, params) => { dbCalls.push([op, params]); return Promise.resolve(null) }
let purgeRecycleBinImpl = () => Promise.resolve(true)
globalThis.window = {
  location: { hash: '' },
  dayjs: dayjsModule,
  todoAPI: {
    dbCall: (op, params) => dbHandler(op, params),
    writeCriticalStateBackup: () => Promise.resolve(),
    purgeRecycleBin: (...a) => purgeRecycleBinImpl(...a)
  }
}

const todoMod = await import('../renderer/js/store/todo.js')
const todoActions = todoMod.default.actions
const { pendingUpserts, flushPendingUpserts } = todoMod._testInternals

const settingsMod = await import('../renderer/js/store/settings.js')
const { coerceNumericSettings, DEFAULT_SETTINGS } = settingsMod

const tomatoMod = await import('../renderer/js/store/tomato.js')
const { resolveFocusedTask } = tomatoMod

const categoryMod = await import('../renderer/js/store/category.js')
const categoryMutations = categoryMod.default.mutations
const { collectCascadeIds } = categoryMod

const row = (taskId, over = {}) => ({
  taskId, taskContent: 't-' + taskId, delete: false, dayStart: 0, todoTime: 0,
  updateTime: 1, status: 'update', ...over
})

function waitFor (fn, ms = 500) {
  const t0 = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      try { if (fn()) return resolve() } catch (e) { return reject(e) }
      if (Date.now() - t0 > ms) return reject(new Error('waitFor timeout'))
      setTimeout(tick, 5)
    }
    tick()
  })
}

beforeEach(() => {
  dbCalls.length = 0
  pendingUpserts.splice(0, pendingUpserts.length)
  dbHandler = (op, params) => { dbCalls.push([op, params]); return Promise.resolve(null) }
  purgeRecycleBinImpl = () => Promise.resolve(true)
  globalThis.window.todoAPI.dbCall = (op, params) => dbHandler(op, params)
  globalThis.window.todoAPI.purgeRecycleBin = (...a) => purgeRecycleBinImpl(...a)
})

// ---- P1-1 purgeAllRecycle converges on success only ----
test('P1-1 purgeAllRecycle keeps local rows and undo history when the purge IPC fails', async () => {
  purgeRecycleBinImpl = () => Promise.reject(new Error('ipc down'))
  const commits = []
  const state = { recycleList: [row('a', { delete: true }), row('b', { delete: true })] }
  await todoActions.purgeAllRecycle.call({}, { commit: (t, p) => commits.push([t, p]), dispatch: async () => ({}), state })
  assert.equal(commits.some(c => c[0] === 'hardRemove'), false, 'no local hard-remove on failure')
  assert.equal(commits.some(c => c[0] === 'historyClear'), false, 'no undo-stack wipe on failure')
  assert.equal(dbCalls.some(c => c[0] === 'deleteMeta'), false, 'chip snapshot meta untouched on failure')
})

test('P1-1 purgeAllRecycle treats a falsy purge result as failure too', async () => {
  purgeRecycleBinImpl = () => Promise.resolve(undefined)
  const commits = []
  const state = { recycleList: [row('a', { delete: true })] }
  await todoActions.purgeAllRecycle.call({}, { commit: (t, p) => commits.push([t, p]), dispatch: async () => ({}), state })
  assert.equal(commits.some(c => c[0] === 'hardRemove'), false)
})

test('P1-1 purgeAllRecycle still hard-removes + clears history on success', async () => {
  const commits = []
  const state = { recycleList: [row('a', { delete: true }), row('b', { delete: true })] }
  await todoActions.purgeAllRecycle.call({}, { commit: (t, p) => commits.push([t, p]), dispatch: async () => ({}), state })
  const hardRemoveIdx = commits.findIndex(c => c[0] === 'hardRemove')
  const clearIdx = commits.findIndex(c => c[0] === 'historyClear')
  assert.ok(hardRemoveIdx >= 0, 'hardRemove committed on success')
  assert.ok(clearIdx > hardRemoveIdx, 'historyClear strictly after hardRemove')
})

// ---- P1-2 numeric settings coercion ----
test('P1-2 coerceNumericSettings corrects string-typed numeric fields (declaration-driven)', () => {
  const out = coerceNumericSettings({ ...DEFAULT_SETTINGS, todoBoxCategoryId: '3', newTodoCategoryId: '12', tomatoTimeDefault: '45', restTimeDefault: '10', whiteNoiseVolume: '0.55' })
  assert.equal(out.todoBoxCategoryId, 3, 'categoryId-type settings become numbers so strict-equality filters work')
  assert.equal(out.newTodoCategoryId, 12)
  assert.equal(out.tomatoTimeDefault, 45)
  assert.equal(out.restTimeDefault, 10)
  assert.equal(out.whiteNoiseVolume, 0.55)
})

test('P1-2 coerceNumericSettings leaves non-numeric strings and string-declared fields alone', () => {
  const out = coerceNumericSettings({ ...DEFAULT_SETTINGS, calendarFontSize: 'large', sortMode: 'custom', tomatoTimeDefault: 'abc', todoBoxCategoryId: '' })
  assert.equal(out.calendarFontSize, 'large', 'enum/string-declared fields untouched')
  assert.equal(out.sortMode, 'custom')
  assert.equal(out.tomatoTimeDefault, 'abc', 'unparseable value is not force-cast')
  assert.equal(out.todoBoxCategoryId, '', 'empty string is not a convertible number')
})

test('P1-2 restore mutation coerces numeric settings from backup segments', () => {
  const s = {}
  categoryMutations // keep import graph warm
  const settingsMutations = settingsMod.default.mutations
  settingsMutations.restore(s, { ...DEFAULT_SETTINGS, todoBoxCategoryId: '7', tomatoTimeDefault: '50' })
  assert.equal(s.todoBoxCategoryId, 7)
  assert.equal(s.tomatoTimeDefault, 50)
})

// ---- P2-4 restoreFromRecycle verify-then-commit ----
test('P2-4 restoreFromRecycle does not consume the chip snapshot when the row restore fails', async () => {
  const dispatchCalls = []
  const ctx = {
    commit: () => {},
    dispatch: async (type, payload) => {
      dispatchCalls.push([type, payload])
      return null // row not found → updateTodoFields failed to restore anything
    }
  }
  await todoActions.restoreFromRecycle.call({}, ctx, row('gone', { delete: true }))
  assert.equal(dispatchCalls[0][0], 'updateTodoFields', 'row restore runs first')
  assert.equal(dbCalls.some(c => c[0] === 'getMeta' && String(c[1]).includes('planChipsSnapshot')), false,
    'the one-shot snapshot meta must not be consumed by a failed restore')
})

test('P2-4 restoreFromRecycle consumes the chip snapshot only after the row restore lands', async () => {
  const dispatchCalls = []
  const ctx = {
    commit: () => {},
    dispatch: async (type, payload) => { dispatchCalls.push(type); return { ok: true } }
  }
  await todoActions.restoreFromRecycle.call({}, ctx, row('a', { delete: true }))
  assert.deepEqual(dispatchCalls, ['updateTodoFields'])
  assert.equal(dbCalls.some(c => c[0] === 'getMeta' && String(c[1]).includes('planChipsSnapshot')), true,
    'successful restore writes the pre-delete chip snapshot back')
})

// ---- P2-5 reorderTodos queues a failed batch ----
test('P2-5 reorderTodos requeues the whole upsertMany batch on failure and replays it on flush', async () => {
  const live = row('a', { taskSort: 2 })
  const fakeThis = { state: { todo: { todoList: [live], recycleList: [] } } }
  dbHandler = () => Promise.reject(new Error('db down'))
  await todoActions.reorderTodos.call(fakeThis, { commit: () => {}, dispatch: async () => {} }, [{ taskId: 'a', taskSort: 9 }])
  assert.equal(pendingUpserts.length, 1, 'failed batch is queued')
  assert.equal(pendingUpserts[0].op, 'upsertMany')
  assert.equal(pendingUpserts[0].params[0].taskSort, 9)
  // next flush succeeds and drains the queue via the same op
  dbHandler = (op, params) => { dbCalls.push([op, params]); return Promise.resolve(null) }
  flushPendingUpserts()
  await waitFor(() => pendingUpserts.length === 0)
  const replay = dbCalls.find(c => c[0] === 'upsertMany')
  assert.ok(replay, 'queued batch replayed as upsertMany')
  assert.equal(replay[1][0].taskSort, 9)
})

// ---- P2-6 dayStart derives from todoTime when todoDate is missing ----
test('P2-6 addTodo with only todoTime derives dayStart from todoTime (memory matches DB)', async () => {
  const noon = startOfDayTs(Date.now()) + 13 * 3600000
  const commits = []
  const ctx = {
    state: { todoList: [] },
    rootState: { settings: {}, auth: { user: { userId: 'u' } } },
    commit: (t, p) => commits.push([t, p]),
    dispatch: async () => {}
  }
  const t = await todoActions.addTodo.call({}, ctx, { todoContent: 'x', todoDate: 0, todoTime: noon })
  assert.equal(t.todoTime, noon)
  assert.equal(t.dayStart, startOfDayTs(noon), 'dayStart no longer stuck at 0 while the DB stores a scheduled day')
})

test('P2-6 addTodo still derives dayStart from todoDate when both are given', async () => {
  const d = startOfDayTs(Date.now()) + 3 * 86400000
  const ctx = {
    state: { todoList: [] },
    rootState: { settings: {}, auth: { user: { userId: 'u' } } },
    commit: () => {},
    dispatch: async () => {}
  }
  const t = await todoActions.addTodo.call({}, ctx, { todoContent: 'y', todoDate: d })
  assert.equal(t.dayStart, startOfDayTs(d))
  assert.equal(t.todoTime, d, 'todoTime falls back to the date as before')
})

// ---- P2-7 resolveFocusedTask ----
test('P2-7 resolveFocusedTask: deleted or missing attach target books a free focus', () => {
  const rows = [row('live', { taskContent: 'Live' }), row('dead', { taskContent: 'Dead', delete: true })]
  assert.deepEqual(resolveFocusedTask({ taskId: 'live', taskContent: 'Live' }, rows), { taskId: 'live', taskContent: 'Live' })
  assert.equal(resolveFocusedTask({ taskId: 'dead', taskContent: 'Dead' }, rows), null, 'soft-deleted task → free focus, no bumpSnow')
  assert.equal(resolveFocusedTask({ taskId: 'purged', taskContent: 'Purged' }, rows), null, 'purged task → free focus')
  assert.equal(resolveFocusedTask(null, rows), null)
  assert.equal(resolveFocusedTask({ taskId: '' }, rows), null)
})

// ---- P2-8 category softDelete cleans project meta ----
test('P2-8 collectCascadeIds walks folder descendants like markCascade', () => {
  const state = { list: [
    { categoryId: 1, folderIs: true, folderId: 0 },
    { categoryId: 2, folderIs: false, folderId: 1 },
    { categoryId: 3, folderIs: true, folderId: 1 },
    { categoryId: 4, folderIs: false, folderId: 3 },
    { categoryId: 9, folderIs: false, folderId: 0 }
  ] }
  assert.deepEqual(collectCascadeIds(state, 1).sort(), [1, 2, 3, 4])
  assert.deepEqual(collectCascadeIds(state, 2), [2])
})

test('P2-8 softDelete clears projectStatus/projectDeadline meta and prunes projectIds (CLI parity)', async () => {
  const state = {
    list: [
      { categoryId: 1, folderIs: true, folderId: 0, delete: false },
      { categoryId: 2, folderIs: false, folderId: 1, delete: false }
    ],
    projectIds: [1, 2, 5],
    projectMeta: { 1: { status: 'paused' }, 2: { status: 'active' }, 5: { status: 'done' } }
  }
  const fakeThis = { commit: (type, payload) => categoryMutations.markCascade(state, payload) }
  categoryMutations.softDelete.call(fakeThis, state, 1)
  const metaDeletes = dbCalls.filter(c => c[0] === 'deleteMeta').map(c => c[1])
  assert.ok(metaDeletes.includes('projectStatus:1') && metaDeletes.includes('projectStatus:2'), 'projectStatus:<id> cleaned for every cascade victim')
  assert.ok(metaDeletes.includes('projectDeadline:1') && metaDeletes.includes('projectDeadline:2'), 'projectDeadline:<id> cleaned alongside')
  assert.deepEqual(state.projectIds, [5], 'deleted ids pruned from the project flag list')
  assert.equal(state.projectMeta[1], undefined)
  assert.equal(state.projectMeta[5].status, 'done', 'unrelated project meta untouched')
  assert.equal(state.list[0].delete, true, 'delete flag still applied')
})
