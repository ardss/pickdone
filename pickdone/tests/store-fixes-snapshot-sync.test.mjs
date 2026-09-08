/* Regression tests for renderer store fixes (todo.js / tomato.js):
 *  - planSnapshotRowSync: pure planner for undo/redo snapshot-replay side effects (chip sync chain)
 *  - undo/redo parse-before-pop (corrupt snapshot no longer bricks/vanishes a step)
 *  - persistSnapshotDiff replays chip sync for undone creates / undone deletes / dayStart moves
 *  - syncTodos writes critical backup even on the empty-snapshot early return
 *  - writeCriticalBackup main-window-only guard (float/quick-add windows)
 *  No electron required: minimal window/localStorage/dayjs mocks, fake commit/dispatch context.
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

// ---- env mocks (must exist before todo.js is imported: it resolves dayjs/VueI18n globals at load) ----
const DAY = 24 * 3600 * 1000
const MON = +new Date('2026-01-05T00:00:00') // a Monday
const WED = MON + 2 * DAY
globalThis.dayjs = ts => {
  const d = new Date(ts)
  const pad = n => String(n).padStart(2, '0')
  const ymd = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` // local calendar day, like real dayjs
  return {
    format: (f) => f === 'YYYY-MM-DD' ? ymd : String(ts),
    startOf: () => ({ valueOf: () => ts, format: (f) => f === 'YYYY-MM-DD' ? ymd : String(ts) }),
    valueOf: () => ts,
    isSame: () => false,
    add: () => ({ valueOf: () => ts }),
    subtract: () => ({ valueOf: () => ts }),
    hour: () => ({ minute: () => ({ second: () => ({ valueOf: () => ts }) }) })
  }
}
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
try { globalThis.navigator = { language: 'zh-CN' } } catch { /* Node >=21 exposes a read-only navigator */ }

const dbCalls = []
let dbHandler = (op, params) => { dbCalls.push([op, params]); return Promise.resolve([]) }
globalThis.window = {
  location: { hash: '' },
  todoAPI: {
    dbCall: (op, params) => dbHandler(op, params),
    writeCriticalStateBackup: () => Promise.resolve()
  }
}

const todoMod = await import('../renderer/js/store/todo.js')
const actions = todoMod.default.actions
const planSnapshotRowSync = todoMod.planSnapshotRowSync

// ---- helpers ----
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
      setTimeout(tick, 10)
    }
    tick()
  })
}

beforeEach(() => {
  dbCalls.length = 0
  globalThis.window.location.hash = ''
  dbHandler = (op, params) => { dbCalls.push([op, params]); return Promise.resolve([]) }
})

// ---- 1. pure planner ----
test('planSnapshotRowSync: undone soft-delete (before.delete=true -> active) restores the chip snapshot', () => {
  const eff = planSnapshotRowSync(row('A', { delete: true }), row('A', { updateTime: 2 }))
  assert.deepEqual(eff, [{ op: 'restoreSnapshot', taskId: 'A' }])
})

test('planSnapshotRowSync: undone create (row absent in target) snapshots+clears chips', () => {
  const eff = planSnapshotRowSync(row('B'), null)
  assert.deepEqual(eff, [{ op: 'snapshotForDelete', taskId: 'B' }])
})

test('planSnapshotRowSync: redo of an undone create restores the chip snapshot (no-op when no meta)', () => {
  const eff = planSnapshotRowSync(null, row('B', { dayStart: MON }))
  assert.deepEqual(eff, [{ op: 'restoreSnapshot', taskId: 'B' }])
})

test('planSnapshotRowSync: dayStart change plans a chip migration with raw timestamps', () => {
  const eff = planSnapshotRowSync(row('C', { dayStart: MON }), row('C', { dayStart: WED, updateTime: 2 }))
  assert.deepEqual(eff, [{ op: 'moveTaskChips', taskId: 'C', fromTs: MON, toTs: WED }])
})

