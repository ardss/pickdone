/* Renderer store consistency fixes, 2026-10-09 wave:
 * [1] HIGH tomatoPendingQueue: an entry whose per-entry LS mirror write THREW at enqueue time
 *     must not be dropped by peerSettled's "LS key absent ⇒ peer settled it" inference — the
 *     key never existed, no peer settled it. Marked mirrorFailed at enqueue; replay/flush
 *     dispatch it anyway (ledger + snow ops are idempotent).
 * [2] MEDIUM planChips/dayPlans: undoing a date removal (from dayStart 0 → dated) emitted
 *     moveTaskChips(fromTs: 0) which early-returns — the 'planChipsSnapshot:<id>' meta written
 *     by the removal was never consumed, chips permanently orphaned. Both the planner
 *     (planSnapshotRowSync) and the direct-edit channel (rowChipSync) now restore the snapshot.
 * [3] LOW todoComputeViews: a task due TODAY completed YESTERDAY fell out of todayDoneList
 *     (grouped by completion time) and out of recentExpiredCompleted (strict dayStart < today)
 *     — vanished from every grouped surface. Loop 2 relaxed to dayStart <= today.
 * [4] MEDIUM/LOW tomato: syncFromStorage no longer merges the peer blob's per-window counters
 *     (todayTomatoCount/_countDate/_countedFocus/attachTodo); giveUp books sub-minute abandons
 *     as focusDuration: 0 instead of a phantom Math.max(1, ...) minute.
 * Run: node --test tests/unit/store/fix-20261009-store-consistency.test.mjs
 */
import '../../setup.mjs'
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { todayMidnightMs } from '../../lib/clock.mjs'

const LS = globalThis.localStorage
const drain = () => new Promise(r => setTimeout(r, 30))

const dbCalls = [] // every [op, params] the fake bridge saw
let dbImpl = async () => []
const meta = new Map()
let chips = []
function installBridge () {
  globalThis.window.todoAPI = {
    dbCall: async (op, params) => { dbCalls.push([op, params]); return dbImpl(op, params) },
    onAppQuittingFlush: () => {}
  }
}

beforeEach(() => {
  dbCalls.length = 0
  meta.clear()
  chips = []
  dbImpl = planBridge // default per-test bridge (tests 1/2 override it with their own stubs)
  installBridge()
})

/* ---------------- [1] mirror-failed queue entries survive peerSettled ---------------- */

test('[1] ledger: an entry whose LS mirror write threw is still dispatched on the next replay', async () => {
  dbImpl = async () => ({ accepted: 1, rejected: [] })
  const tq = await import('../../../renderer/js/store/helpers/tomatoPendingQueue.js?fix1009-mirror-ledger')
  const origSet = LS.setItem.bind(LS)
  // Simulate storage failure at enqueue time: every pending-ledger mirror write throws.
  LS.setItem = (k, v) => { if (String(k).startsWith('tomatoPendingLedger.')) throw new Error('QuotaExceededError') ; origSet(k, v) }
  let threw = false
  try { tq.ledgerWrite('tomatoAppendMany', { tomatoId: 'tmt_mf1', endTime: 1, dateKey: '2026-10-09', focusDuration: 3 }) } catch (e) { threw = true }
  LS.setItem = origSet
  assert.ok(threw, 'the mirror write failure is loud (propagates to the enqueueing caller)')

  // The mirror key never existed, so a healthy replay must NOT interpret its absence as
  // "peer settled it" — the entry exists only in the private array and must be dispatched.
  tq.ledgerWrite('tomatoAppendMany', { tomatoId: 'tmt_mf2', endTime: 2, dateKey: '2026-10-09', focusDuration: 4 })
  await drain()
  const sent = dbCalls.filter(([op, p]) => op === 'tomatoAppendMany' && p && (p.tomatoId === 'tmt_mf1'))
  assert.equal(sent.length, 1, 'the mirror-failed entry reached the DB exactly once')
  const sent2 = dbCalls.filter(([op, p]) => op === 'tomatoAppendMany' && p && p.tomatoId === 'tmt_mf2')
  assert.equal(sent2.length, 1, 'the healthy entry dispatched normally too')
})

