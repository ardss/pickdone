/**
 * R8 (render store domain) — W8 fix round regression guards.
 * Fixes covered:
 *   [F1] undo snapshot replay re-stamps updateTime (restore-wins) — LAN LWW can no longer roll an undo back
 *   [F2] habits per-day un-check tombstones (`uncheckedAt` inside the habit object): peer union-max can no
 *        longer resurrect an un-checked day, the tombstone propagates, and re-checking clears it
 *   [F3] habits blob schemaV downgrade guard (replaceAll refuses a future-version blob, no mirror write-back)
 *   [F4] filterNameTaken compares ids via String() (numeric DB id vs string route param)
 *   [F5] isOwnMirrorStamp exact-stamp-set matching (same-stamp echo suppressed; older-but-foreign stamps pass)
 *   [F6] addTodo dayOverride-only converges memory dayStart and DB scheduledDay (todoTime = day midnight)
 * Run: node --test tests/unit/renderer/w8-store.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

if (!globalThis.window.location) globalThis.window.location = { hash: '' }

/* stub bridge BEFORE importing the stores (f3-habits / w7 pattern) */
const metaStore = new Map()
const dbRows = [] // rows written via the 'upsert' op (commandBus maps todo.put → upsert; params IS the row)
const durableIds = new Set(['t1']) // undo's purged-generation guard reads getAll — t1 exists durably
globalThis.window.todoAPI = {
  dbCall: async (op, params) => {
    if (op === 'getMeta') return metaStore.has(params) ? metaStore.get(params) : null
    if (op === 'setMeta') { metaStore.set(params[0], params[1]); return 'ok' }
    if (op === 'upsert') { dbRows.push(params); if (params && params.taskId) durableIds.add(params.taskId); return 'ok' }
    if (op === 'getAll') return Array.from(durableIds, id => ({ taskId: id }))
    return 'ok'
  }
}
const tick = () => new Promise(r => setTimeout(r, 0))

/* ---------- [F1] undo snapshot replay re-stamps updateTime ---------- */

test('F1: persistSnapshotDiffCore re-stamps changed rows with a fresh updateTime (restore-wins)', async () => {
  const { persistSnapshotDiffCore } = await import('../../../renderer/js/store/helpers/undo.js')
  const oldStamp = Date.now() - 60_000
  const snapRow = { taskId: 't1', taskContent: 'restored', updateTime: oldStamp, status: 'update' }
  const from = { todoList: [{ ...snapRow, taskContent: 'edited', updateTime: Date.now() - 1000 }], recycleList: [] }
  const to = { todoList: [snapRow], recycleList: [] }
  const upserted = []
  const commits = []
  const changed = await persistSnapshotDiffCore(
    { commit: (type, p) => commits.push([type, p]) },
    { from, to, allowDeletes: true },
    row => upserted.push(row)
  )
  assert.equal(changed.length, 1)
  const row = upserted[0]
  assert.ok(row.updateTime > oldStamp, `row updateTime (${row.updateTime}) must be newer than the snapshot's stale stamp (${oldStamp})`)
  assert.ok(row.updateTime >= Date.now() - 5000, 'the re-stamp is a fresh now()')
  // memory and DB receive the SAME re-stamped row (no fork between upsertLocal and safeUpsert)
  const localCommit = commits.find(c => c[0] === 'upsertLocal')
  assert.equal(localCommit[1].updateTime, row.updateTime)
})

/* ---------- [F2] habits un-check tombstones ---------- */

const habits = (await import('../../../renderer/js/store/habits.js')).default
const { unionUncheckedAt } = await import('../../../renderer/js/store/habits.js')

const DAY = '2026-10-25'

function freshState () {
  const s = habits.state()
  s.habits = [{ id: 'h1', name: 'H', createdAt: Date.now() - 86400000 * 10, frequency: { type: 'daily' }, records: {}, uncheckedAt: {}, recordsAt: {} }]
  s.savedAt = 0
  return s
}

