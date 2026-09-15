/**
 * G1 regressions for store/tomato.js:
 *  [2] completeFocus: a failure after claimPhase but before addRecord/saveSnowGain must release the
 *      phase claim so the completion can be retried (was: tomato lost forever behind a stale claim);
 *  [3] completeFocus re-verifies the shared transient after the getById await window — a concurrent
 *      giveUp(record=false) that flipped the phase to default wins; no rest patch / no points;
 *  [4] updateRecord warns (with taskId) when an invalid endTime field is silently skipped.
 * Run: node --test tests/unit/store/g1-tomato-complete-races.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import tomato from '../../../renderer/js/store/tomato.js'

const CLAIM_KEY = 'tomatoLastPhaseDone'
const LS_KEY = 'tomatoState'

function baseState (patch = {}) {
  return Object.assign({}, tomato.state, {
    status: 'startTomatoTime', startedAt: Date.now(),
    tomatoTime: 25, restTime: 5, enableNotification: false,
    attachTodo: null, tomatoRecordList: [], todayTomatoCount: 0
  }, patch)
}

function makeCtx (state, overrides = {}) {
  const dispatched = []
  const ctx = {
    state,
    rootState: { todo: { todoList: [] }, settings: {} },
    commit (m, p) { if (overrides.guardCommit && overrides.guardCommit(m)) throw new Error('boom'); tomato.mutations[m] && tomato.mutations[m](state, p) },
    dispatch (path) { dispatched.push(path); return Promise.resolve() }
  }
  return { ctx, dispatched }
}

test('G1 tomato [2]: a failure after claiming releases the claim so the completion can retry', async () => {
  globalThis.localStorage.removeItem(CLAIM_KEY)
  const startedAt = Date.now()
  const state = baseState({ startedAt })
  let throws = true
  const { ctx } = makeCtx(state, { guardCommit: m => throws && m === 'addRecord' })
  await tomato.actions.completeFocus(ctx)
  assert.equal(state.tomatoRecordList.length, 0, 'booking failed as staged')
  assert.notEqual(globalThis.localStorage.getItem(CLAIM_KEY), 'startTomatoTime:' + startedAt,
    'the phase claim was released on failure (previously stuck forever → tomato lost)')
  // The next tick can now re-complete the same phase
  throws = false
  await tomato.actions.completeFocus(ctx)
  assert.equal(state.tomatoRecordList.length, 1, 'the retry after the released claim books the tomato')
  assert.equal(state.tomatoRecordList[0].tomatoId, 'tmt_f_' + startedAt)
})

test('G1 tomato [3]: a giveUp during the getById await window wins — no record, no rest, claim cleared', async () => {
  globalThis.localStorage.removeItem(CLAIM_KEY)
  const startedAt = Date.now()
  const state = baseState({ startedAt, attachTodo: { taskId: 7, taskContent: 'Task' } })
  const rootState = { todo: { todoList: [{ taskId: 7, taskContent: 'Task', delete: false }] }, settings: {} }
  const { ctx } = makeCtx(state)
  ctx.rootState = rootState
  globalThis.window.todoAPI = { dbCall: async () => {
    // concurrent giveUp(record=false) flips the shared transient to default while we await
    globalThis.localStorage.setItem(LS_KEY, JSON.stringify({ schemaV: 1, status: 'default', startedAt: 0, tomatoTime: 25, restTime: 5 }))
    await new Promise(r => setTimeout(r, 10))
    return { taskId: 7, delete: false }
  } }
  try {
    // `this` binding supplies the todo-row pool (mirrors a real Vuex store)
    await tomato.actions.completeFocus.call({ rootState, state }, ctx)
    assert.equal(state.tomatoRecordList.length, 0, 'no tomato is booked for a phase the user gave up mid-flight')
    assert.notEqual(state.status, 'startRestTime', 'no rest phase is started over the give-up')
    assert.equal(state.todayTomatoCount, 0, 'no points counted')
    assert.notEqual(globalThis.localStorage.getItem(CLAIM_KEY), 'startTomatoTime:' + startedAt, 'claim released on abort')
  } finally { delete globalThis.window.todoAPI }
})

test('G1 tomato [3] positive control: without a concurrent give-up the completion books normally', async () => {
  globalThis.localStorage.removeItem(CLAIM_KEY)
  const startedAt = Date.now()
  const state = baseState({ startedAt, attachTodo: { taskId: 7, taskContent: 'Task' } })
  const rootState = { todo: { todoList: [{ taskId: 7, taskContent: 'Task', delete: false }] }, settings: {} }
  const { ctx } = makeCtx(state)
  ctx.rootState = rootState
  globalThis.window.todoAPI = { dbCall: async () => ({ taskId: 7, delete: false }) }
  try {
    // shared transient reflects the still-running focus (test [2]'s give-up blob must not leak in)
    globalThis.localStorage.setItem(LS_KEY, JSON.stringify({ schemaV: 1, status: 'startTomatoTime', startedAt, tomatoTime: 25, restTime: 5 }))
    await tomato.actions.completeFocus.call({ rootState, state }, ctx)
    assert.equal(state.tomatoRecordList.length, 1, 'normal completion still records')
    assert.equal(state.status, 'startRestTime', 'rest phase starts as before')
  } finally { delete globalThis.window.todoAPI }
})

test('G1 tomato [4]: updateRecord warns with the record id when endTime is invalid', () => {
  const warns = []
  const orig = console.warn
  console.warn = (...a) => warns.push(a.join(' '))
  try {
    const state = { tomatoRecordList: [{ tomatoId: 'tmt_x_1', endTime: 1000, dateKey: '2026-09-15', focusDuration: 25, restDuration: 5, succeed: true }] }
    tomato.mutations.updateRecord(state, { tomatoId: 'tmt_x_1', patch: { endTime: 0, succeed: false } })
    assert.equal(state.tomatoRecordList[0].endTime, 1000, 'invalid endTime still skipped (rejection semantics unchanged)')
    assert.equal(state.tomatoRecordList[0].succeed, false, 'the rest of the patch still applies')
    assert.ok(warns.some(w => w.includes('tmt_x_1') && w.includes('endTime')), 'the partial application is surfaced with taskId and field name')
  } finally { console.warn = orig }
})