test('[1] snow: an entry whose LS mirror write threw is still dispatched on the next replay', async () => {
  dbImpl = async () => ({ ok: true, minutes: 5 })
  const tq = await import('../../../renderer/js/store/helpers/tomatoPendingQueue.js?fix1009-mirror-snow')
  const origSet = LS.setItem.bind(LS)
  LS.setItem = (k, v) => { if (String(k).startsWith('tomatoPendingSnow.')) throw new Error('QuotaExceededError') ; origSet(k, v) }
  let threw = false
  try { tq.snowWrite({ taskId: 77, minutes: 5, dedupKey: '1009' }) } catch (e) { threw = true }
  LS.setItem = origSet
  assert.ok(threw, 'snow mirror failure is loud too')

  tq.snowWrite({ taskId: 88, minutes: 5, dedupKey: '1009b' })
  await drain()
  const bumps = dbCalls.filter(([op, p]) => op === 'bumpSnow' && p && p.taskId === 77)
  assert.equal(bumps.length, 1, 'the mirror-failed snow entry reached the DB exactly once')
  assert.ok(dbCalls.some(([op, p]) => op === 'bumpSnow' && p && p.taskId === 88), 'healthy snow entry dispatched too')
})

/* ---------------- [2] date-removal undo restores chips from the snapshot ---------------- */

const SEP4 = +new Date('2026-09-04T00:00:00')
const SEP5 = SEP4 + 24 * 3600000

// Same fake bridge shape as tests/unit/store/f6-plan-snapshot-clear.test.mjs
const planBridge = async (op, p) => {
  if (op === 'planAll') return chips.slice()
  if (op === 'getAll') return [{ taskId: 't1' }] // durable-existence guard in the undo replay
  if (op === 'upsert') return 'ok'
  if (op === 'setMeta') { meta.set(p[0], p[1]); return 'ok' }
  if (op === 'getMeta') return meta.has(p) ? meta.get(p) : null
  if (op === 'deleteMeta') { meta.delete(p); return 'ok' }
  if (op === 'planDeleteTask') { chips = chips.filter(c => c.taskId !== p); return }
  if (op === 'planMoveTask') return 0
  if (op === 'planAddMany') { chips.push(...p); return p.map((c, i) => c.id || 'c' + i) }
  return []
}

const planChips = await import('../../../renderer/js/store/helpers/planChips.js?fix1009')
const undoMod = await import('../../../renderer/js/store/helpers/undo.js?fix1009')

const row = (taskId, over = {}) => ({
  taskId, taskContent: 't-' + taskId, delete: false, dayStart: 0, todoTime: 0,
  updateTime: 1, status: 'update', ...over
})
const snap = rows => ({ todoList: rows, recycleList: [] })
const replay = (from, to) => undoMod.persistSnapshotDiffCore({ commit: () => {} }, { from, to }, () => {})

test('[2] pure planner: from-null → dated emits restoreSnapshot (not a no-op from-0 move)', () => {
  const eff = planChips.planSnapshotRowSync(row('A', { dayStart: 0 }), row('A', { dayStart: SEP4, updateTime: 2 }))
  assert.equal(eff.length, 1, 'one effect')
  assert.equal(eff[0].op, 'restoreSnapshot', 'restore the 2026-09-12 snapshot instead of moveTaskChips(0)')
  assert.equal(eff[0].taskId, 'A')
})

