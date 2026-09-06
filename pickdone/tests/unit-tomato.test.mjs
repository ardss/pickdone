/**
 * Pomodoro store real-path tests - the only prior idempotency test exercised dedupeById, which has no production callers (dead code);
 * the real defenses - the completeFocus token + addRecord dedup + giveUp paused-state booking - had zero coverage (pre-release review P0).
 * Here a fake ctx drives the real actions of store/tomato.js; double invocation simulates main-window + float-window concurrent completion.
 * Run: npm test
 */
import './setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import tomato from '../renderer/js/store/tomato.js'

// The i18n shim provides VueI18n; completeFocus's internal tt() uses the real lexicon
// Audio does not exist in Node - completeFocus's try/catch swallows it, no stub needed

function makeCtx (statePatch = {}) {
  const state = Object.assign({}, tomato.state, {
    status: 'startTomatoTime', startedAt: Date.now(),
    tomatoTime: 25, restTime: 5, enableNotification: false,
    attachTodo: { taskId: 't1', taskContent: '写周报' },
    tomatoRecordList: [], unSyncTomatoRecordList: [], todayTomatoCount: 0
  }, statePatch)
  const committed = []
  const dispatched = []
  const ctx = {
    state,
    rootState: { todo: { todoList: [{ taskId: 't1', estimate: 0 }] }, settings: {} },
    commit (m, p) {
      committed.push([m, p])
      tomato.mutations[m] && tomato.mutations[m](state, p)
    },
    dispatch (path, payload) {
      dispatched.push([path, payload])
      return Promise.resolve()
    }
  }
  return { ctx, state, committed, dispatched }
}

test('tomato: completeFocus dual-window concurrency books only one (CLAIM token + deterministic tomatoId)', async () => {
  globalThis.localStorage.removeItem('tomatoLastPhaseDone')
  const startedAt = Date.now()
  // Window A: completes first (advancing to the rest state)
  const a = makeCtx({ startedAt })
  await tomato.actions.completeFocus(a.ctx)
  assert.equal(a.state.tomatoRecordList.length, 1)
  assert.equal(a.state.tomatoRecordList[0].tomatoId, 'tmt_f_' + startedAt)
  assert.equal(a.state.todayTomatoCount, 1)
  assert.equal(a.state.status, 'startRestTime', 'enters rest after completion')
  // Window B: still holds the pre-completion old state (same startedAt); re-triggering in the same phase must be blocked by the token
  const b = makeCtx({ startedAt })
  await tomato.actions.completeFocus(b.ctx)
  assert.equal(b.state.tomatoRecordList.length, 0, 'the second window in the same phase is blocked by the CLAIM token')
  // A new phase (new startedAt) has a different token -> can book again
  globalThis.localStorage.removeItem('tomatoLastPhaseDone')
  const { ctx: ctx2, state: s2 } = makeCtx({ startedAt: Date.now() + 10 })
  await tomato.actions.completeFocus(ctx2)
  assert.equal(s2.tomatoRecordList.length, 1, 'a new focus phase is a new token and books normally')
})

test('tomato: addRecord dedups directly on the same tomatoId', () => {
  const state = { tomatoRecordList: [], unSyncTomatoRecordList: [] }
  tomato.mutations.addRecord(state, { tomatoId: 'x1', succeed: true })
  tomato.mutations.addRecord(state, { tomatoId: 'x1', succeed: true })
  assert.equal(state.tomatoRecordList.length, 1)
})

test('tomato: giveUp——暂停态已退役(_paused 全仓无置位点,2026-09-04 深审 P1-6 清理);idle 放弃不记账', () => {
  globalThis.localStorage.removeItem('tomatoLastPhaseDone')
  // 旧"暂停后放弃按已专注分钟记账"分支随 _paused 一起退役:status=default 时 giveUp 只重置,不产生记录
  const { ctx, state } = makeCtx({
    status: 'default', _wasResting: false,
    remainSec: 20 * 60, startedAt: 0
  })
  tomato.actions.giveUp(ctx, { record: true, reason: '临时有事' })
  assert.equal(state.tomatoRecordList.length, 0, '暂停态已不存在:idle giveUp 不记账')
  // idle state give up -> no booking
  globalThis.localStorage.removeItem('tomatoLastPhaseDone')
  const idle = makeCtx({ status: 'default', startedAt: 0 })
  tomato.actions.giveUp(idle.ctx, {})
  assert.equal(idle.state.tomatoRecordList.length, 0, 'nothing focused in the idle state to give up')
})

