/* Regression tests for the renderer store/utils domain fixes:
 *  - #1 deproxyRows: nested reactive proxies survive a shallow spread and break IPC structured cloning;
 *    JSON round-trip produces cloneable plain rows (reorderTodos / syncTodos now use it like safeUpsert)
 *  - #2 purgeIds / purgeAllRecycle clear the undo history so undo can never resurrect hard-deleted rows
 *  - #3 toggleComplete / reorderTodos / restoreFromRecycle break the 400ms undo merge window
 *  - #4 quit-flush of pending task upserts requeues failures (no silent loss, mirrors tomato ledger)
 *  - #6 habit.records normalization for old backups missing the field (readLs / replaceAll path)
 *  - #7/#8 taskMenu one-step backfill: dateKey derives from endTime (DB re-derives from endTime),
 *    idempotent id shape tmt_m_<startTs>_<minutes>_<taskId-suffix>, clamp 1..600 (DB single source)
 * No electron required: minimal window/localStorage/dayjs mocks.
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
dayjsModule.startOf = ts => mkDayjs(startOfDayTs(ts))
globalThis.dayjs = dayjsModule
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
try { globalThis.navigator = { language: 'zh-CN' } } catch { /* Node >=21 exposes a read-only navigator */ }

const dbCalls = []
let dbHandler = (op, params) => { dbCalls.push([op, params]); return Promise.resolve(null) }
globalThis.window = {
  location: { hash: '' },
  dayjs: dayjsModule,
  todoAPI: {
    dbCall: (op, params) => dbHandler(op, params),
    writeCriticalStateBackup: () => Promise.resolve(),
    purgeRecycleBin: () => Promise.resolve(true)
  }
}

const todoMod = await import('../../../renderer/js/store/todo.js')
const todoActions = todoMod.default.actions
const { deproxyRows, safeUpsert, flushPendingUpserts, pendingUpserts } = todoMod._testInternals

const habitsMod = await import('../../../renderer/js/store/habits.js')
const habitsMutations = habitsMod.default.mutations
const { normalizeHabitRecords } = habitsMod

const { buildTaskMenu } = await import('../../../renderer/js/utils/taskMenu.js')

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
  globalThis.window.todoAPI.dbCall = (op, params) => dbHandler(op, params)
})

// ---- #1 de-proxy round-trip ----
test('#1 nested proxies survive a shallow spread and break structuredClone; deproxyRows fixes it', () => {
  const offsets = new Proxy([5, 10], {})
  const shallow = { ...row('a', { reminderOffsets: offsets }) }
  assert.throws(() => structuredClone(shallow), undefined,
    'precondition: shallow spread leaves the nested proxy in place and IPC cloning must fail')
  const plain = deproxyRows([shallow])
  const back = structuredClone(plain) // must not throw
  assert.deepEqual(back[0].reminderOffsets, [5, 10])
  assert.equal(Object.getPrototypeOf(plain[0].reminderOffsets), Array.prototype)
})

test('#1 deproxyRows drops proxy wrappers while keeping values', () => {
  const nested = new Proxy({ deep: new Proxy([1], {}) }, {})
  const out = deproxyRows([{ taskId: 'x', sub: nested }])
  assert.equal(out[0].sub.deep[0], 1)
  assert.doesNotThrow(() => structuredClone(out))
})

// ---- #2 purge clears undo history ----
test('#2 purgeIds clears history after a successful hard delete (no resurrect via undo)', async () => {
  const commits = []
  const ctx = {
    commit: (t, p) => commits.push([t, p]),
    dispatch: async () => ({}),
    rootState: {}
  }
  dbHandler = op => (op === 'hardDelete' ? Promise.resolve(true) : Promise.resolve(null))
  await todoActions.purgeIds.call({}, ctx, ['a', 'b'])
  const hardRemoveIdx = commits.findIndex(c => c[0] === 'hardRemove')
  const clearIdx = commits.findIndex(c => c[0] === 'historyClear')
  assert.ok(hardRemoveIdx >= 0, 'hardRemove committed')
  assert.ok(clearIdx > hardRemoveIdx, 'historyClear only after the rows are really gone')
})

test('#2 purgeIds does not clear history when every hardDelete failed', async () => {
  const commits = []
  dbHandler = () => Promise.reject(new Error('db down'))
  await todoActions.purgeIds.call({}, { commit: (t, p) => commits.push([t, p]), dispatch: async () => ({}), rootState: {} }, ['a'])
  assert.equal(commits.some(c => c[0] === 'historyClear'), false)
  assert.equal(commits.some(c => c[0] === 'hardRemove'), false)
})

test('#2 purgeAllRecycle clears history after emptying the bin', async () => {
  const commits = []
  const state = { recycleList: [row('a', { delete: true }), row('b', { delete: true })] }
  await todoActions.purgeAllRecycle.call({}, { commit: (t, p) => commits.push([t, p]), dispatch: async () => ({}), state })
  const hardRemoveIdx = commits.findIndex(c => c[0] === 'hardRemove')
  const clearIdx = commits.findIndex(c => c[0] === 'historyClear')
  assert.ok(hardRemoveIdx >= 0)
  assert.ok(clearIdx > hardRemoveIdx, 'historyClear strictly after hardRemove')
})

// ---- #3 break the 400ms merge window ----
test('#3 toggleComplete breaks the undo merge after the update lands', async () => {
  const commits = []
  const t = row('a', { complete: false })
  const ctx = {
    state: { todoList: [t] },
    commit: (ty, p) => commits.push([ty, p]),
    dispatch: async (type, payload) => {
      assert.equal(type, 'updateTodoFields')
      return { ok: true }
    },
    rootState: { settings: {}, auth: { user: { userId: 'u' } } }
  }
  await todoActions.toggleComplete.call({}, ctx, t)
  assert.equal(commits.some(c => c[0] === 'historyBreakMerge'), true)
})