test('[2] rowChipSync: (re-)adding a date on an un-dated row consumes the chip snapshot onto the new day', async () => {
  chips.push({ id: 'c1', taskId: 't1', day: '2026-09-04', mm: '09:00' })
  // Step 1: date removed via the direct-edit channel → snapshot meta + chips cleared (existing behavior)
  await planChips.rowChipSync('t1', SEP4, { delete: false, dayStart: 0 })
  await drain()
  assert.equal(chips.length, 0, 'chips cleared on date removal')
  assert.ok(meta.has('planChipsSnapshot:t1'), 'snapshot meta written on date removal')
  // Step 2 (the fix): user re-sets a (different) date — old code called moveTaskChips(null, day)
  // which early-returned; now the snapshot must be restored, re-dated onto the NEW day.
  await planChips.rowChipSync('t1', 0, { delete: false, dayStart: SEP5 })
  await drain()
  assert.equal(chips.length, 1, 'snapshot chips restored')
  assert.equal(chips[0].day, '2026-09-05', 'restored chips re-dated onto the new day (D14-B4 toDay contract)')
  assert.equal(chips[0].mm, '09:00', 'time-of-day preserved')
  assert.ok(!meta.has('planChipsSnapshot:t1'), 'snapshot meta consumed')
})

test('[2] undo replay: clear-date then undo brings the schedule chips back', async () => {
  chips.push({ id: 'c2', taskId: 't1', day: '2026-09-04', mm: '10:30' })
  // set date → clear date (snapshot lands), then undo: before.dayStart=0 → after.dayStart>0
  await replay(snap([row('t1', { dayStart: 0 })]), snap([row('t1', { dayStart: SEP4, updateTime: 2 })]))
  await drain()
  await replay(snap([row('t1', { dayStart: SEP4, updateTime: 2 })]), snap([row('t1', { dayStart: 0, updateTime: 3 })]))
  await drain()
  await replay(snap([row('t1', { dayStart: 0, updateTime: 3 })]), snap([row('t1', { dayStart: SEP4, updateTime: 4 })]))
  await drain()
  assert.equal(chips.length, 1, 'chips restored from the snapshot by the undo path')
  assert.equal(chips[0].day, '2026-09-04', 'restored verbatim onto the undone row\'s day (the executor carries no re-date)')
  assert.equal(chips[0].mm, '10:30', 'chip time preserved')
  assert.ok(!meta.has('planChipsSnapshot:t1'), 'snapshot meta consumed so a later delete snapshots fresh state')
})

/* ---------------- [3] due-today completed-yesterday stays in recentExpiredCompleted ---------------- */

test('[3] a task due today completed yesterday appears in recentExpiredCompleted (not vanished)', async () => {
  const todo = (await import('../../../renderer/js/store/todo.js?fix1009')).default
  const today0 = todayMidnightMs()
  const st = {
    todoList: [
      { taskId: 'due1', delete: false, complete: true, completedAt: today0 - 24 * 3600000, updateTime: today0 - 24 * 3600000, dayStart: today0, todoTime: today0, createTime: 1, taskSort: 0 }
    ], recycleList: []
  }
  const committed = []
  const ctx = {
    commit: (n, p) => { committed.push([n, p]) },
    dispatch: () => {},
    state: st,
    rootState: { settings: { expiredCompletedTodoRange: '7d', expiredUncompletedTodoRange: '30d', upcomingTodoRange: '30d', todoBoxCategoryId: -1, todoBoxSortMethod: 'created', todoBoxSortOrder: 'desc', sortMode: 'custom', showNoDate: true } }
  }
  await todo.actions.computeViews.call({ state: { todo: st } }, ctx)
  const views = committed.find(([n]) => n === 'setViews')[1]
  assert.ok(!views.todayDoneList.some(t => t.taskId === 'due1'), 'not in today done (completed yesterday, not today)')
  assert.ok(views.recent.expiredCompleted.some(t => t.taskId === 'due1'), 'due-today/yesterday-completed row is in recent expired completed')
})

/* ---------------- [4] tomato: per-window merge keys + sub-minute abandon ---------------- */