test('tomato: tick expiry flip goes through the shared decision (pure function already unit-tested; here the action wiring is verified)', async () => {
  const startedAt = Date.now() - 26 * 60000 // more than 25 minutes ago
  const { ctx, dispatched } = makeCtx({ startedAt })
  globalThis.localStorage.removeItem('tomatoLastPhaseDone')
  await tomato.actions.tick(ctx)
  assert.ok(dispatched.some(([p]) => p === 'completeFocus'), 'an expired focus triggers completeFocus')
  // Does not trigger before expiry
  const fresh = makeCtx({ startedAt: Date.now() })
  await tomato.actions.tick(fresh.ctx)
  assert.ok(!fresh.dispatched.some(([p]) => p === 'completeFocus'), 'does not trigger before expiry')
})

test('tomato: formatMMSS unified countdown copy (0/59/3600/negative boundaries)', async () => {
  const { formatMMSS } = await import('../renderer/js/utils/tomatoShared.js')
  assert.equal(formatMMSS(0), '00:00')
  assert.equal(formatMMSS(59), '00:59')
  assert.equal(formatMMSS(60), '01:00')
  assert.equal(formatMMSS(3600), '60:00', 'over 1 hour accumulates by minutes (historical pomodoro-bar convention)')
  assert.equal(formatMMSS(-5), '00:00', 'negatives clamp to 0, no minus sign')
  assert.equal(formatMMSS(undefined), '00:00')
})

test('tomato: remainSecOf click-instant time boundary (regression for the 25:01 flicker incident) - negative elapsed time must never gain a phantom extra second', async () => {
  const { remainSecOf } = await import('../renderer/js/utils/tomatoShared.js')
  const t0 = 1756344000000
  const TOTAL = 25 * 60
  // Exactly t=0: must be exactly the full 1500 seconds (25:00), not 1501
  assert.equal(remainSecOf('startTomatoTime', t0, 25, 5, t0), TOTAL)
  // The incident itself: now earlier than startedAt (display-layer tick timestamp lag) floored the negative fraction to -1 -> once flashed 25:01
  assert.equal(remainSecOf('startTomatoTime', t0, 25, 5, t0 - 1), TOTAL)
  assert.equal(remainSecOf('startTomatoTime', t0, 25, 5, t0 - 999), TOTAL)
  assert.equal(remainSecOf('startRestTime', t0, 25, 5, t0 - 500), 5 * 60, 'same-phase rest clamps to 0')
  // Within the first second: floor semantics kept (999ms still shows the full second; 1000ms decrements by 1)
  assert.equal(remainSecOf('startTomatoTime', t0, 25, 5, t0 + 999), TOTAL)
  assert.equal(remainSecOf('startTomatoTime', t0, 25, 5, t0 + 1000), TOTAL - 1)
  // Invariant sweep: for any millisecond offset within ±3s the remaining value never exceeds the total and never goes negative
  for (let off = -3000; off <= 3000; off++) {
    const r = remainSecOf('startTomatoTime', t0, 25, 5, t0 + off)
    assert.ok(r <= TOTAL && r >= 0, `offset=${off}ms out of range: ${r}`)
  }
})

test('tomato: formatMMSS(full seconds) must be 25:00 - the visible contract of the first frame after clicking start', async () => {
  const { formatMMSS } = await import('../renderer/js/utils/tomatoShared.js')
  assert.equal(formatMMSS(25 * 60), '25:00')
  assert.equal(formatMMSS(25 * 60 + 1), '25:01', 'over-total input is still displayed faithfully (defense lives elsewhere)')
})
