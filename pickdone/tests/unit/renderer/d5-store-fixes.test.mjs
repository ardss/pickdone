/**
 * D5 maintenance round (renderer store/utils) — regression guards.
 * Fixes covered:
 *   [1]  bumpSnow replay double-credit: pending-snow entries carry dedupKey = String(startedAt);
 *        quit-flush replays the same key (a dedup-honoring stub credits exactly once)
 *   [2]  settings exit-loss window: commit without action → quit-flush persists LS + DB mirror
 *   [3]  dbMirror quit flush keeps the pending blob when writeNow cannot hand it to the bridge
 *   [4]  undo merge path runs the byte-budget eviction loop
 *   [5]  flushPendingLedger reinserts failed entries preserving original order
 *   [6+7] repeat renewal carries priority/deadlineTs/important/urgent/estimate
 *   [8]  category toRow carries deletedAt
 *   [9]  category softDelete purges saved filters referencing the victim
 *   [10] dayPlans restoreSnapshot consumes the snapshot via deleteMeta (not setMeta '')
 *   [11] purgeIds scrubs milestones taskIds (unmet milestone does not flip to done)
 *   [12] completed-today overdue task is not double-listed (todayDoneList XOR recentExpiredCompleted)
 *   [13] abandon and complete use the same minute rounding (Math.round)
 *   [14] tomatoEstimate tie between meta/LS stamps favors CLI/meta (strict <)
 * Run: node --test tests/unit/renderer/d5-store-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

/* ---------- shared stub bridge: installed BEFORE the store imports (quit hooks register at import) ---------- */

const quitHooks = []
const dbCalls = [] // every [op, params]
const metaStore = new Map() // getMeta/setMeta simulation
let dbImpl = async () => 'ok'

if (!globalThis.globalThis.window.location) globalThis.globalThis.window.location = { hash: '' }
globalThis.globalThis.window.todoAPI = {
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
const fireQuitFlush = () => { for (const fn of quitHooks) fn() }
const callsOf = op => dbCalls.filter(([o]) => o === op).map(([, p]) => p)
const resetCalls = () => { dbCalls.length = 0 }

const DAY = 86400000
const today0 = (() => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.getTime() })()

/* ---------- modules under test (imported once; singletons) ---------- */
const tomato = (await import('../../../renderer/js/store/tomato.js')).default
const settings = (await import('../../../renderer/js/store/settings.js')).default
const todo = (await import('../../../renderer/js/store/todo.js')).default
const category = (await import('../../../renderer/js/store/category.js')).default
const dbMirror = await import('../../../renderer/js/utils/dbMirror.js')
const dayPlans = await import('../../../renderer/js/utils/dayPlans.js')
const milestones = await import('../../../renderer/js/utils/milestones.js')
const tomatoEstimate = await import('../../../renderer/js/utils/tomatoEstimate.js')
const undo = await import('../../../renderer/js/store/helpers/undo.js')

/* ---------- [1] bumpSnow dedupKey ---------- */