test('[4] syncFromStorage: a stale peer blob cannot clobber local counters or the attach choice', async () => {
  const tomato = (await import('../../../renderer/js/store/tomato.js?fix1009-sync')).default
  const today = globalThis.window.dayjs().format('YYYY-MM-DD')
  const s = {
    status: 'default', tomatoTime: 25, restTime: 5, todayTomatoCount: 5,
    _countDate: today, _countedFocus: 42, attachTodo: { taskId: 9, taskContent: 'Main task' },
    tomatoRecordList: [{ tomatoId: 'r1', dateKey: today, succeed: true }], phaseTs: 100, remainSec: 1500, startedAt: 0
  }
  LS.setItem('tomatoState', JSON.stringify({
    schemaV: 1, status: 'default', tomatoTime: 30, restTime: 5,
    todayTomatoCount: 99, _countDate: '2020-01-01', _countedFocus: 7, attachTodo: { taskId: 99, taskContent: 'Float task' },
    tomatoRecordList: [], phaseTs: 100, remainSec: 1500, startedAt: 0
  }))
  LS.setItem('tomatoSyncPing', 'fix1009-ping')
  tomato.mutations.syncFromStorage(s)
  assert.equal(s.todayTomatoCount, 5, 'today count NOT reset by the stale peer blob (each window recounts from the ledger)')
  assert.equal(s._countDate, today, 'local _countDate kept')
  assert.equal(s._countedFocus, 42, 'local count-guard phase identity kept (a foreign one would un-guard idempotency)')
  assert.equal(s.attachTodo.taskId, 9, 'per-window attach choice kept (attachTodo is only ever set by this window\'s attachTask mutation, never broadcast to peers)')
  assert.equal(s.tomatoTime, 30, 'shared preferences still sync')
  assert.equal(s.tomatoRecordList[0].tomatoId, 'r1', 'in-memory ledger copy untouched by the sync')
})

test('[4] giveUp: a sub-minute abandon books focusDuration 0 (no phantom focus minute); a 65s abandon still books 1', async () => {
  const tomato = (await import('../../../renderer/js/store/tomato.js?fix1009-giveup')).default
  LS.removeItem('tomatoLastPhaseDone')
  const state = Object.assign({}, tomato.state, {
    status: 'startTomatoTime', startedAt: Date.now() - 2000, // 2-second misclick
    tomatoTime: 25, restTime: 5, enableNotification: false,
    attachTodo: { taskId: 't1', taskContent: 'Task' }, tomatoRecordList: [], todayTomatoCount: 0
  })
  const ctx = {
    state,
    rootState: { todo: { todoList: [{ taskId: 't1', taskContent: 'Task', delete: false }] }, settings: {} },
    commit (m, p) { tomato.mutations[m] && tomato.mutations[m](state, p) },
    dispatch () { return Promise.resolve() }
  }
  await tomato.actions.giveUp(ctx, { record: true, reason: 'misclick' })
  assert.equal(state.tomatoRecordList.length, 1, 'the abandon is still booked (audit trail with its reason)')
  const rec = state.tomatoRecordList[0]
  assert.equal(rec.focusDuration, 0, 'sub-minute abandon books 0, not Math.max(1, ...) — day stats no longer inflated (db lower bound is 0 by design)')
  assert.equal(rec.succeed, false, 'booked as an abandon')
  assert.equal(rec.abandonReason, 'misclick')

  // Boundary: at/above the half-minute the Math.round basis still books minutes — only the
  // phantom sub-minute floor was removed.
  LS.removeItem('tomatoLastPhaseDone')
  const s2 = Object.assign({}, tomato.state, {
    status: 'startTomatoTime', startedAt: Date.now() - 65000,
    tomatoTime: 25, restTime: 5, enableNotification: false,
    attachTodo: { taskId: 't1', taskContent: 'Task' }, tomatoRecordList: [], todayTomatoCount: 0
  })
  const ctx2 = { state: s2, rootState: ctx.rootState, commit (m, p) { tomato.mutations[m] && tomato.mutations[m](s2, p) }, dispatch: ctx.dispatch }
  await tomato.actions.giveUp(ctx2, { record: true, reason: 'real abandon' })
  assert.equal(s2.tomatoRecordList[0].focusDuration, 1, '65s abandon still books 1 minute')
})
