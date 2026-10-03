/** TQ-4 (2026-10-03) — one settlement contract for both durable queues.
 *
 * Invariant under test: a structurally-terminal bumpSnow refusal ({ok:false,
 * reason:'deleted'|'missing'} — the db UPDATE runs WHERE id=@taskId AND deleted=0, so a
 * hard-deleted/missing task can never accept the bump) leaves BOTH the pending queue and its LS
 * mirror and lands in the capped durable quarantine (tomatoRejectedSnowEntries) — the same
 * permanently-unacceptable→quarantine+retire contract the ledger queue already implemented.
 * Falsy/throw/unknown shapes stay retryable. Pre-fix, the snow queue retried everything except
 * ok:true, so terminal refusals replayed forever (monotonic queue growth + a dbCall round-trip
 * + an error line on every future snowWrite).
 *
 * Run: node --test tests/unit/store/tq4-snow-terminal-refusals.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const LS = globalThis.localStorage
const SNOW_PREFIX = 'tomatoPendingSnow.'
const QUARANTINE_KEY = 'tomatoRejectedSnowEntries'

function snowQueue () {
  const out = []
  for (let i = 0; i < LS.length; i++) {
    const k = LS.key(i)
    if (k && k.indexOf(SNOW_PREFIX) === 0 && k !== SNOW_PREFIX + 'corrupt') { try { out.push(JSON.parse(LS.getItem(k)).entry) } catch (e) { /* skip */ } }
  }
  return out
}

function quarantine () {
  try { return JSON.parse(LS.getItem(QUARANTINE_KEY)) || [] } catch (e) { return [] }
}

function clearAll () {
  for (const k of Array.from({ length: LS.length }, (_, i) => LS.key(i)).filter(Boolean)) LS.removeItem(k)
}

/** Drive a full completion with an attached task whose bumpSnow returns `bumpResult`
 *  (same harness shape as d11r3[2]: the completion queues a snow entry and replays it). */
async function completeWithBump (bumpResult, tag) {
  clearAll()
  const startedAt = Date.now()
  LS.setItem('tomatoState', JSON.stringify({ schemaV: 1, status: 'startTomatoTime', startedAt, tomatoTime: 25, restTime: 5 }))
  globalThis.window.todoAPI = {
    dbCall: async (op) => {
      if (op === 'getById') return { taskId: 7, delete: false }
      if (op === 'bumpSnow') return bumpResult
      return { accepted: 1, rejected: [] }
    }
  }
  const { default: tomato } = await import('../../../renderer/js/store/tomato.js?' + tag)
  const state = Object.assign({}, tomato.state, {
    status: 'startTomatoTime', startedAt, tomatoTime: 25, restTime: 5,
    enableNotification: false, attachTodo: { taskId: 7, taskContent: 'Task' },
    tomatoRecordList: [], todayTomatoCount: 0
  })
  const ctx = {
    state,
    rootState: { todo: { todoList: [{ taskId: 7, taskContent: 'Task', delete: false }] }, settings: {} },
    commit (m, p) { tomato.mutations[m] && tomato.mutations[m](state, p) },
    dispatch () { return Promise.resolve() }
  }
  await tomato.actions.completeFocus.call({ rootState: ctx.rootState, state }, ctx)
  await new Promise(r => setTimeout(r, 20))
}

test('tq4: a terminal bumpSnow refusal (deleted/missing) quarantines durably and retires the entry', async () => {
  await completeWithBump({ ok: false, reason: 'deleted' }, 'tq4-del')
  const q = quarantine()
  assert.equal(q.length, 1, 'THE INVARIANT: the terminal refusal lands in the durable capped quarantine')
  assert.equal(q[0].reason, 'deleted')
  assert.ok(q[0].ts > 0, 'quarantine carries a timestamp')
  assert.equal(q[0].params.taskId, 7, 'the refused payload is preserved (manual recovery surface)')
  assert.equal(snowQueue().length, 0, 'the entry left the pending queue')
  assert.equal(snowQueue().filter(e => e && e.params && e.params.taskId === 7).length, 0, '...and its LS mirror')

  await completeWithBump({ ok: false, reason: 'missing' }, 'tq4-missing')
  assert.equal(quarantine().filter(r => r.reason === 'missing').length, 1, "'missing' is terminal too")
  assert.equal(snowQueue().length, 0)
})

test('tq4[b]: non-terminal shapes (throw / falsy / unknown reason) stay retryable', async () => {
  // throwing bump stays queued
  clearAll()
  const startedAt = Date.now()
  LS.setItem('tomatoState', JSON.stringify({ schemaV: 1, status: 'startTomatoTime', startedAt, tomatoTime: 25, restTime: 5 }))
  globalThis.window.todoAPI = {
    dbCall: async (op) => {
      if (op === 'getById') return { taskId: 7, delete: false }
      if (op === 'bumpSnow') throw new Error('ipc down')
      return { accepted: 1, rejected: [] }
    }
  }
  const { default: tomato } = await import('../../../renderer/js/store/tomato.js?tq4-throw')
  const state = Object.assign({}, tomato.state, {
    status: 'startTomatoTime', startedAt, tomatoTime: 25, restTime: 5,
    enableNotification: false, attachTodo: { taskId: 7, taskContent: 'Task' },
    tomatoRecordList: [], todayTomatoCount: 0
  })
  const ctx = {
    state,
    rootState: { todo: { todoList: [{ taskId: 7, taskContent: 'Task', delete: false }] }, settings: {} },
    commit (m, p) { tomato.mutations[m] && tomato.mutations[m](state, p) },
    dispatch () { return Promise.resolve() }
  }
  await tomato.actions.completeFocus.call({ rootState: ctx.rootState, state }, ctx)
  await new Promise(r => setTimeout(r, 20))
  assert.equal(snowQueue().length, 1, 'a THROW is ambiguous → the entry stays queued (retry contract unchanged)')
  assert.equal(quarantine().length, 0, 'nothing quarantined for a transient failure')
})
