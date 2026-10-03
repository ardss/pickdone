/**
 * D15 domain-2 (renderer store hot paths) — regression guards, wave maint/deep-r2 (2026-10-03).
 * Fixes covered:
 *   B2  repeat renewal reads the LIVE per-task meta estimate (tomatoEstimateState:<taskId>) and
 *       clamps — same semantic as the CLI twin (cli/lib.js:436-439); seeding the renewal with the
 *       completed row's post-X2 estimate COLUMN (accumulated focusMinutes) is gone
 *   B9  habits/applyExternalPatch rejects savedAt TIES like its sibling applyExternal (shared
 *       isStaleExternalRound predicate — one staleness contract for the module)
 *   B11 dead tomato preference keys (enableBeep / preTomatoTimes / preRestTimes) are gone from
 *       the module defaults AND stripped from old persisted blobs
 *   B14 tomato/updateRecordTask keeps the denormalized `focus` name text in sync with
 *       focusTaskId in the SAME write (in-memory row + ledger patch)
 * Run: node --test tests/unit/renderer/d15-domain2-store-hotpaths.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

/* ---------- stub bridge (installed BEFORE the store imports, like d5-store-fixes) ---------- */

const quitHooks = []
const dbCalls = []
const metaStore = new Map()
const dbImpl = async () => 'ok'

if (!globalThis.window.location) globalThis.window.location = { hash: '' }
globalThis.window.todoAPI = {
  dbCall: async (op, params) => {
    dbCalls.push([op, params])
    if (op === 'getMeta') return metaStore.has(params) ? metaStore.get(params) : null
    if (op === 'setMeta') { metaStore.set(params[0], params[1]); return 'ok' }
    if (op === 'deleteMeta') { metaStore.delete(params); return 'ok' }
    return dbImpl(op, params)
  },
  notification: () => {},
  onAppQuittingFlush: fn => quitHooks.push(fn)
}
const callsOf = op => dbCalls.filter(([o]) => o === op).map(([, p]) => p)
const resetCalls = () => { dbCalls.length = 0 }

const today0 = globalThis.window.dayjs().startOf('day').valueOf()

/* Seed an OLD-format tomato blob (carries the since-B11-dead keys) BEFORE importing tomato.js so
   loadState()'s residue sweep is exercised on the real startup path. */
globalThis.localStorage.setItem('tomatoState', JSON.stringify({
  status: 'default', enableBeep: true, preTomatoTimes: [25, 45], preRestTimes: [5], tomatoTime: 30, restTime: 6, schemaV: 1
}))

const tomatoMod = await import('../../../renderer/js/store/tomato.js')
const tomato = tomatoMod.default
const { _setTodoPoolStore } = tomatoMod
const todo = (await import('../../../renderer/js/store/todo.js')).default
const habits = (await import('../../../renderer/js/store/habits.js')).default
const { isStaleExternalRound } = await import('../../../renderer/js/store/habits.js')

/* ---------------- B2: renewal reads the LIVE meta estimate + clamps ---------------- */

function renewalFixture (estimateColumn) {
  const completed = {
    taskId: 't_done_b2', repeatId: 'd15b2', dayStart: today0, todoTime: today0, categoryId: 0,
    taskContent: 'recurring b2', taskDescribe: '', priority: 0, deadlineTs: 0,
    important: 0, urgent: 0, estimate: estimateColumn, reminderTime: 0, reminderOffsets: [], reminderExtra: [], subtasks: null, difficulty: 2
  }
  const fakeThis = { state: { todo: { todoList: [{ ...completed }], holidayList: [] } } }
  const payloads = []
  const ctx = { dispatch: (n, p) => { payloads.push([n, p]); return Promise.resolve({ taskId: 't_new_b2' }) } }
  return { completed, fakeThis, ctx, payloads }
}

test('B2: renewal seeds the LIVE meta estimate (3), not the polluted focusMinutes column (150)', async () => {
  metaStore.set('repeatRule:d15b2', JSON.stringify({ repeatType: '天', repeatInterval: 1, repeatDayCount: 30 }))
  metaStore.set('tomatoEstimateState:t_done_b2', '3')
  const { completed, fakeThis, ctx, payloads } = renewalFixture(150) // column holds accumulated focus minutes
  await todo.actions.ensureNextRepeatInstance.call(fakeThis, ctx, completed)
  const add = payloads.find(([n]) => n === 'addTodo')
  assert.ok(add, 'renewal dispatched addTodo')
  assert.equal(add[1].estimate, 3, 'renewal estimate comes from the live per-task meta key, not the dead column')
  assert.equal(metaStore.get('tomatoEstimateState:t_new_b2'), '3', 'new instance meta estimate copied from the live value')
})

test('B2: no live meta key → legacy column fallback is CLAMPED to the storage domain (150 → 20)', async () => {
  metaStore.set('repeatRule:d15b2', JSON.stringify({ repeatType: '天', repeatInterval: 1, repeatDayCount: 30 }))
  metaStore.delete('tomatoEstimateState:t_done_b2')
  const { completed, fakeThis, ctx, payloads } = renewalFixture(150)
  await todo.actions.ensureNextRepeatInstance.call(fakeThis, ctx, completed)
  const add = payloads.find(([n]) => n === 'addTodo')
  assert.equal(add[1].estimate, 20, 'legacy column fallback clamped to 0..20 like the CLI twin')
  assert.equal(metaStore.get('tomatoEstimateState:t_new_b2'), '20')
})

/* ---------------- B9: applyExternalPatch rejects ties ---------------- */

