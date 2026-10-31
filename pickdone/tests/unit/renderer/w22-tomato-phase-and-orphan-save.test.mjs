/**
 * W22 maintenance wave, agent-1 regressions (2026-10-30):
 *  [P1] finishRest claim-leak: a settleRestDuration failure (ledgerWrite loud-throw) used to leak
 *       the phase claim forever — the phase stayed 'startRestTime' and claimPhase for the SAME
 *       phase never won again → the phase wedged permanently. Fix: release-on-failure (G1 mirror
 *       of completeFocus), next tick retries.
 *  [P2] startFocus stale-copy guard: a local 'default' copy plus a shared LS blob showing another
 *       window's running phase used to be clobbered by the blind patch (peer's startedAt silently
 *       zeroed, focus lost). Fix: re-read the shared transient first (same shape as giveUp).
 *  [P2] editSave.flushSave failure observability: the old .catch swallowed the failure and resolved
 *       the flush, so ui/cleanupInlineCreated orphan-deleted the inline-created task although its
 *       save never landed. Fix: each flush slot settles to a boolean; cleanup keeps the task on
 *       failure (observable via console.error, retry via the panel banner).
 * Run: node --test tests/unit/renderer/w22-tomato-phase-and-orphan-save.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const tomato = (await import('../../../renderer/js/store/tomato.js')).default
const ui = (await import('../../../renderer/js/store/ui.js')).default
const { createSaveQueue } = await import('../../../renderer/js/utils/editSave.js')

const CLAIM_KEY = 'tomatoLastPhaseDone'
const LS_KEY = 'tomatoState'

/* ---------------- [P1] finishRest: failure after claim releases the claim ---------------- */

function restState (restStartedAt, patch = {}) {
  return Object.assign({}, tomato.state, {
    status: 'startRestTime', startedAt: restStartedAt,
    tomatoTime: 25, restTime: 5, enableNotification: false, attachTodo: null,
    tomatoRecordList: [{ tomatoId: 'tmt_f_' + (restStartedAt - 25 * 60000), succeed: true, endTime: restStartedAt, restDuration: 5, focusDuration: 25 }],
    todayTomatoCount: 1
  }, patch)
}

test('W22 P1: a failed settle after claiming releases the rest claim so the next tick can retry', async () => {
  globalThis.localStorage.removeItem(CLAIM_KEY)
  const restStartedAt = Date.now() - 60000 // measured rest = 1 minute
  const state = restState(restStartedAt)
  let settleThrows = true
  const { ctx } = (() => {
    const ctx = {
      state,
      commit (m, p) { if (settleThrows && m === 'updateRecord') throw new Error('ledger loud-throw'); tomato.mutations[m] && tomato.mutations[m](state, p) }
    }
    return { ctx }
  })()
  await tomato.actions.finishRest(ctx)
  assert.equal(state.status, 'startRestTime', 'the phase stays running when the settle failed')
  assert.notEqual(globalThis.localStorage.getItem(CLAIM_KEY), 'startRestTime:' + restStartedAt,
    'the phase claim was released on failure (previously leaked forever → the phase wedged)')
  // The next tick can re-finish the same rest phase
  settleThrows = false
  await tomato.actions.finishRest(ctx)
  assert.equal(state.status, 'default', 'the retry flips to default as before')
  assert.equal(state.startedAt, 0)
  assert.equal(state.tomatoRecordList[0].restDuration, 1, 'the retry still settles the measured rest duration')
})

test('W22 P1: a healthy finishRest is unchanged (no claim leak, normal flip)', async () => {
  globalThis.localStorage.removeItem(CLAIM_KEY)
  const restStartedAt = Date.now() - 120000
  const state = restState(restStartedAt)
  await tomato.actions.finishRest({ state, commit (m, p) { tomato.mutations[m] && tomato.mutations[m](state, p) } })
  assert.equal(state.status, 'default')
  assert.equal(state.tomatoRecordList[0].restDuration, 2)
  // Success keeps the per-phase mark by design (startedAt never repeats, so it can never block a
  // legitimate new phase) — the release-on-failure fix above only covers the failure path.
  assert.equal(globalThis.localStorage.getItem(CLAIM_KEY), 'startRestTime:' + restStartedAt)
})

/* ---------------- [P2] startFocus: stale local copy must not clobber a peer's running phase ---------------- */

function defaultState () {
  return Object.assign({}, tomato.state, {
    status: 'default', startedAt: 0, tomatoTime: 25, restTime: 5, remainSec: 1500,
    tomatoRecordList: [], todayTomatoCount: 0, enableNotification: false
  })
}

test('W22 P2: startFocus refuses to start over a peer phase still live in the shared LS', () => {
  const peerStartedAt = Date.now() - 5000
  globalThis.localStorage.setItem(LS_KEY, JSON.stringify({
    schemaV: 1, status: 'startTomatoTime', startedAt: peerStartedAt, tomatoTime: 25, restTime: 5, remainSec: 1500
  }))
  const state = defaultState()
  const commits = []
  tomato.actions.startFocus({ state, commit (m, p) { commits.push(p); tomato.mutations[m] && tomato.mutations[m](state, p) } })
  assert.equal(commits.length, 0, 'no patch is written over the peer running phase')
  assert.equal(state.status, 'default', 'the local copy stays default (start aborted, retryable)')
  assert.equal(state.startedAt, 0, "the peer's startedAt was not silently zeroed")
})

