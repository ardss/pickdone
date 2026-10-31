/**
 * W24 P2 — 休息结算跨窗 fallback 只扫 ±2000ms 的回归。
 *
 * 根因:completeFocus 的 await 链把 rest startedAt 推迟 >2s,窗口 A 关闭后浮窗 B 结算时
 * resolvePendingRestRow 的 _lastBookedFocus(随窗消亡)+ ±2000ms 时间窗都落空 → 行的
 * restDuration 停在计划值。
 *
 * 修法:_pendingRestRowId 随相位写进 LS 相位 blob(completeFocus 的 startRestTime patch),
 * 结算窗优先按 tomatoId 精确命中,时间窗只做旧 blob 兜底。
 *
 * Run: node --test tests/unit/store/w24-rest-settle-cross-window.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
let seq = 0
// fresh module instance per scenario (tomato.js carries the module-level _lastBookedFocus pointer)
const importTomato = () => import(pathToFileURL(path.join(ROOT, 'renderer/js/store/tomato.js')).href + '?w24rest=' + (++seq))

const LS_KEY = 'tomatoState'
const CLAIM_KEY = 'tomatoLastPhaseDone'

function seedShared (blob) {
  globalThis.localStorage.setItem(LS_KEY, JSON.stringify(Object.assign({ schemaV: 1 }, blob)))
}

function makeCtx (tomato, statePatch = {}) {
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

/** The booked focus row's endTime sits restStartedAt + 5s — OUTSIDE the ±2000ms scan window,
 *  i.e. exactly the gap the old fallback could not bridge. */
function scenario () {
  const restStartedAt = Date.now() - 120000 // rest ran ~2 minutes → measured settle = 2
  const focusId = 'tmt_f_' + (restStartedAt - 60000) // plain-node mints are unsalted; deterministic
  return { restStartedAt, focusId, row: {
    tomatoId: focusId, endTime: restStartedAt + 5000, dateKey: '2026-10-31',
    focus: '', focusTaskId: null, focusDuration: 25, rest: 5, restDuration: 5, succeed: true, status: 'local'
  } }
}

test('w24: 结算窗带 blob 相位 id(_pendingRestRowId)时,5s 落差的行按 id 精确命中并结算', async () => {
  globalThis.localStorage.removeItem(CLAIM_KEY)
  const tomato = (await importTomato()).default
  const { restStartedAt, focusId, row } = scenario()
  // The phase blob as the CLOSED window A left it: rest phase + the booked row's id.
  seedShared({ status: 'startRestTime', startedAt: restStartedAt, tomatoTime: 25, restTime: 5, remainSec: 180, _pendingRestRowId: focusId })
  // The settling window's Vuex state as syncFromStorage left it: the blob's id applied (LOCAL_KEYS
  // don't cover it) plus the ledger copy reloaded from the DB broadcast.
  const { ctx, state } = makeCtx(tomato, { status: 'startRestTime', startedAt: restStartedAt, _pendingRestRowId: focusId, tomatoRecordList: [row] })
  await tomato.actions.finishRest(ctx)
  assert.equal(state.status, 'default', 'the rest phase finishes normally')
  assert.equal(state.tomatoRecordList[0].restDuration, 2, 'restDuration settled to the MEASURED value (was stuck at the planned 5)')
  assert.equal(state._pendingRestRowId, null, 'the pending id is consumed after the settle')
})

test('w24: 无 id(旧 blob)且 5s 落差时保持旧行为 — 时间窗兜底落空,不误结算', async () => {
  globalThis.localStorage.removeItem(CLAIM_KEY)
  const tomato = (await importTomato()).default
  const { restStartedAt, row } = scenario()
  seedShared({ status: 'startRestTime', startedAt: restStartedAt, tomatoTime: 25, restTime: 5, remainSec: 180 })
  const { ctx, state } = makeCtx(tomato, { status: 'startRestTime', startedAt: restStartedAt, tomatoRecordList: [row] })
  await tomato.actions.finishRest(ctx)
  assert.equal(state.status, 'default')
  assert.equal(state.tomatoRecordList[0].restDuration, 5, 'no id + outside the ±2000ms window → not settled (the documented old-blob gap)')
})

test('w24: completeFocus 把 tomatoId 写进 LS 相位 blob(跨窗携带的证据)', async () => {
  globalThis.localStorage.removeItem(CLAIM_KEY)
  const tomato = (await importTomato()).default
  const startedAt = Date.now() - 10 * 60000
  seedShared({ status: 'startTomatoTime', startedAt, tomatoTime: 25, restTime: 5 })
  const { ctx, state } = makeCtx(tomato, { status: 'startTomatoTime', startedAt })
  await tomato.actions.completeFocus(ctx)
  const focusRow = state.tomatoRecordList.find(r => r && r.succeed === true)
  assert.ok(focusRow, 'the focus was booked')
  const blob = JSON.parse(globalThis.localStorage.getItem(LS_KEY))
  assert.equal(blob._pendingRestRowId, focusRow.tomatoId, 'the phase blob carries the booked row\'s tomatoId')
  assert.equal(blob.status, 'startRestTime')
})