test('B9: applyExternalPatch rejects a same-ms (tie) LAN fold round; older rounds too', () => {
  const s = { habits: [{ id: 'h1', name: 'local', records: {} }], moments: [], savedAt: 1000 }
  habits.mutations.applyExternalPatch(s, {
    savedAt: 1000, // TIE: the local state already recorded an equal-stamp write
    fields: { habits: [{ id: 'h1', name: 'peer-tie', records: {} }], moments: [{ id: 'm9' }] }
  })
  assert.equal(s.habits[0].name, 'local', 'tie round must NOT rewrite the habits array')
  assert.deepEqual(s.moments, [], 'tie round must NOT rewrite moments')
  assert.equal(s.savedAt, 1000, 'savedAt untouched on rejection')
  habits.mutations.applyExternalPatch(s, { savedAt: 999, fields: { habits: [{ id: 'h1', name: 'older', records: {} }] } })
  assert.equal(s.habits[0].name, 'local', 'stale round still rejected')
  habits.mutations.applyExternalPatch(s, { savedAt: 2000, fields: { habits: [{ id: 'h1', name: 'newer', records: {} }] } })
  assert.equal(s.habits[0].name, 'newer', 'a strictly newer round still applies')
  assert.equal(s.savedAt, 2000)
})

test('B9: applyExternal shares the same tie-rejecting predicate (class-complete)', () => {
  const s = { habits: [{ id: 'h1', name: 'local', records: {} }], moments: [], savedAt: 500 }
  habits.mutations.applyExternal(s, { habits: [{ id: 'h1', name: 'tie', records: {} }], savedAt: 500 })
  assert.equal(s.habits[0].name, 'local', 'applyExternal already rejected ties — pinned')
  assert.equal(isStaleExternalRound(500, 500), true, 'shared predicate: ties are stale')
  assert.equal(isStaleExternalRound(499, 500), true)
  assert.equal(isStaleExternalRound(501, 500), false)
  assert.equal(isStaleExternalRound(undefined, 0), true, 'missing/0 savedAt is stale against a saved state')
})

/* ---------------- B11: dead preference keys removed + legacy residue stripped ---------------- */

test('B11: tomato module defaults no longer carry enableBeep/preTomatoTimes/preRestTimes', () => {
  for (const k of ['enableBeep', 'preTomatoTimes', 'preRestTimes']) {
    assert.ok(!(k in tomato.state), k + ' must be gone from the live module state')
  }
})

test('B11: loadState strips the dead keys out of old persisted blobs (no sync/persist resurrection)', () => {
  // tomato.state was hydrated from the seeded legacy blob at import time (startup path)
  assert.equal(tomato.state.tomatoTime, 30, 'live keys still load normally')
  assert.equal(tomato.state.restTime, 6)
  for (const k of ['enableBeep', 'preTomatoTimes', 'preRestTimes']) {
    assert.ok(!(k in tomato.state), k + ' residue stripped from the old blob')
  }
  // The next persist must not write them back either
  tomato.mutations.patch(tomato.state, { tomatoTime: 31 })
  const blob = JSON.parse(globalThis.localStorage.getItem('tomatoState'))
  for (const k of ['enableBeep', 'preTomatoTimes', 'preRestTimes']) {
    assert.ok(!(k in blob), k + ' never re-persisted')
  }
})

/* ---------------- B14: updateRecordTask keeps the denormalized name in the same write ---------------- */

test('B14: relinking a record updates focusTaskId AND the focus name text in one write', () => {
  const s = { tomatoRecordList: [{ tomatoId: 'tmt_b14', focusTaskId: 'old', focus: 'Old Task Name', endTime: Date.now(), succeed: true }] }
  _setTodoPoolStore({ state: { todo: { todoList: [{ taskId: 'new', taskContent: 'New Task Name', delete: false }], recycleList: [] } } })
  try {
    resetCalls()
    tomato.mutations.updateRecordTask(s, { tomatoId: 'tmt_b14', focusTaskId: 'new' })
    const rec = s.tomatoRecordList[0]
    assert.equal(rec.focusTaskId, 'new')
    assert.equal(rec.focus, 'New Task Name', 'denormalized name text updated in the SAME write')
    const patch = callsOf('tomatoUpdateById').at(-1)
    assert.ok(patch, 'ledger write issued')
    assert.equal(patch.patch.focusTaskId, 'new')
    assert.equal(patch.patch.focus, 'New Task Name', 'the DB row gets the refreshed name text too')
  } finally { _setTodoPoolStore(null) }
})

test('B14: unlinking clears the name; a dead target resolves to "" (never a stale foreign name)', () => {
  _setTodoPoolStore({ state: { todo: { todoList: [{ taskId: 'alive', taskContent: 'Alive', delete: false }], recycleList: [] } } })
  try {
    const unlink = { tomatoRecordList: [{ tomatoId: 'r1', focusTaskId: 'old', focus: 'Old Task Name', endTime: Date.now(), succeed: true }] }
    tomato.mutations.updateRecordTask(unlink, { tomatoId: 'r1', focusTaskId: null })
    assert.equal(unlink.tomatoRecordList[0].focusTaskId, null)
    assert.equal(unlink.tomatoRecordList[0].focus, '', 'unlink clears the name text')

    const dead = { tomatoRecordList: [{ tomatoId: 'r2', focusTaskId: 'old', focus: 'Old Task Name', endTime: Date.now(), succeed: true }] }
    tomato.mutations.updateRecordTask(dead, { tomatoId: 'r2', focusTaskId: 'deleted-task' })
    assert.equal(dead.tomatoRecordList[0].focus, '', 'deleted/missing target resolves to "" (free-focus convention)')
  } finally { _setTodoPoolStore(null) }
})