test('F2.1: un-check records a tombstone; a newer peer union-max blob cannot resurrect the day', () => {
  const s = freshState()
  habits.mutations.toggleCheck(s, { id: 'h1', day: DAY }) // check
  assert.equal(s.habits[0].records[DAY], true)
  const checkTs = Date.now()
  habits.mutations.toggleCheck(s, { id: 'h1', day: DAY }) // un-check
  assert.equal(s.habits[0].records[DAY], undefined)
  assert.ok((Number(s.habits[0].uncheckedAt[DAY]) || 0) >= checkTs, 'un-check recorded a per-day tombstone timestamp')
  // the tombstone rides INSIDE the habit object → persists into the DB blob verbatim
  const blob = JSON.parse(metaStore.get('db.habitsState'))
  assert.equal(blob.habits[0].uncheckedAt[DAY], s.habits[0].uncheckedAt[DAY], 'tombstone survives persist (no new top-level blob key needed)')
  // peer blob (newer savedAt) still carries the check-in: applyExternal must NOT resurrect the day
  habits.mutations.applyExternal(s, { savedAt: Date.now() + 5000, habits: [{ ...s.habits[0], records: { [DAY]: true }, uncheckedAt: {} }], moments: [], deleted: [], deletedMoments: [] })
  assert.equal(s.habits[0].records[DAY], undefined, 'the newer peer round must not resurrect the un-checked day')
  // and the merged tombstone survived the inbound merge (propagates back to the peer)
  assert.ok(Number(s.habits[0].uncheckedAt[DAY]) > 0, 'the tombstone survives the inbound merge (union-max)')
})

test('F2.2: applyExternalPatch inbound is filtered the same way; tombstones union-max per day', () => {
  const s = freshState()
  s.habits[0].records[DAY] = true
  // un-check locally, then a newer peer patch carrying the old check-in
  habits.mutations.toggleCheck(s, { id: 'h1', day: DAY })
  const tombTs = Number(s.habits[0].uncheckedAt[DAY])
  habits.mutations.applyExternalPatch(s, { savedAt: Date.now() + 9000, fields: { habits: [{ ...s.habits[0], records: { [DAY]: true }, uncheckedAt: {} }] } })
  assert.equal(s.habits[0].records[DAY], undefined, 'patch channel filtered by the tombstone too')
  assert.equal(Number(s.habits[0].uncheckedAt[DAY]), tombTs)
  // union-max: an older tombstone on one side never beats a newer one
  assert.equal(unionUncheckedAt({ [DAY]: 100 }, { [DAY]: 200 })[DAY], 200)
  assert.equal(unionUncheckedAt({ [DAY]: 300 }, { other: 50 })[DAY], 300)
})

test('F2.3: re-check clears the tombstone — a later peer merge restores the day', () => {
  const s = freshState()
  habits.mutations.toggleCheck(s, { id: 'h1', day: DAY })
  habits.mutations.toggleCheck(s, { id: 'h1', day: DAY }) // un-check (tombstone set)
  habits.mutations.toggleCheck(s, { id: 'h1', day: DAY }) // re-check
  assert.equal(s.habits[0].records[DAY], true)
  assert.equal(s.habits[0].uncheckedAt[DAY], undefined, 're-check cleared the tombstone')
  // now a peer blob carrying the check-in merges cleanly (nothing left to filter)
  habits.mutations.applyExternal(s, { savedAt: Date.now() + 5000, habits: [{ ...s.habits[0], records: { [DAY]: true }, uncheckedAt: {} }], moments: [], deleted: [], deletedMoments: [] })
  assert.equal(s.habits[0].records[DAY], true, 'day restored after re-check')
})

test('F2.4: setCheck parity — off records the tombstone, on clears it', () => {
  const s = freshState()
  s.habits[0].records[DAY] = true
  habits.mutations.setCheck(s, { id: 'h1', day: DAY, on: false })
  assert.ok(Number(s.habits[0].uncheckedAt[DAY]) > 0)
  habits.mutations.setCheck(s, { id: 'h1', day: DAY, on: true })
  assert.equal(s.habits[0].uncheckedAt[DAY], undefined)
})