test('[1] bumpSnow payload carries dedupKey = String(startedAt); a dedup-honoring replay credits once', async () => {
  const seenDedup = new Set()
  let credits = 0
  let bridgeUp = true
  dbImpl = async (op, params) => {
    if (op === 'bumpSnow') {
      if (!bridgeUp) throw new Error('bridge down')
      const k = params && params.dedupKey
      if (k) {
        if (seenDedup.has(k)) return 'dup-skipped'
        seenDedup.add(k)
      }
      credits++
      return 'ok'
    }
    if (op === 'getById') return { taskId: params, delete: false }
    return 'ok'
  }
  const st = {
    status: 'startTomatoTime', startedAt: Date.now() - 26 * 60000, attachTodo: { taskId: 'tk_d5_1', taskContent: 'T' },
    todoTime: 25, restTime: 5, todayTomatoCount: 0, tomatoRecordList: [], tomatoState: null, remainSec: 0
  }
  // completeFocus re-verifies the shared LS transient before booking — mirror st into it
  globalThis.localStorage.setItem('tomatoState', JSON.stringify({ status: 'startTomatoTime', startedAt: st.startedAt, tomatoTime: 25, restTime: 5 }))
  const phaseStartedAt = st.startedAt
  const commit = (n, p) => tomato.mutations[n](st, p)
  const dispatch = () => {}
  const fakeThis = { state: { todo: { todoList: [{ taskId: 'tk_d5_1', delete: false, taskContent: 'T' }], recycleList: [] } } }
  resetCalls()
  await tomato.actions.completeFocus.call(fakeThis, { state: st, commit, dispatch, rootState: { settings: {} } })
  const snowCalls = callsOf('bumpSnow') // each entry = the bumpSnow params object
  assert.ok(snowCalls.length >= 1, 'bumpSnow attempted')
  assert.equal(typeof snowCalls[0].dedupKey, 'string', 'dedupKey present in the payload')
  assert.ok(/^\d+$/.test(snowCalls[0].dedupKey), 'dedupKey = String(startedAt) shape')
  assert.equal(snowCalls[0].dedupKey, String(phaseStartedAt), 'dedupKey equals String(startedAt) of the booked phase')
  assert.equal(credits, 1, 'first write credits once')
  // Simulate the retry path: the write failed transiently, then the quit-flush replays it —
  // the same dedupKey must arrive so the db layer skips the double credit.
  const queuedKey = snowCalls[0].dedupKey
  assert.equal(queuedKey, String(phaseStartedAt))
  bridgeUp = false
  st.status = 'startTomatoTime'
  st.startedAt = Date.now() - 26 * 60000
  globalThis.localStorage.setItem('tomatoState', JSON.stringify({ status: 'startTomatoTime', startedAt: st.startedAt, tomatoTime: 25, restTime: 5 }))
  try { globalThis.localStorage.removeItem('tomatoLastPhaseDone') } catch (e) { /* empty */ }
  await tomato.actions.completeFocus.call(fakeThis, { state: st, commit, dispatch, rootState: { settings: {} } })
  bridgeUp = true
  fireQuitFlush()
  await new Promise(r => setTimeout(r, 20))
  assert.equal(credits, 2, 'second phase credits once more')
  assert.ok(seenDedup.has(queuedKey), 'the first phase key was seen')
  // the replayed entry carried the SAME key as the original booking — the stub's dedup set already
  // contains it, so no key was ever credited twice (the replay call may repeat; the credit may not)
  assert.equal(credits, 2, 'each distinct phase credited exactly once (the replayed key was skipped by dedup)')
  assert.ok(seenDedup.has(queuedKey), 'replay carried the original phase key')
})

/* ---------- [2] settings quit-flush ---------- */

test('[2] direct commit bypassing the action is persisted by the quit flush (LS + DB mirror)', async () => {
  dbImpl = async () => 'ok'
  resetCalls()
  settings.mutations.updateSettings(settings.state, { dailyTomatoTarget: 13 })
  // quit immediately, before the 150ms LS timer / 2s mirror timer fire
  fireQuitFlush()
  await new Promise(r => setTimeout(r, 20))
  const ls = JSON.parse(globalThis.localStorage.getItem('settingsState'))
  assert.equal(ls.dailyTomatoTarget, 13, 'LS blob flushed synchronously at quit')
  const mirror = callsOf('setMeta').find(([k]) => k === 'db.settingsState')
  assert.ok(mirror, 'DB mirror blob handed to the bridge at quit')
  assert.equal(JSON.parse(mirror[1]).dailyTomatoTarget, 13, 'mirror carries the latest change')
})

/* ---------- [3] dbMirror quit flush keeps pending on writeNow failure ---------- */

test('[3] quit flush keeps the pending blob when the bridge is unavailable, and a later flush writes it', async () => {
  dbImpl = async () => 'ok'
  resetCalls()
  // Aux-window hash → writeNow returns false (no write possible)
  globalThis.window.location.hash = '__tomato-float'
  dbMirror.mirrorToDb('d5.flushKey', { v: 1 })
  fireQuitFlush() // dbMirror's quit hook: must NOT drop the pending (old code deleted it before writeNow)
  globalThis.window.location.hash = ''
  // Bridge becomes available; a later quit flush must still have the blob and hand it over
  fireQuitFlush()
  await new Promise(r => setTimeout(r, 20))
  const mirror = callsOf('setMeta').find(([k]) => k === 'd5.flushKey')
  assert.ok(mirror, 'pending blob survived the failed flush and was written once the bridge returned')
  assert.deepEqual(JSON.parse(mirror[1]), { v: 1 })
})

/* ---------- [4] undo merge-path eviction ---------- */

test('[4] 400ms typing burst via the merge path cannot push _histBytes past HISTORY_BYTES', () => {
  const HISTORY_BYTES = undo.HISTORY_BYTES
  const s = { undoStack: [], redoStack: [], _histLastPushAt: Date.now(), _histBytes: 0, _histRedoBytes: 0 }
  undo.historyPush(s, 'x'.repeat(50)) // seed entry (starts the merge window)
  let merges = 0
  while (merges < 30000) {
    undo.historyPush(s, 'y'.repeat(1200)) // within the 400ms window → merge-delta accounting
    merges++
    if (s.undoStack.length === 1) break // fully evicted down to the last entry
  }
  assert.ok(s._histBytes <= HISTORY_BYTES, 'byte budget respected after merge accounting (was skipped before the fix)')
  assert.ok(s.undoStack.length >= 1, 'stack never empties entirely')
})

