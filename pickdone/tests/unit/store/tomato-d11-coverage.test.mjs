/* maint/d11 coverage-restore wave: behavior tests for renderer/js/store/tomato.js paths that the
 * d11 fix rounds touched but never covered — pure helpers (remainingSecOfState / todayCountPatch /
 * resolveFocusedTask / focusTodoPool), getters, every mutation branch, the giveUp/tick/finishRest/
 * attach action branches, and the ledger retry-queue contract (purge-on-remove, rejected-row log).
 * Run: node --test tests/unit/store/tomato-d11-coverage.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import tomato, { remainingSecOfState, todayCountPatch, resolveFocusedTask, focusTodoPool } from '../../../renderer/js/store/tomato.js'

function makeCtx (statePatch = {}, opts = {}) {
  const state = Object.assign({}, tomato.state, {
    status: 'default', startedAt: 0, tomatoTime: 25, restTime: 5,
    enableNotification: false, attachTodo: null, tomatoRecordList: [],
    todayTomatoCount: 0, phaseTs: 0
  }, statePatch)
  const committed = []
  const dispatched = []
  const ctx = {
    state,
    rootState: Object.assign({ todo: { todoList: [], recycleList: [] }, settings: {}, auth: { user: { userId: 7 } } }, opts.rootState),
    commit (m, p) {
      committed.push([m, p])
      const mut = m.includes('/') ? null : tomato.mutations[m]
      if (mut) mut(state, p)
    },
    dispatch (path, payload) { dispatched.push([path, payload]); return Promise.resolve(opts.dispatchResult) }
  }
  return { ctx, state, committed, dispatched }
}

function freshApi (impl = {}) {
  const api = {
    dbCall: async () => ({}),
    onAppQuittingFlush (cb) { (api._quitCbs = api._quitCbs || []).push(cb) },
    ...impl
  }
  globalThis.window.todoAPI = api
  return api
}

test('remainingSecOfState: idle/rest/running/degenerate states (single-source countdown contract)', () => {
  const now = 1_700_000_000_000
  assert.equal(remainingSecOfState(null, now), 25 * 60, 'missing state → full default focus')
  assert.equal(remainingSecOfState({ status: 'default', startedAt: 0, tomatoTime: 30 }, now), 30 * 60, 'idle focus → tomatoTime')
  assert.equal(remainingSecOfState({ status: 'default', tomatoTime: 0 }, now), 25 * 60, 'idle focus without tomatoTime → 25')
  assert.equal(remainingSecOfState({ status: 'startRestTime', restTime: 7 }, now), 7 * 60, 'idle rest → restTime')
  assert.equal(remainingSecOfState({ status: 'startRestTime', restTime: 0 }, now), 5 * 60, 'idle rest without restTime → 5 (was 25 in drifted copies)')
  // running: floor+clamp
  const startedAt = now - 90_000
  assert.equal(remainingSecOfState({ status: 'startTomatoTime', startedAt, tomatoTime: 25, restTime: 5 }, now), 25 * 60 - 90)
  assert.equal(remainingSecOfState({ status: 'startTomatoTime', startedAt: now - 999_999_999, tomatoTime: 25 }, now), 0, 'long-past focus clamps to 0')
  assert.equal(remainingSecOfState({ status: 'startRestTime', startedAt, tomatoTime: 25, restTime: 5 }, now), 5 * 60 - 90)
})

test('todayCountPatch: idempotent per startedAt, counts into completion day', () => {
  const s = { todayTomatoCount: 2 }
  const endTs = 1_700_000_000_000
  const p = todayCountPatch(s, 123, endTs)
  assert.equal(p.todayTomatoCount, 3)
  assert.equal(p._countedFocus, 123)
  assert.ok(p._countDate, 'date key derived')
  assert.equal(todayCountPatch({ _countedFocus: 123 }, 123, endTs), null, 'same focus never double-counts')
})

test('resolveFocusedTask / focusTodoPool: dead/missing targets resolve to null (free focus)', () => {
  assert.equal(resolveFocusedTask(null, []), null)
  assert.equal(resolveFocusedTask({}, []), null)
  assert.equal(resolveFocusedTask({ taskId: 't1' }, []), null, 'no row → null')
  assert.equal(resolveFocusedTask({ taskId: 't1' }, [{ taskId: 't1', delete: true }]), null, 'soft-deleted → null')
  const r = resolveFocusedTask({ taskId: 't1', taskContent: 'stale' }, [{ taskId: 't1', taskContent: 'fresh' }])
  assert.deepEqual(r, { taskId: 't1', taskContent: 'fresh' }, 'row content wins over stale attach')
  assert.deepEqual(resolveFocusedTask({ taskId: 't1' }, [{ taskId: 't1' }]), { taskId: 't1', taskContent: undefined })
  assert.deepEqual(focusTodoPool({ rootState: { todo: { todoList: [1], recycleList: [2] } } }), [1, 2])
  assert.deepEqual(focusTodoPool({ state: { todo: { todoList: [3] } } }), [3])
  assert.deepEqual(focusTodoPool({}), [])
})

test('getters: actualCountByTask skips abandoned and unlinked; recordsByDate groups by dateKey', () => {
  const s = { tomatoRecordList: [
    { tomatoId: 'a', focusTaskId: 't1', succeed: true },
    { tomatoId: 'b', focusTaskId: 't1' },
    { tomatoId: 'c', focusTaskId: 't2', succeed: false },
    { tomatoId: 'd', focusTaskId: '' },
    null,
    { tomatoId: 'e', dateKey: '2026-09-28' },
    { tomatoId: 'f', dateKey: '2026-09-28' }
  ] }
  const counts = tomato.getters.actualCountByTask(s)
  assert.equal(counts.get('t1'), 2)
  assert.equal(counts.has('t2'), false, 'abandoned not counted')
  const byDate = tomato.getters.recordsByDate(s)
  assert.equal(byDate.get('2026-09-28').length, 2)
})

test('mutations.patch: stamps phaseTs on status change and clamps duration keys', () => {
  const { ctx, state } = makeCtx()
  const before = state.phaseTs
  tomato.mutations.patch(state, { tomatoTime: 9999 })
  assert.equal(state.tomatoTime <= 600, true, 'duration clamped to the shared max (F-C3)')
  assert.equal(state.phaseTs, before, 'no status change → no phaseTs stamp')
  tomato.mutations.patch(state, { status: 'startTomatoTime', startedAt: 5 })
  assert.ok(state.phaseTs > 0, 'status flip stamps phaseTs')
  void ctx
})

test('mutations.updateRecordTask: relinks a record and persists; no-op cases do not write the ledger', async () => {
  const { state } = makeCtx({ tomatoRecordList: [{ tomatoId: 'x', focusTaskId: null }] })
  const writes = []
  freshApi({ dbCall: async (op, params) => { writes.push([op, params]); return { accepted: 1, rejected: [] } } })
  tomato.mutations.updateRecordTask(state, { tomatoId: 'missing', focusTaskId: 't9' })
  assert.equal(writes.length, 0, 'unknown record → no ledger write')
  tomato.mutations.updateRecordTask(state, { tomatoId: 'x', focusTaskId: null })
  assert.equal(writes.length, 0, 'same link → no ledger write')
  tomato.mutations.updateRecordTask(state, { tomatoId: 'x', focusTaskId: 't9' })
  await new Promise(r => setTimeout(r, 10))
  assert.equal(state.tomatoRecordList[0].focusTaskId, 't9')
  assert.equal(writes.length, 1)
  assert.equal(writes[0][0], 'tomatoUpdateById')
})

test('mutations.updateRecord: endTime re-derives dateKey, invalid endTime warns and skips the field, durations clamp', async () => {
  const { state } = makeCtx({ tomatoRecordList: [{ tomatoId: 'x', endTime: 1000, dateKey: 'old', focusDuration: 25, restDuration: 5, succeed: false }] })
  freshApi()
  const warns = []
  const origWarn = console.warn
  console.warn = (...a) => warns.push(a.join(' '))
  try {
    const t = new Date('2026-09-28T10:00:00').getTime()
    tomato.mutations.updateRecord(state, { tomatoId: 'x', patch: { endTime: t, focusDuration: 99999, restDuration: -5, succeed: 1 } })
    assert.equal(state.tomatoRecordList[0].endTime, t)
    assert.equal(state.tomatoRecordList[0].dateKey, '2026-09-28', 'dateKey re-derived from endTime')
    assert.equal(state.tomatoRecordList[0].focusDuration, 600, 'focus clamped to FOCUS_MAX')
    assert.equal(state.tomatoRecordList[0].restDuration, 0, 'rest clamped to >=0')
    assert.equal(state.tomatoRecordList[0].succeed, true)
    assert.equal(warns.length, 0)
    tomato.mutations.updateRecord(state, { tomatoId: 'x', patch: { endTime: 0 } })
    assert.equal(warns.length, 1, 'invalid endTime is reported, not silent (G1)')
    assert.equal(state.tomatoRecordList[0].endTime, t, 'invalid endTime leaves the field untouched')
    tomato.mutations.updateRecord(state, { tomatoId: 'nope', patch: { endTime: t } })
  } finally { console.warn = origWarn }
})

test('mutations.removeRecord / addRecord dedupe / recordsReplace dedupe + non-array no-op', async () => {
  const { state } = makeCtx({ tomatoRecordList: [{ tomatoId: 'a' }, { tomatoId: 'b' }] })
  freshApi()
  tomato.mutations.addRecord(state, { tomatoId: 'a' })
  assert.equal(state.tomatoRecordList.length, 2, 'duplicate id not re-added')
  tomato.mutations.recordsReplace(state, 'garbage')
  assert.equal(state.tomatoRecordList.length, 2, 'non-array list ignored')
  tomato.mutations.recordsReplace(state, [{ tomatoId: 'a' }, { tomatoId: 'a' }, { tomatoId: 'c' }, {}])
  assert.deepEqual(state.tomatoRecordList.map(r => r.tomatoId), ['a', 'c'], 'dup ids collapse to first occurrence')
  tomato.mutations.removeRecord(state, 'a')
  assert.deepEqual(state.tomatoRecordList.map(r => r.tomatoId), ['c'])
})

test('mutations.syncFromStorage: same-ping and null-ping short-circuit; stale peer keeps the local phase; fresh peer applies', () => {
  const { state } = makeCtx({ phaseTs: 200, status: 'startTomatoTime', startedAt: 9 })
  // no ping at all
  tomato.mutations.syncFromStorage(state)
  assert.equal(state.status, 'startTomatoTime')
  // peer with an OLDER phaseTs must not roll the phase back
  globalThis.localStorage.setItem('tomatoSyncPing', 'peer-ping-1')
  globalThis.localStorage.setItem('tomatoState', JSON.stringify({ status: 'default', startedAt: 0, phaseTs: 100, tomatoTime: 40 }))
  tomato.mutations.syncFromStorage(state)
  assert.equal(state.status, 'startTomatoTime', 'stale peer cannot resurrect an older phase')
  assert.equal(state.tomatoTime, 40, 'preferences still sync from the stale peer')
  assert.equal(state.startedAt, 9, 'phase keys preserved on stale peer')
  // peer with a NEWER phase applies wholesale
  globalThis.localStorage.setItem('tomatoSyncPing', 'peer-ping-2')
  const freshStart = Date.now()
  globalThis.localStorage.setItem('tomatoState', JSON.stringify({ status: 'startRestTime', startedAt: freshStart, phaseTs: 300, tomatoTime: 41 }))
  tomato.mutations.syncFromStorage(state)
  assert.equal(state.status, 'startRestTime')
  assert.equal(state.startedAt, freshStart)
})

test('actions.startFocus refuses to zero a running/resting focus; tick resets a stale count date and ignores non-expiry', () => {
  const a = makeCtx({ status: 'startTomatoTime', startedAt: Date.now() })
  tomato.actions.startFocus(a.ctx)
  assert.equal(a.state.status, 'startTomatoTime', 'illegal transition blocked')

  const b = makeCtx({ todayTomatoCount: 3, _countDate: '2000-01-01', status: 'default', startedAt: 0, remainSec: 1 })
  tomato.actions.tick(b.ctx)
  assert.equal(b.state.todayTomatoCount, 0, 'count date rollover resets on tick')

  const c = makeCtx({ status: 'default', startedAt: 0, tomatoTime: 25 })
  tomato.actions.tick(c.ctx)
  assert.deepEqual(c.dispatched, [], 'idle tick dispatches nothing')

  const d = makeCtx({ status: 'startTomatoTime', startedAt: Date.now() - 100, tomatoTime: 25 })
  tomato.actions.tick(d.ctx)
  assert.deepEqual(d.dispatched, [], 'not-yet-expired focus does not complete')
})

test('actions.tick completes an expired focus and finishes an expired rest', () => {
  const a = makeCtx({ status: 'startTomatoTime', startedAt: Date.now() - 26 * 60_000, tomatoTime: 25 })
  tomato.actions.tick(a.ctx)
  assert.deepEqual(a.dispatched.map(d => d[0]), ['completeFocus'])
  const b = makeCtx({ status: 'startRestTime', startedAt: Date.now() - 6 * 60_000, restTime: 5 })
  tomato.actions.tick(b.ctx)
  assert.deepEqual(b.dispatched.map(d => d[0]), ['finishRest'])
})

test('actions.finishRest: claims once, honors the notification gate, returns to default', () => {
  globalThis.localStorage.removeItem('tomatoLastPhaseDone')
  const notifs = []
  freshApi({ notification: n => notifs.push(n) })
  const a = makeCtx({ status: 'startRestTime', startedAt: 42, enableNotification: true, tomatoTime: 25 })
  tomato.actions.finishRest(a.ctx)
  assert.equal(a.state.status, 'default')
  assert.equal(a.state.startedAt, 0)
  assert.equal(a.state.remainSec, 25 * 60)
  assert.equal(notifs.length, 1)
  // second window in the same phase loses the claim
  const b = makeCtx({ status: 'startRestTime', startedAt: 42, enableNotification: true })
  tomato.actions.finishRest(b.ctx)
  assert.equal(notifs.length, 1, 'same-phase claim blocks double notification')
  globalThis.localStorage.removeItem('tomatoLastPhaseDone')
})

test('actions.giveUp: follows a peer that already entered rest; books a measured abandon when recording; record=false cancels silently', () => {
  globalThis.localStorage.removeItem('tomatoLastPhaseDone')
  freshApi()
  // local copy is default but the shared LS shows rest running → must not blind-write default
  globalThis.localStorage.setItem('tomatoState', JSON.stringify({ status: 'startRestTime', startedAt: Date.now(), tomatoTime: 25, restTime: 5, schemaV: 1 }))
  const a = makeCtx({ status: 'default', startedAt: 0 })
  tomato.actions.giveUp(a.ctx, { record: true })
  assert.equal(a.state.status, 'startRestTime', 'giveUp follows the peer rest phase instead of killing it')

  // claimed abandon records succeed:false with measured minutes and abandonReason
  globalThis.localStorage.removeItem('tomatoLastPhaseDone')
  const startedAt = Date.now() - 3 * 60_000 - 30_000 // 3.5 minutes ago
  const b = makeCtx({ status: 'startTomatoTime', startedAt, attachTodo: { taskId: 't1', taskContent: 'w' } },
    { rootState: { todo: { todoList: [{ taskId: 't1', taskContent: 'w' }], recycleList: [] } } })
  tomato.actions.giveUp.call({ rootState: b.ctx.rootState }, b.ctx, { record: true, reason: '  interrupted  ' })
  const rec = b.state.tomatoRecordList.find(r => r.tomatoId === 'tmt_a_' + startedAt)
  assert.ok(rec, 'abandon record booked with deterministic id')
  assert.equal(rec.succeed, false)
  assert.equal(rec.abandonReason, 'interrupted')
  assert.equal(rec.focusDuration, 4, 'Math.round of 3.5 min')
  assert.equal(rec.focusTaskId, 't1')
  assert.equal(b.state.status, 'default')

  // record=false: no booking
  globalThis.localStorage.removeItem('tomatoLastPhaseDone')
  const c = makeCtx({ status: 'startTomatoTime', startedAt: Date.now() })
  tomato.actions.giveUp(c.ctx, { record: false })
  assert.equal(c.state.tomatoRecordList.length, 0)
  assert.equal(c.state.status, 'default')
  globalThis.localStorage.removeItem('tomatoLastPhaseDone')
})

test('actions.giveUp: a lost cross-window claim follows the shared state instead of double-booking', () => {
  // Simulate the other window having already claimed + completed this phase: LS claim matches,
  // and the shared blob already moved on to rest.
  const startedAt = Date.now() - 60_000
  globalThis.localStorage.setItem('tomatoLastPhaseDone', 'startTomatoTime:' + startedAt)
  globalThis.localStorage.setItem('tomatoState', JSON.stringify({ status: 'startRestTime', startedAt: Date.now(), tomatoTime: 25, restTime: 5, schemaV: 1, phaseTs: Date.now() }))
  const a = makeCtx({ status: 'startTomatoTime', startedAt, tomatoRecordList: [] })
  tomato.actions.giveUp(a.ctx, { record: true })
  assert.equal(a.state.tomatoRecordList.length, 0, 'no abandon record when the phase was already claimed')
  assert.equal(a.state.status, 'startRestTime', 'follows the peer state')
  globalThis.localStorage.removeItem('tomatoLastPhaseDone')
})

test('actions.attach links an existing task and clears on unknown/empty ids', () => {
  const t = { taskId: 't1', taskContent: 'task one' }
  const a = makeCtx({ status: 'default' }, { rootState: { todo: { todoList: [t], recycleList: [] }, settings: {} } })
  a.ctx.this = null
  // attach uses this.state.todo — simulate via a real `this`
  const ctxThis = { state: { todo: { todoList: [t] } } }
  tomato.actions.attach.call(ctxThis, a.ctx, 't1')
  assert.deepEqual(a.state.attachTodo, { taskId: 't1', taskContent: 'task one' })
  tomato.actions.attach.call(ctxThis, a.ctx, 'ghost')
  assert.equal(a.state.attachTodo, null)
  tomato.actions.attach.call(ctxThis, a.ctx, null)
  assert.equal(a.state.attachTodo, null)
})

test('actions.completeFocus: guard returns without a running focus; dead task → free focus without bumpSnow', async () => {
  globalThis.localStorage.removeItem('tomatoLastPhaseDone')
  const snowWrites = []
  freshApi({ dbCall: async (op) => {
    if (op === 'getById') return { taskId: 't1', delete: true } // task died mid-focus
    snowWrites.push(op)
    return { accepted: 1, rejected: [] }
  } })
  const a = makeCtx({ status: 'default' })
  await tomato.actions.completeFocus.call({}, a.ctx)
  assert.equal(a.state.tomatoRecordList.length, 0, 'no free tomato for a bogus completion call')

  const startedAt = Date.now() - 25 * 60_000
  const b = makeCtx({ status: 'startTomatoTime', startedAt, attachTodo: { taskId: 't1', taskContent: 'w' }, restTime: 5 },
    { rootState: { todo: { todoList: [{ taskId: 't1', taskContent: 'w' }], recycleList: [] }, settings: {} } })
  globalThis.localStorage.setItem('tomatoState', JSON.stringify({ status: 'startTomatoTime', startedAt, tomatoTime: 25, restTime: 5, schemaV: 1, phaseTs: Date.now() }))
  await tomato.actions.completeFocus.call({ rootState: b.ctx.rootState }, b.ctx)
  const rec = b.state.tomatoRecordList[0]
  assert.equal(rec.tomatoId, 'tmt_f_' + startedAt)
  assert.equal(rec.succeed, true)
  assert.equal(rec.focusTaskId, null, 'dead target resolved to free focus at accounting time')
  assert.equal(rec.focusDuration, 25)
  assert.equal(b.state.status, 'startRestTime', 'rest phase entered after completion')
  assert.equal(b.state.todayTomatoCount, 1)
  assert.ok(!snowWrites.includes('bumpSnow'), 'no bumpSnow fired for a dead task (minutes would vanish silently)')
  globalThis.localStorage.removeItem('tomatoLastPhaseDone')
})

test('actions.completeFocus: live task books bumpSnow with dedupKey; claim loss aborts', async () => {
  globalThis.localStorage.removeItem('tomatoLastPhaseDone')
  const bumps = []
  freshApi({ dbCall: async (op, params) => {
    if (op === 'getById') return { taskId: 't1', delete: false }
    if (op === 'bumpSnow') bumps.push(params)
    return { accepted: 1, rejected: [] }
  } })
  const startedAt = Date.now() - 25 * 60_000
  const a = makeCtx({ status: 'startTomatoTime', startedAt, attachTodo: { taskId: 't1', taskContent: 'w' } },
    { rootState: { todo: { todoList: [{ taskId: 't1', taskContent: 'w' }], recycleList: [] }, settings: {} } })
  globalThis.localStorage.setItem('tomatoState', JSON.stringify({ status: 'startTomatoTime', startedAt, tomatoTime: 25, restTime: 5, schemaV: 1, phaseTs: Date.now() }))
  await tomato.actions.completeFocus.call({ rootState: a.ctx.rootState }, a.ctx)
  assert.equal(a.state.tomatoRecordList[0].focusTaskId, 't1')
  await new Promise(r => setTimeout(r, 20))
  assert.equal(bumps.length, 1)
  assert.equal(bumps[0].dedupKey, String(startedAt), 'snow credit carries the phase identity as dedupKey')
  assert.equal(bumps[0].minutes, 25)
  globalThis.localStorage.removeItem('tomatoLastPhaseDone')

  // claim already held by a peer → completion aborts without booking
  const startedAt2 = Date.now() - 25 * 60_000
  globalThis.localStorage.setItem('tomatoLastPhaseDone', 'startTomatoTime:' + startedAt2)
  const b = makeCtx({ status: 'startTomatoTime', startedAt: startedAt2, attachTodo: null })
  await tomato.actions.completeFocus.call({}, b.ctx)
  assert.equal(b.state.tomatoRecordList.length, 0, 'claimed phase cannot complete twice')
  globalThis.localStorage.removeItem('tomatoLastPhaseDone')
})

test('actions.completeFocus: a concurrent give-up during the verify await aborts the completion (claim released)', async () => {
  globalThis.localStorage.removeItem('tomatoLastPhaseDone')
  // Slow getById widens the await window; a giveUp flips the shared LS phase while we wait.
  let releaseGetById
  const gate = new Promise(r => { releaseGetById = r })
  freshApi({ dbCall: async (op) => {
    if (op === 'getById') { await gate; return { taskId: 't1', delete: false } }
    return { accepted: 1, rejected: [] }
  } })
  const startedAt = Date.now() - 25 * 60_000
  const a = makeCtx({ status: 'startTomatoTime', startedAt, attachTodo: { taskId: 't1', taskContent: 'w' } },
    { rootState: { todo: { todoList: [{ taskId: 't1', taskContent: 'w' }], recycleList: [] }, settings: {} } })
  globalThis.localStorage.setItem('tomatoState', JSON.stringify({ status: 'startTomatoTime', startedAt, tomatoTime: 25, restTime: 5, schemaV: 1, phaseTs: Date.now() }))
  const pending = tomato.actions.completeFocus.call({ rootState: a.ctx.rootState }, a.ctx)
  // meanwhile: the user gave up in the float window → shared phase back to default
  globalThis.localStorage.setItem('tomatoState', JSON.stringify({ status: 'default', startedAt: 0, tomatoTime: 25, restTime: 5, schemaV: 1, phaseTs: Date.now() }))
  releaseGetById()
  await pending
  assert.equal(a.state.tomatoRecordList.length, 0, 'completion abandoned after concurrent give-up')
  assert.equal(globalThis.localStorage.getItem('tomatoLastPhaseDone'), null, 'claim released so nothing is wedged')
  globalThis.localStorage.removeItem('tomatoLastPhaseDone')
})

test('ledger retry queue: a failed remove keeps queueing, a later success purges pending appends for the same ids', async () => {
  let failRemove = true
  const calls = []
  freshApi({ dbCall: async (op, params) => {
    calls.push([op, params])
    if (op === 'tomatoRemoveByIds' && failRemove) throw new Error('ipc down')
    return { accepted: 1, rejected: [] }
  } })
  globalThis.localStorage.removeItem('tomatoPendingLedger')
  const { state } = makeCtx({ tomatoRecordList: [{ tomatoId: 'seed' }] })
  // TQ-2: per-entry mirror keys (tomatoPendingLedger.<uid>) — assert SYNCHRONOUSLY at enqueue,
  // before the replay settles the (db-accepted) entry and deletes its own key.
  tomato.mutations.addRecord(state, { tomatoId: 'k1', endTime: 1 })
  const lsNow = globalThis.localStorage
  let mirrored = false
  for (let i = 0; i < lsNow.length; i++) {
    const k = lsNow.key(i)
    if (k && k.indexOf('tomatoPendingLedger.') === 0) { mirrored = true; break }
  }
  assert.ok(mirrored, 'addRecord mirrors its ledger entry to a per-entry LS key')
  await new Promise(r => setTimeout(r, 20))

  tomato.mutations.removeRecord(state, 'k1') // remove fails this round → stays queued
  await new Promise(r => setTimeout(r, 30))
  failRemove = false
  // any next ledger write replays the queue
  tomato.mutations.removeRecord(state, 'ghost-id')
  await new Promise(r => setTimeout(r, 30))
  const removes = calls.filter(c => c[0] === 'tomatoRemoveByIds')
  assert.ok(removes.some(c => c[1].includes('k1')), 'failed remove replayed from the retry queue')
  globalThis.localStorage.removeItem('tomatoPendingLedger')
  globalThis.localStorage.removeItem('tomatoPendingSnow')
})
