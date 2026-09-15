/**
 * F3[3] 回归:giveUp 的陈旧副本重读此前只覆盖 fresh 为 startTomatoTime 的分支;他窗已完成专注
 * 进入 startRestTime 时,本窗(default 陈旧副本)giveUp 会盲写 default 杀掉刚开的休息。
 * Run: node --test tests/unit/store/f3-giveup-rest.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import tomato from '../../../renderer/js/store/tomato.js'

const LS_KEY = 'tomatoState'
const CLAIM_KEY = 'tomatoLastPhaseDone'

function seedShared (blob) {
  globalThis.localStorage.setItem(LS_KEY, JSON.stringify(Object.assign({ schemaV: 1 }, blob)))
}

function makeCtx (statePatch = {}) {
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

test('giveUp: 本窗陈旧 default、他窗已进入休息时,跟随共享休息态而不是杀掉它', () => {
  globalThis.localStorage.removeItem(CLAIM_KEY)
  const restStartedAt = Date.now() - 30000 // 休息进行中(5 分钟休息刚开 30s)
  seedShared({ status: 'startRestTime', startedAt: restStartedAt, tomatoTime: 25, restTime: 5, remainSec: 270 })
  const { ctx, state } = makeCtx() // 本窗副本还是 default(storage 事件未达)
  tomato.actions.giveUp(ctx, { record: true, reason: '想取消专注' })
  assert.equal(state.status, 'startRestTime', '刚开的休息不被盲写 default 杀掉')
  assert.equal(state.startedAt, restStartedAt, '跟随共享 startedAt')
  assert.equal(state.tomatoRecordList.length, 0, '休息期 giveUp 不产生任何账目')
})

test('giveUp: 本窗陈旧 default、他窗专注进行中时,原 startTomatoTime 分支行为保留(记放弃账)', () => {
  globalThis.localStorage.removeItem(CLAIM_KEY)
  const startedAt = Date.now() - 10 * 60000
  seedShared({ status: 'startTomatoTime', startedAt, tomatoTime: 25, restTime: 5 })
  const { ctx, state } = makeCtx()
  tomato.actions.giveUp(ctx, { record: true, reason: '测试' })
  assert.equal(state.tomatoRecordList.length, 1)
  assert.equal(state.tomatoRecordList[0].tomatoId, 'tmt_a_' + startedAt)
  assert.equal(state.tomatoRecordList[0].succeed, false)
  assert.equal(state.status, 'default')
})