test('planSnapshotRowSync: date removed / active->deleted plans clearTaskChips', () => {
  assert.deepEqual(planSnapshotRowSync(row('D', { dayStart: MON }), row('D', { dayStart: 0, updateTime: 2 })),
    [{ op: 'clearTaskChips', taskId: 'D' }])
  assert.deepEqual(planSnapshotRowSync(row('D'), row('D', { delete: true, deletedAt: 9, updateTime: 2 })),
    [{ op: 'clearTaskChips', taskId: 'D' }])
})

test('planSnapshotRowSync: untouched or plain-text-changed rows plan nothing', () => {
  assert.deepEqual(planSnapshotRowSync(row('E'), row('E', { updateTime: 2 })), [])
  assert.deepEqual(planSnapshotRowSync(null, null), [])
})

// ---- 2. undo/redo parse-before-pop ----
function fakeCtx (state) {
  const committed = []
  const dispatched = []
  const mutations = todoMod.default.mutations
  return {
    committed, dispatched,
    state,
    // Apply the real mutation so historyUndoPop/historyRedoPop actually mutate the fake stack
    commit (type, payload) { committed.push([type, payload]); if (mutations[type]) mutations[type](state, payload) },
    async dispatch (type, payload) {
      dispatched.push([type, payload])
      if (type === 'persistSnapshotDiff') return []
      return null
    }
  }
}

test('undo: corrupt snapshot JSON is dropped without mutating history/redo state (parse-before-pop)', async () => {
  const ctx = fakeCtx({
    undoStack: ['{"todoList":[],"recycleList":[]}', '{not json'],
    redoStack: [], todoList: [], recycleList: []
  })
  const r = await actions.undo(ctx)
  assert.equal(r, false)
  assert.deepEqual(ctx.state.undoStack, ['{"todoList":[],"recycleList":[]}']) // corrupt top dropped, valid step kept
  assert.deepEqual(ctx.state.redoStack, []) // no spurious redo entry pushed
  assert.ok(!ctx.committed.some(([t]) => t === 'historyRestore')) // state never restored from garbage
})

test('redo: corrupt snapshot JSON is dropped without mutating stack state (parse-before-pop)', async () => {
  const ctx = fakeCtx({
    undoStack: [], redoStack: ['{oops'], todoList: [], recycleList: []
  })
  const r = await actions.redo(ctx)
  assert.equal(r, false)
  assert.deepEqual(ctx.state.redoStack, [])
  assert.deepEqual(ctx.state.undoStack, []) // historyPushKeepRedo not run for garbage
  assert.ok(!ctx.committed.some(([t]) => t === 'historyRestore'))
})

test('undo: valid snapshot pops only after a successful parse and restores state', async () => {
  const snap = JSON.stringify({ todoList: [row('A')], recycleList: [] })
  const ctx = fakeCtx({ undoStack: [snap], redoStack: [], todoList: [row('A', { updateTime: 2 })], recycleList: [] })
  const r = await actions.undo(ctx)
  assert.equal(r.ok, true)
  assert.deepEqual(ctx.state.undoStack, [])
  assert.ok(ctx.committed.some(([t, p]) => t === 'historyRestore' && p.todoList[0].taskId === 'A'))
  assert.deepEqual(ctx.state.redoStack.map(x => JSON.parse(x).todoList[0].taskId), ['A'])
})

// ---- 3. persistSnapshotDiff runs the chip sync chain for replayed rows ----
test('persistSnapshotDiff: dayStart change in a replayed row migrates chips (planMoveTask)', async () => {
  const from = { todoList: [row('C', { dayStart: MON })], recycleList: [] }
  const to = { todoList: [row('C', { dayStart: WED, updateTime: 2 })], recycleList: [] }
  const committed = []
  await actions.persistSnapshotDiff({ commit: (t, p) => committed.push([t, p]) }, { from, to })
  await waitFor(() => dbCalls.some(([op, p]) => op === 'planMoveTask' && p.taskId === 'C'))
  assert.deepEqual(dbCalls.find(([op]) => op === 'planMoveTask')[1],
    { taskId: 'C', fromDay: '2026-01-05', toDay: '2026-01-07' })
})