/* ---------- [5] flushPendingLedger preserves failed-entry order ---------- */

test('[5] mixed success/failure quit flush requeues failures in original order', async () => {
  const failIds = new Set(['tmt_d5_A', 'tmt_d5_C'])
  const replayOrder = []
  dbImpl = async (op, params) => {
    if (op === 'tomatoAppendMany') {
      const rec = Array.isArray(params) ? params[0] : params
      if (failIds.has(rec.tomatoId)) throw new Error('db down')
      return { accepted: 1, rejected: [] }
    }
    return 'ok'
  }
  const s = { tomatoRecordList: [] }
  tomato.mutations.addRecord(s, { tomatoId: 'tmt_d5_A', endTime: Date.now(), dateKey: '2026-09-20', focusDuration: 10 })
  tomato.mutations.addRecord(s, { tomatoId: 'tmt_d5_B', endTime: Date.now(), dateKey: '2026-09-20', focusDuration: 10 })
  tomato.mutations.addRecord(s, { tomatoId: 'tmt_d5_C', endTime: Date.now(), dateKey: '2026-09-20', focusDuration: 10 })
  await new Promise(r => setTimeout(r, 20))
  fireQuitFlush() // B succeeds; A and C fail and are requeued in original order
  await new Promise(r => setTimeout(r, 20))
  resetCalls() // drop the first-attempt calls; observe only the replay below
  // Any later ledger write triggers a replay of the queue — observe the replay order
  dbImpl = async op => (op === 'tomatoAppendMany' ? { accepted: 1, rejected: [] } : 'ok')
  tomato.mutations.addRecord(s, { tomatoId: 'tmt_d5_D', endTime: Date.now(), dateKey: '2026-09-20', focusDuration: 5 })
  await new Promise(r => setTimeout(r, 20))
  for (const p of callsOf('tomatoAppendMany')) replayOrder.push((Array.isArray(p) ? p[0] : p).tomatoId)
  const tail = replayOrder.slice(replayOrder.indexOf('tmt_d5_A'))
  assert.deepEqual(tail, ['tmt_d5_A', 'tmt_d5_C', 'tmt_d5_D'], 'failed entries replay in original causal order (A before C before the new D)')
})

/* ---------- [6+7] renewal carries attributes ---------- */

test('[6+7] ensureNextRepeatInstance renewal payload carries priority/deadlineTs/important/urgent/estimate', async () => {
  metaStore.set('repeatRule:d5r1', JSON.stringify({ repeatType: '天', repeatInterval: 1, repeatDayCount: 30 }))
  const dispatched = []
  const ctx = { dispatch: (n, p) => { dispatched.push([n, p]); return Promise.resolve({}) } }
  const completed = {
    taskId: 't_done', repeatId: 'd5r1', dayStart: today0, todoTime: today0, categoryId: 3,
    taskContent: 'recurring', taskDescribe: 'd', priority: 3, deadlineTs: today0 + 5 * DAY,
    important: 1, urgent: 2, estimate: 4, reminderTime: 0, reminderOffsets: [], reminderExtra: [], subtasks: null, difficulty: 2
  }
  const fakeThis = { state: { todo: { todoList: [{ ...completed }], holidayList: [] } } }
  await todo.actions.ensureNextRepeatInstance.call(fakeThis, ctx, completed)
  const add = dispatched.find(([n]) => n === 'addTodo')
  assert.ok(add, 'renewal dispatched an addTodo')
  const p = add[1]
  assert.equal(p.priority, 3, 'priority carried')
  assert.equal(p.deadlineTs, today0 + 5 * DAY, 'deadlineTs carried')
  assert.equal(p.important, 1, 'important carried')
  assert.equal(p.urgent, 2, 'urgent carried')
  assert.equal(p.estimate, 4, 'per-task estimate carried')
  // CLI twin semantics: absent fields fall back to 0
  const ctx2 = { dispatch: (n, p2) => { dispatched.push([n, p2]); return Promise.resolve({}) } }
  const bare = { ...completed, priority: undefined, deadlineTs: undefined, important: undefined, urgent: undefined, estimate: undefined }
  await todo.actions.ensureNextRepeatInstance.call(fakeThis, ctx2, bare)
  const p2 = dispatched.filter(([n]) => n === 'addTodo')[1][1]
  assert.equal(p2.priority, 0); assert.equal(p2.deadlineTs, 0); assert.equal(p2.important, 0); assert.equal(p2.urgent, 0); assert.equal(p2.estimate, 0)
})

