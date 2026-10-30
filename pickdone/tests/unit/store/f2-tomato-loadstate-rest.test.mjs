/**
 * F2 fixer wave (2026-10-18):
 *  - P3-1: loadState() merged the LS blob straight in, bypassing clampNumericSettings — a
 *    hand-edited/legacy blob with tomatoTime: 9999 loaded into the countdown and re-persisted.
 *  - P3-2: completeFocus booked restDuration = planned restTime; finishRest / a rest-phase
 *    giveUp never settled the row to the MEASURED rest.
 * Run: node --test tests/unit/store/f2-tomato-loadstate-rest.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const LS_KEY = 'tomatoState'
const CLAIM_KEY = 'tomatoLastPhaseDone'

test('loadState clamps numeric prefs from the LS blob (tomatoTime 9999 -> 180, restTime 0 -> 1)', async () => {
  globalThis.localStorage.setItem(LS_KEY, JSON.stringify({
    schemaV: 1, status: 'default', startedAt: 0,
    tomatoTime: 9999, restTime: 0, remainSec: 9999 * 60
  }))
  // Dynamic import: the store's initial state is loadState() at module load, so the blob must
  // be seeded BEFORE the module is first evaluated.
  const tomato = (await import('../../../renderer/js/store/tomato.js')).default
  globalThis.__f2Tomato = tomato // shared by the ctx factory below (fresh module per test process)
  assert.equal(tomato.state.tomatoTime, 180, 'focus minutes clamped to the manifest max (same caliber as settings.js F-C3)')
  assert.equal(tomato.state.restTime, 1, 'rest minutes clamped to the manifest min')
  assert.equal(tomato.state.remainSec, 9999 * 60, 'remainSec is not a manifest key and stays as-is')
})

function makeCtx (statePatch = {}) {
  const tomato = globalThis.__f2Tomato
  const state = Object.assign({}, tomato.state, {
    status: 'default', startedAt: 0,
    tomatoTime: 25, restTime: 5, enableNotification: false,
    attachTodo: null, tomatoRecordList: [], todayTomatoCount: 0
  }, statePatch)
  const ctx = {
    state,
    rootState: { todo: { todoList: [] }, settings: {} },
    commit (m, p) { tomato.mutations[m] && tomato.mutations[m](state, p) },
    dispatch () { return Promise.resolve() }
  }
  return { ctx, state }
}

test('finishRest settles the booked row restDuration to the MEASURED rest (was planned 5)', async () => {
  const tomato = globalThis.__f2Tomato
  globalThis.localStorage.removeItem(CLAIM_KEY)
  const restStartedAt = Date.now() - 120000 // 2 measured rest minutes against a planned 5
  const { ctx, state } = makeCtx({ status: 'startRestTime', startedAt: restStartedAt })
  // Seed the row exactly as completeFocus books it (restDuration = PLANNED restTime).
  tomato.mutations.addRecord(state, {
    tomatoId: 'tmt_f_x1', endTime: restStartedAt, dateKey: '1970-01-01',
    focus: 'task', focusTaskId: null, focusDuration: 25, rest: 5, restDuration: 5, succeed: true, status: 'local'
  })
  await tomato.actions.finishRest(ctx)
  assert.equal(state.status, 'default')
  assert.equal(state.tomatoRecordList[0].restDuration, 2, 'row settled to the measured rest minutes')
})

test('giveUp during rest settles the booked row restDuration to the MEASURED rest', async () => {
  const tomato = globalThis.__f2Tomato
  globalThis.localStorage.removeItem(CLAIM_KEY)
  const restStartedAt = Date.now() - 20000 // sub-1-min rest -> 0 (no phantom rest minute)
  const { ctx, state } = makeCtx({ status: 'startRestTime', startedAt: restStartedAt })
  tomato.mutations.addRecord(state, {
    tomatoId: 'tmt_f_x2', endTime: restStartedAt, dateKey: '1970-01-01',
    focus: 'task', focusTaskId: null, focusDuration: 25, rest: 5, restDuration: 5, succeed: true, status: 'local'
  })
  await tomato.actions.giveUp(ctx, { record: true, reason: '' })
  assert.equal(state.status, 'default', 'rest abandon still resets to default')
  assert.equal(state.tomatoRecordList.length, 1, 'no extra abandon row for the rest phase')
  assert.equal(state.tomatoRecordList[0].restDuration, 0, 'sub-minute rest books 0 (giveUp sub-minute caliber)')
})

test('giveUp while resting does NOT touch rows whose endTime is not the rest start', async () => {
  const tomato = globalThis.__f2Tomato
  globalThis.localStorage.removeItem(CLAIM_KEY)
  const restStartedAt = Date.now() - 90000
  const { ctx, state } = makeCtx({ status: 'startRestTime', startedAt: restStartedAt })
  tomato.mutations.addRecord(state, {
    tomatoId: 'tmt_f_old', endTime: restStartedAt - 3600000, dateKey: '1970-01-01',
    focus: 'old', focusTaskId: null, focusDuration: 10, rest: 5, restDuration: 3, succeed: true, status: 'local'
  })
  await tomato.actions.giveUp(ctx, { record: true, reason: '' })
  assert.equal(state.tomatoRecordList[0].restDuration, 3, 'unrelated row untouched by the rest settle')
})