test('#3 restoreFromRecycle breaks the undo merge after the restore lands', async () => {
  const commits = []
  const ctx = {
    commit: (ty, p) => commits.push([ty, p]),
    dispatch: async () => ({ ok: true })
  }
  await todoActions.restoreFromRecycle.call({}, ctx, row('a'))
  assert.equal(commits.some(c => c[0] === 'historyBreakMerge'), true)
})

test('#3 reorderTodos breaks the undo merge and de-proxies the upsertMany batch', async () => {
  const commits = []
  const offsets = new Proxy([3], {})
  const live = row('a', { taskSort: 2, reminderOffsets: offsets })
  const fakeThis = { state: { todo: { todoList: [live], recycleList: [] } } }
  await todoActions.reorderTodos.call(fakeThis, {
    commit: (t, p) => commits.push([t, p]),
    dispatch: async () => {}
  }, [{ taskId: 'a', taskSort: 9 }])
  const up = dbCalls.find(c => c[0] === 'upsertMany')
  assert.ok(up, 'upsertMany issued')
  assert.doesNotThrow(() => structuredClone(up[1]), 'batch must be cloneable (no proxy residue)')
  assert.equal(up[1][0].taskSort, 9)
  assert.equal(up[1][0].reminderOffsets[0], 3)
  assert.equal(commits.some(c => c[0] === 'historyBreakMerge'), true)
})

// ---- #4 quit-flush failure requeue ----
test('#4 flushPendingUpserts requeues failed entries and replays them on the next flush', async () => {
  safeUpsert(row('a', { taskContent: 'keep' }))
  assert.equal(pendingUpserts.length, 1)
  dbHandler = () => Promise.reject(new Error('ipc down at quit'))
  flushPendingUpserts()
  await waitFor(() => false, 30).catch(() => {}) // let rejections settle
  await new Promise(r => setTimeout(r, 20))
  assert.equal(pendingUpserts.length, 1, 'failed entry is back in the queue')
  // next flush succeeds
  dbHandler = op => { dbCalls.push([op]); return Promise.resolve(null) }
  flushPendingUpserts()
  await waitFor(() => pendingUpserts.length === 0)
})

// ---- #6 habits records normalization ----
test('#6 normalizeHabitRecords backfills missing records maps', () => {
  const habits = [{ id: 'h1', name: 'no-records' }, { id: 'h2', records: null }, { id: 'h3', records: { '2026-01-01': true } }, null]
  normalizeHabitRecords(habits)
  assert.deepEqual(habits[0].records, {})
  assert.deepEqual(habits[1].records, {})
  assert.deepEqual(habits[2].records, { '2026-01-01': true })
})

test('#6 replaceAll (DB restore path) normalizes habits missing records', () => {
  const s = { habits: [], moments: [], savedAt: 0 }
  habitsMutations.replaceAll(s, { habits: [{ id: 'h1', name: 'old backup' }], moments: [], savedAt: 99 })
  assert.deepEqual(s.habits[0].records, {})
})

// ---- #7/#8 taskMenu backfill ----
function backfillCommit (promptValue) {
  const commits = []
  const task = row('task-12345678', { taskContent: 'My Task' })
  const vm = {
    $t: k => k,
    $store: {
      state: { todo: { todoList: [task] }, tomato: {} },
      commit: (ty, p) => commits.push([ty, p]),
      dispatch: async () => {}
    },
    $message: { success: () => {} },
    $prompt: () => Promise.resolve({ value: promptValue })
  }
  const menu = buildTaskMenu(vm, task, {}, [])
  const item = menu.find(i => i.icon === 'timer')
  assert.ok(item, 'backfill menu item present')
  return Promise.resolve(item.fn()).then(() => commits)
}

test('#7 backfill dateKey derives from endTime (DB re-derives from endTime, never from startTs)', async () => {
  const commits = await backfillCommit('25')
  const rec = commits.find(c => c[0] === 'tomato/addRecord')[1]
  const endTime = rec.endTime
  assert.equal(rec.dateKey, ymdOf(endTime))
  // cross-midnight backfill: startTs on the previous day must NOT leak into dateKey
  const startTs = endTime - rec.focusDuration * 60000
  if (ymdOf(startTs) !== ymdOf(endTime)) {
    assert.notEqual(rec.dateKey, ymdOf(startTs))
  }
})

test('#8 backfill id shape matches the CLI contract and duration clamps to 600', async () => {
  const commits = await backfillCommit('9999')
  const rec = commits.find(c => c[0] === 'tomato/addRecord')[1]
  assert.equal(rec.focusDuration, 600, 'clamped to the DB-layer single source')
  assert.match(rec.tomatoId, /^tmt_m_\d+_600_12345678$/, 'id = tmt_m_<startTs>_<minutes>_<taskId slice(-8)>')
})

test('#8 backfill without a task uses the free-slot id suffix', async () => {
  const commits = []
  const task = { taskId: '', taskContent: '', delete: false }
  const vm = {
    $t: k => k,
    $store: {
      state: { todo: { todoList: [task] }, tomato: {} },
      commit: (ty, p) => commits.push([ty, p]),
      dispatch: async () => {}
    },
    $message: { success: () => {} },
    $prompt: () => Promise.resolve({ value: '25' })
  }
  const menu = buildTaskMenu(vm, task, {}, [])
  const item = menu.find(i => i.icon === 'timer')
  await item.fn()
  const rec = commits.find(c => c[0] === 'tomato/addRecord')[1]
  assert.match(rec.tomatoId, /^tmt_m_\d+_25_free$/)
  assert.equal(rec.focusTaskId, '')
})