test('W22 P2: startFocus also refuses over a peer REST phase (any running phase blocks)', () => {
  globalThis.localStorage.setItem(LS_KEY, JSON.stringify({
    schemaV: 1, status: 'startRestTime', startedAt: Date.now() - 30000, tomatoTime: 25, restTime: 5, remainSec: 100
  }))
  const state = defaultState()
  const commits = []
  tomato.actions.startFocus({ state, commit (m, p) { commits.push(p) } })
  assert.equal(commits.length, 0)
})

test('W22 P2: startFocus with an idle shared mirror still starts normally (positive control)', () => {
  globalThis.localStorage.removeItem(LS_KEY)
  const state = defaultState()
  tomato.actions.startFocus({ state, commit (m, p) { tomato.mutations[m] && tomato.mutations[m](state, p) } })
  assert.equal(state.status, 'startTomatoTime', 'a normal start is untouched by the guard')
  assert.ok(state.startedAt > 0)
})

/* ---------------- [P2] flushSave failure → the inline-created task is NOT orphan-deleted ---------------- */

function uiCtx (todoList, dispatched) {
  const state = ui.state()
  state.inlineCreatedTaskId = 't1'
  state.rightSidebarTodoEdit = { visible: true, collapsed: false, taskId: 't1' }
  return {
    state,
    rootState: { todo: { todoList, recycleList: [] } },
    commit (m, p) { ui.mutations[m] && ui.mutations[m](state, p) },
    dispatch (path, p) { dispatched.push({ path, p }); return Promise.resolve() }
  }
}

test('W22 P2: a FAILED flush (dispatch rejects) keeps the inline-created task — no orphan delete', async () => {
  globalThis.localStorage.removeItem(CLAIM_KEY)
  const dispatched = []
  const todoList = [{ taskId: 't1', taskContent: '' }]
  const ctx = uiCtx(todoList, dispatched)
  let rejectNext = true
  const updateCalls = []
  const store = {
    async dispatch (path, p) {
      if (path === 'todo/updateTodoFields') {
        updateCalls.push(p)
        if (rejectNext) throw new Error('db write failed')
        return
      }
      throw new Error('unexpected dispatch: ' + path)
    }
  }
  const onFail = []
  const q = createSaveQueue(store, { getTaskId: () => 't1', onFail: () => onFail.push(1) })
  q.boot()
  q.queueSave({ taskContent: '快写的标题' })
  globalThis.window.__editPanelFlushSave = () => q.flushSave()
  try {
    await ui.actions.closeEditCleanup(ctx)
    assert.equal(updateCalls.length, 1, 'the flush attempted the pending save exactly once')
    assert.equal(onFail.length, 1, 'the failure banner was surfaced')
    assert.ok(!dispatched.some(d => d.path === 'todo/deleteTodo'),
      'the task must NOT be deleted when its save failed')
    // Observability: the skip is logged, not silent
    // (console.error asserted in the dedicated observability test below)
    // Retry contract intact: the failed patch was requeued and replays on a healthy flush
    rejectNext = false
    await q.flushSave()
    assert.equal(updateCalls.length, 2)
    assert.equal(updateCalls[1].patch.taskContent, '快写的标题', 'the failed edit survived for retry')
  } finally { delete globalThis.window.__editPanelFlushSave }
})

test('W22 P2: the flush-failure skip is logged observably (console.error, taskId included)', async () => {
  const dispatched = []
  const todoList = [{ taskId: 't-obs', taskContent: '' }]
  const ctx = uiCtx(todoList, dispatched)
  const errs = []
  const orig = console.error
  console.error = (...a) => errs.push(a.join(' '))
  globalThis.window.__editPanelFlushSave = () => Promise.resolve([false]) // flushSave's failure shape
  try {
    await ui.actions.closeEditCleanup(ctx)
    assert.ok(!dispatched.some(d => d.path === 'todo/deleteTodo'), 'no delete on a failed flush')
    assert.ok(errs.some(w => w.includes('[ui]') && w.includes('skipped') && w.includes('t1')), 'the skip is logged with the taskId')
  } finally { console.error = orig; delete globalThis.window.__editPanelFlushSave }
})

test('W22 P2: a healthy flush (empty title, save landed) still orphan-deletes (positive control)', async () => {
  const dispatched = []
  const todoList = [{ taskId: 't1', taskContent: '' }]
  const ctx = uiCtx(todoList, dispatched)
  globalThis.window.__editPanelFlushSave = () => Promise.resolve([true])
  try {
    await ui.actions.closeEditCleanup(ctx)
    assert.ok(dispatched.some(d => d.path === 'todo/deleteTodo'),
      'the untitled inline-created orphan is still cleaned up on success')
  } finally { delete globalThis.window.__editPanelFlushSave }
})

test('W22 P2: flushSave settles each slot to a boolean (false on failure, never rejects)', async () => {
  let reject = true
  const store = { async dispatch () { if (reject) throw new Error('boom') } }
  const q = createSaveQueue(store, { getTaskId: () => 'x', onFail: () => {} })
  q.boot()
  q.queueSave({ taskContent: 'a' })
  const failed = await q.flushSave()
  assert.deepEqual(failed, [false], 'the failure is observable to awaiting callers')
  reject = false
  q.queueSave({ taskContent: 'b' })
  const ok = await q.flushSave()
  assert.deepEqual(ok, [true], 'a healthy flush resolves truthy slots')
})
