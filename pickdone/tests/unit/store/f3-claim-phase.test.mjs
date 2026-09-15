/**
 * F3[1] 回归:番茄完成认领去重改状态槽位标记(同相位永久拒绝),旧 1.5s 时间窗在浮窗被
 * Electron 后台节流、tick 晚到 >1.5s 时会把同一 startedAt 的 completeFocus 认领两次 →
 * saveSnowGain 积分双倍 + 双通知。
 * Run: node --test tests/unit/store/f3-claim-phase.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import tomato from '../../../renderer/js/store/tomato.js'

const CLAIM_KEY = 'tomatoLastPhaseDone'

function makeCtx (statePatch = {}) {
  const state = Object.assign({}, tomato.state, {
    status: 'startTomatoTime', startedAt: Date.now(),
    tomatoTime: 25, restTime: 5, enableNotification: false,
    attachTodo: null,
    tomatoRecordList: [], todayTomatoCount: 0
  }, statePatch)
  const dispatched = []
  const ctx = {
    state,
    rootState: { todo: { todoList: [] }, settings: {} },
    commit (m, p) { tomato.mutations[m] && tomato.mutations[m](state, p) },
    dispatch (path) { dispatched.push(path); return Promise.resolve() }
  }
  return { ctx, state, dispatched }
}

test('claim: 同相位认领标记是状态槽位——预置的陈旧认领(远超 1.5s)仍拒绝二次认领', async () => {
  globalThis.localStorage.removeItem(CLAIM_KEY)
  const startedAt = Date.now() - 60000 // 浮窗节流:tick 晚到 60s,远超旧 1.5s 窗
  // 模拟另一窗已在 >1.5s 前认领了同一相位(新格式即裸相位串)
  globalThis.localStorage.setItem(CLAIM_KEY, 'startTomatoTime:' + startedAt)
  const { ctx, state } = makeCtx({ startedAt })
  await tomato.actions.completeFocus(ctx)
  assert.equal(state.tomatoRecordList.length, 0, '同相位无论过多久都不能二次认领(旧时间窗代码此处会记 1 条)')
  assert.equal(state.todayTomatoCount, 0, '积分不入账(saveSnowGain 不触发)')
})

test('claim: 新相位正常认领;完成后同相位 giveUp 不产生第二条账目', async () => {
  globalThis.localStorage.removeItem(CLAIM_KEY)
  const startedAt = Date.now()
  const a = makeCtx({ startedAt })
  await tomato.actions.completeFocus(a.ctx)
  assert.equal(a.state.tomatoRecordList.length, 1)
  assert.equal(a.state.tomatoRecordList[0].tomatoId, 'tmt_f_' + startedAt)
  // 到点完成与用户点放弃同相位竞态:giveUp 的 claim 必须失败,且跟随他窗进入的休息态,不得追加放弃账
  const b = makeCtx({ startedAt }) // 模拟仍持有完成前瞬态的浮窗
  b.state.status = 'startTomatoTime'
  await tomato.actions.giveUp(b.ctx, { record: true, reason: '迟到 tick 的放弃' })
  const ids = b.state.tomatoRecordList.map(r => r.tomatoId)
  assert.ok(!ids.includes('tmt_a_' + startedAt), '同相位的 giveUp 不得再记放弃账(双保险:claim + 确定性 id)')
  // 新 startedAt = 新相位,可正常认领
  globalThis.localStorage.removeItem(CLAIM_KEY)
  const c = makeCtx({ startedAt: startedAt + 1000 })
  await tomato.actions.completeFocus(c.ctx)
  assert.equal(c.state.tomatoRecordList.length, 1, '新相位正常记账')
})