test('F2.5: a peer check-in stamped AFTER the un-check wins; a stampless legacy record loses', () => {
  const s = freshState()
  habits.mutations.toggleCheck(s, { id: 'h1', day: DAY }) // check
  habits.mutations.toggleCheck(s, { id: 'h1', day: DAY }) // un-check → tombstone at T0
  const tombTs = Number(s.habits[0].uncheckedAt[DAY])
  // peer round: the other device checked in AFTER our un-check was written (its recordsAt is newer
  // than the tombstone) → its check-in survives arbitration
  habits.mutations.applyExternal(s, { savedAt: tombTs + 10_000, habits: [{ ...s.habits[0], records: { [DAY]: true }, recordsAt: { [DAY]: tombTs + 1000 }, uncheckedAt: {} }], moments: [], deleted: [], deletedMoments: [] })
  assert.equal(s.habits[0].records[DAY], true, 'a check-in written after the un-check wins')
  // legacy shape: an old peer copy whose record carries NO recordsAt stamp reads as 0 → tombstone wins
  const s2 = freshState()
  habits.mutations.toggleCheck(s2, { id: 'h1', day: DAY })
  habits.mutations.toggleCheck(s2, { id: 'h1', day: DAY })
  habits.mutations.applyExternal(s2, { savedAt: tombTs + 20_000, habits: [{ id: 'h1', name: 'H', records: { [DAY]: true } }], moments: [], deleted: [], deletedMoments: [] })
  assert.equal(s2.habits[0].records[DAY], undefined, 'a stampless legacy record cannot resurrect the un-checked day')
})

/* ---------- [F3] habits blob schemaV downgrade guard ---------- */

test('F3: replaceAll refuses a future-version blob (state + LS untouched)', () => {
  const s = freshState()
  s.habits = []
  s.savedAt = 100
  const before = JSON.stringify(habits.state ? null : null)
  habits.mutations.replaceAll(s, { schemaV: 999, savedAt: 500, habits: [{ id: 'future', records: {} }], moments: [], deleted: [], deletedMoments: [] })
  assert.deepEqual(s.habits, [], 'the future blob was NOT applied')
  assert.equal(s.savedAt, 100, 'savedAt untouched')
  const lsAfter = globalThis.localStorage.getItem('habitsState')
  // the guard must run before the LS rewrite — no mirror write-back of the future blob
  assert.ok(!lsAfter || !JSON.parse(lsAfter).habits.some(h => h.id === 'future'), 'LS was not rewritten with the future blob')
  void before
})

test('F3b: replaceAll still accepts current/unstamped blobs (v1 behavior unchanged)', () => {
  const s = freshState()
  s.savedAt = 100
  habits.mutations.replaceAll(s, { savedAt: 500, habits: [{ id: 'ok', records: {} }], moments: [], deleted: [], deletedMoments: [] })
  assert.equal(s.habits.length, 1)
  assert.equal(s.habits[0].id, 'ok')
  habits.mutations.replaceAll(s, { schemaV: 1, savedAt: 600, habits: [{ id: 'ok2', records: {} }], moments: [], deleted: [], deletedMoments: [] })
  assert.equal(s.habits[0].id, 'ok2')
})

/* ---------- [F4] filterNameTaken String ids ---------- */

test('F4: numeric DB id vs string route param no longer trips the duplicate-name guard', async () => {
  const { filterNameTaken } = await import('../../../renderer/js/store/filters.js')
  const list = [{ id: 5, name: 'Work' }]
  assert.equal(filterNameTaken(list, 'Work', '5'), false, 'same filter, id in the other type → not "taken"')
  assert.equal(filterNameTaken(list, 'Work', 5), false)
  assert.equal(filterNameTaken(list, 'Work', 6), true, 'a genuinely different filter still trips it')
  assert.equal(filterNameTaken(list, '  Work  ', 7), true, 'names still trimmed')
})

/* ---------- [F5] isOwnMirrorStamp exact set ---------- */