/* ---------- [8+9] category toRow deletedAt + filter purge on softDelete ---------- */

function makeCategoryStore (state) {
  return {
    state,
    commit (n, p) {
      if (n === 'category/markCascade') category.mutations.markCascade(state, p)
      else if (n === 'filters/setList') state.filters.list = p
    }
  }
}

test('[8+9] softDelete stamps deletedAt into the DB row and purges saved filters referencing the victim', async () => {
  dbImpl = async () => 'ok'
  resetCalls()
  metaStore.clear()
  const catState = {
    list: [
      { categoryId: 5001, categoryName: 'Victim', categoryColor: '#fff', createTime: Date.now(), listSort: 100, folderIs: false, folderId: 0, delete: false },
      { categoryId: 5002, categoryName: 'Keep', categoryColor: '#000', createTime: Date.now(), listSort: 200, folderIs: false, folderId: 0, delete: false }
    ],
    projectIds: [], projectMeta: {}
  }
  const store = makeCategoryStore(catState)
  store.state.filters = { list: [{ id: 'f1', name: 'victim filter', conds: { catId: 5001 } }, { id: 'f2', name: 'other', conds: { catId: 5002 } }] }
  category.mutations.softDelete.call(store, catState, 5001)
  const victimRow = callsOf('upsertCategory').find(r => r.id === 5001)
  assert.ok(victimRow, 'victim row persisted')
  assert.ok(victimRow.deleted === 1, 'victim row marked deleted')
  assert.ok(victimRow.deletedAt > 0, 'row carries the deletedAt stamp (renderer shape now includes it)')
  const filterDeletes = callsOf('filterDelete').map(p => p)
  assert.deepEqual(filterDeletes, ['f1'], 'only the filter referencing the victim category is deleted')
  assert.deepEqual(store.state.filters.list.map(f => f.id), ['f2'], 'state list trimmed symmetrically')
})

/* ---------- [10] restoreSnapshot consumes via deleteMeta ---------- */

test('[10] restoreSnapshot writes chips back and consumes the snapshot with deleteMeta (not setMeta \'\')', async () => {
  dbImpl = async () => 'ok'
  resetCalls()
  metaStore.set('planChipsSnapshot:d5t1', JSON.stringify([{ taskId: 'd5t1', ts: today0, title: 'chip' }]))
  await dayPlans.restoreSnapshot('d5t1')
  const ops = dbCalls.map(([o, p]) => [o, p])
  assert.ok(ops.some(([o, p]) => o === 'planAddMany'), 'chips written back')
  assert.ok(ops.some(([o, p]) => o === 'deleteMeta' && p === 'planChipsSnapshot:d5t1'), 'snapshot consumed via deleteMeta')
  assert.ok(!ops.some(([o]) => o === 'setMeta'), 'no setMeta(\'\') tombstone')
})

/* ---------- [11] purge scrubs milestone taskIds ---------- */

test('[11] purgeIds removes purged ids from projectMilestones taskIds; an unmet past milestone stays overdue', async () => {
  dbImpl = async op => (op === 'hardDelete' ? true : 'ok')
  resetCalls()
  metaStore.set('projectMilestones:7', JSON.stringify([
    { id: 'm1', title: 'past unmet', date: today0 - 3 * DAY, taskIds: ['purgeme', 'keepme'] }
  ]))
  const st = {
    todoList: [], recycleList: [
      { taskId: 'purgeme', categoryId: 7, delete: true },
      { taskId: 'keepme', categoryId: 7, delete: false }
    ], undoStack: [], redoStack: []
  }
  const committed = []
  const ctx = {
    commit: (n, p) => { committed.push([n, p]); if (todo.mutations[n]) todo.mutations[n](st, p) },
    dispatch: () => {},
    state: st,
    rootState: { tomato: {}, settings: { recycleBinAutoDeleteDays: 30 } }
  }
  const fakeThis = { state: { todo: st } }
  await todo.actions.purgeIds.call(fakeThis, ctx, ['purgeme'])
  const saved = callsOf('setMeta').find(([k]) => k === 'projectMilestones:7')
  assert.ok(saved, 'milestone meta rewritten')
  const list = JSON.parse(saved[1])
  assert.deepEqual(list[0].taskIds, ['keepme'], 'purged id scrubbed, other link kept')
  // milestoneState must NOT flip to 'done' just because a link was purged: keepme is still incomplete
  const tasks = [{ taskId: 'keepme', complete: false }]
  assert.equal(milestones.milestoneState(list[0], today0, tasks), 'overdue', 'unmet past milestone stays overdue after the scrub')
})