test('persistSnapshotDiff: undone create (row missing in target) snapshots+clears chips like deleteTodo', async () => {
  const from = { todoList: [row('B')], recycleList: [] }
  const to = { todoList: [], recycleList: [] }
  dbHandler = (op, params) => {
    dbCalls.push([op, params])
    if (op === 'planAll') return Promise.resolve([{ taskId: 'B', day: '2026-01-05', mm: '09:00', id: 'x' }])
    return Promise.resolve([])
  }
  await actions.persistSnapshotDiff({ commit: () => {} }, { from, to })
  await waitFor(() => dbCalls.some(([op]) => op === 'planDeleteTask'))
  assert.ok(dbCalls.some(([op, p]) => op === 'setMeta' && p[0] === 'planChipsSnapshot:B')) // snapshot taken first
  assert.ok(dbCalls.some(([op, p]) => op === 'planDeleteTask' && p === 'B'))
})

test('persistSnapshotDiff: undone soft-delete restores the pre-delete chip snapshot', async () => {
  const from = { todoList: [], recycleList: [row('A', { delete: true, deletedAt: 9 })] }
  const to = { todoList: [row('A', { updateTime: 2 })], recycleList: [] }
  const chips = JSON.stringify([{ taskId: 'A', day: '2026-01-05', mm: '10:30', id: 'y' }])
  dbHandler = (op, params) => {
    dbCalls.push([op, params])
    if (op === 'getMeta') return Promise.resolve(params === 'planChipsSnapshot:A' ? chips : null)
    return Promise.resolve([])
  }
  await actions.persistSnapshotDiff({ commit: () => {} }, { from, to })
  await waitFor(() => dbCalls.some(([op]) => op === 'planAddMany'))
  assert.ok(dbCalls.some(([op, p]) => op === 'planAddMany' && JSON.stringify(p) === JSON.stringify(JSON.parse(chips))))
})

// ---- 4. syncTodos: critical backup runs even on the empty-snapshot early return ----
test('syncTodos: empty snapshot still dispatches writeCriticalBackup (moved into finally)', async () => {
  const ctx = fakeCtx({ isSyncing: false, todoList: [], recycleList: [], version: 1 })
  await actions.syncTodos(ctx)
  assert.ok(ctx.dispatched.some(([t]) => t === 'writeCriticalBackup'))
  assert.equal(ctx.state.isSyncing, false)
})

test('syncTodos: critical backup also dispatched after a db failure', async () => {
  const ctx = fakeCtx({ isSyncing: false, todoList: [row('A', { status: 'update' })], recycleList: [], version: 1 })
  dbHandler = () => Promise.reject(new Error('db down'))
  await actions.syncTodos(ctx)
  assert.ok(ctx.dispatched.some(([t]) => t === 'writeCriticalBackup'))
})

// ---- 5. writeCriticalBackup main-window-only guard ----
test('writeCriticalBackup: float/quick-add windows early-return without arming the backup timer', async () => {
  globalThis.window.location.hash = '#/__tomato-float'
  let writeAttempts = 0
  globalThis.window.todoAPI.writeCriticalStateBackup = () => { writeAttempts++; return Promise.resolve() }
  const self = {}
  actions.writeCriticalBackup.call(self, { state: { todoList: [], recycleList: [] }, rootState: { settings: {} } })
  assert.equal(self._cbTimer, undefined) // no debounce timer armed in aux windows
  assert.equal(writeAttempts, 0)
  globalThis.window.location.hash = ''
})

test('writeCriticalBackup: main window arms the debounced write and swallows IPC rejections', async () => {
  let writeAttempts = 0
  globalThis.window.todoAPI.writeCriticalStateBackup = () => { writeAttempts++; return Promise.reject(new Error('main-window-only')) }
  const self = {}
  actions.writeCriticalBackup.call(self, {
    state: { todoList: [], recycleList: [], search: '', version: 1, remoteVersion: 0, todayTimestamp: 0, ignoreReminder: 0, todosVersion: 0 },
    rootState: { settings: {}, auth: { user: {}, lastLoginRecord: null }, tomato: null, category: { list: [] }, habits: {} }
  })
  assert.ok(self._cbTimer)
  await new Promise(r => setTimeout(r, 900)) // 800ms debounce fires; rejection must be caught, not unhandled
  assert.equal(writeAttempts, 1)
  clearTimeout(self._cbTimer)
})