test('F5: same-stamp echo suppressed, foreign-but-old stamps no longer swallowed', async () => {
  const { isOwnMirrorStamp, mirrorToDb } = await import('../../../renderer/js/utils/dbMirror.js')
  const KEY = 'db.settingsState'
  const t1 = 1_000_000
  const t2 = 2_000_000
  mirrorToDb(KEY, { _savedAt: t1 }, true)
  mirrorToDb(KEY, { _savedAt: t2 }, true)
  assert.equal(isOwnMirrorStamp(KEY, t1), true, 'own generation (older, in-window) still recognized as own echo')
  assert.equal(isOwnMirrorStamp(KEY, t2), true, 'same-stamp echo suppressed')
  assert.equal(isOwnMirrorStamp(KEY, 1_500_000), false, 'a foreign stamp BETWEEN our own generations is no longer swallowed by the watermark')
  assert.equal(isOwnMirrorStamp(KEY, 500), false, 'an old foreign stamp passes through')
  assert.equal(isOwnMirrorStamp(KEY, undefined), false)
})

test('F5b: the own-stamp set is bounded (no unbounded growth)', async () => {
  const { isOwnMirrorStamp, mirrorToDb } = await import('../../../renderer/js/utils/dbMirror.js')
  const KEY = 'db.boundedProbe'
  for (let i = 0; i < 20; i++) mirrorToDb(KEY, { _savedAt: 10_000 + i }, true)
  assert.equal(isOwnMirrorStamp(KEY, 10_000), false, 'the oldest generation fell out of the recall window')
  assert.equal(isOwnMirrorStamp(KEY, 10_019), true, 'the newest generation is still own')
})

/* ---------- [F6] addTodo dayOverride convergence ---------- */

test('F6: dayOverride-only add converges memory dayStart and the DB scheduledDay', async () => {
  const todoMod = await import('../../../renderer/js/store/todo.js')
  const dayjs = globalThis.window.dayjs
  const day0 = +dayjs('2026-10-25').startOf('day')
  const local = []
  const ctx = {
    state: { todoList: [], _histEpoch: 0 },
    rootState: { settings: {}, auth: { user: { userId: 'u' } } },
    commit: (type, p) => { if (type === 'upsertLocal') local.push(p) },
    dispatch: async () => {}
  }
  const t = await todoMod.default.actions.addTodo.call({}, ctx, { todoContent: 'override only', dayOverride: day0 })
  assert.equal(t.dayStart, day0, 'memory dayStart = dayOverride')
  assert.equal(+dayjs(t.todoTime).startOf('day'), day0, 'todoTime set to the day local midnight (db-rows keeps the caller-carried scheduledDay only when todoTime is truthy)')
  await tick()
  const row = dbRows.find(r => r && r.taskId === t.taskId)
  assert.ok(row, 'the row reached the DB bridge')
  assert.equal(row.todoTime, t.todoTime, 'DB row todoTime = converging midnight value')
  assert.equal(+dayjs(row.dayStart).startOf('day'), day0, 'DB row dayStart = dayOverride (db.js re-derivation converges)')
  assert.ok(local.some(r => r.taskId === t.taskId))
})

test('F6b: effectiveDay prefers dayOverride even when todoDate points elsewhere', async () => {
  const todoMod = await import('../../../renderer/js/store/todo.js')
  const dayjs = globalThis.window.dayjs
  const overrideDay = +dayjs('2026-11-05').startOf('day')
  const otherDay = +dayjs('2026-10-01').startOf('day')
  const ctx = {
    state: { todoList: [] },
    rootState: { settings: {}, auth: { user: { userId: 'u' } } },
    commit: () => {},
    dispatch: async () => {}
  }
  const t = await todoMod.default.actions.addTodo.call({}, ctx, { todoContent: 'override wins', todoDate: otherDay, dayOverride: overrideDay })
  assert.equal(t.dayStart, overrideDay, 'dayStart follows dayOverride, not todoDate')
  assert.equal(+dayjs(t.todoTime).startOf('day'), overrideDay, 'dayOverride also converges todoTime so the DB scheduledDay derivation lands on the override day')
})