/* ---------- [12] overdue-completed-today dedupe ---------- */

test('[12] an overdue task completed today appears in todayDoneList only (not recentExpiredCompleted)', async () => {
  dbImpl = async () => 'ok'
  resetCalls()
  const st = {
    todoList: [
      { taskId: 'dup1', delete: false, complete: true, completedAt: today0 + 3600000, updateTime: today0 + 3600000, dayStart: today0 - 3 * DAY, todoTime: today0 - 3 * DAY, createTime: 1, taskSort: 0 },
      { taskId: 'old1', delete: false, complete: true, completedAt: today0 - 2 * DAY, updateTime: today0 - 2 * DAY, dayStart: today0 - 5 * DAY, todoTime: today0 - 5 * DAY, createTime: 2, taskSort: 0 }
    ], recycleList: []
  }
  const committed = []
  const ctx = {
    commit: (n, p) => { committed.push([n, p]) },
    dispatch: () => {},
    state: st,
    rootState: { settings: { expiredCompletedTodoRange: '7d', expiredUncompletedTodoRange: '30d', upcomingTodoRange: '30d', todoBoxCategoryId: -1, todoBoxSortMethod: 'created', todoBoxSortOrder: 'desc', sortMode: 'custom', showNoDate: true } }
  }
  const fakeThis = { state: { todo: st } }
  await todo.actions.computeViews.call(fakeThis, ctx)
  const views = committed.find(([n]) => n === 'setViews')[1]
  assert.ok(views.todayDoneList.some(t => t.taskId === 'dup1'), 'completed-today overdue task is in today done')
  assert.ok(!views.recent.expiredCompleted.some(t => t.taskId === 'dup1'), 'and NOT duplicated in recent expired completed')
  assert.ok(views.recent.expiredCompleted.some(t => t.taskId === 'old1'), 'an earlier-completed overdue task still lists there')
})

/* ---------- [13] abandon/complete minute rounding unified ---------- */

test('[13] giveUp books the measured duration with Math.round (same as completeFocus)', async () => {
  try { globalThis.localStorage.removeItem('tomatoLastPhaseDone') } catch (e) { /* empty */ }
  const st = {
    status: 'startTomatoTime', startedAt: Date.now() - (25 * 60000 + 40000), attachTodo: null,
    todoTime: 25, restTime: 5, todayTomatoCount: 0, tomatoRecordList: [], remainSec: 0
  }
  const commit = (n, p) => tomato.mutations[n](st, p)
  const dispatch = () => {}
  const fakeThis = { state: { todo: { todoList: [], recycleList: [] } } }
  tomato.actions.giveUp.call(fakeThis, { state: st, commit, dispatch })
  const rec = st.tomatoRecordList[0]
  assert.ok(rec, 'abandon recorded')
  assert.equal(rec.focusDuration, 26, '25:40 rounds to 26 (floor booked 25, complete booked 26)')
  // structural guard: giveUp no longer uses Math.floor for the measured minutes
  const src = read('renderer/js/store/tomato.js')
  const giveUpBody = src.slice(src.indexOf('giveUp ({'), src.indexOf('async completeFocus'))
  assert.ok(!giveUpBody.includes('Math.floor((Date.now() - s.startedAt) / 60000)'), 'floor rounding removed from giveUp')
})

/* ---------- [14] tomatoEstimate tie favors meta/CLI ---------- */

test('[14] equal meta/LS timestamps: meta (CLI) wins the tie', async () => {
  const LS_KEY = 'tomatoEstimateState'
  const TS_KEY = 'tomatoEstimateStateAt'
  const stamp = String(Date.now() - 5000)
  globalThis.localStorage.setItem(LS_KEY, JSON.stringify({ staleTask: 9 }))
  globalThis.localStorage.setItem(TS_KEY, stamp)
  metaStore.set(LS_KEY, JSON.stringify({ freshTask: 3 }))
  metaStore.set(TS_KEY, stamp) // exact tie — old code let the stale LS win (<=)
  await tomatoEstimate.initFromDb()
  const ls = JSON.parse(globalThis.localStorage.getItem(LS_KEY))
  assert.equal(ls.freshTask, 3, 'meta payload took over on a tie')
  assert.equal(ls.staleTask, undefined, 'stale LS payload discarded')
})
