/**
 * F3[4] 回归:completeFocus 记账前用廉价读 op getById(任意窗可调、含已删行)向主进程核验任务
 * 存在性。旧路径只查本窗内存 todoList 池,跨窗删除未同步时账目带 focusTaskId,而 db 层 bumpSnow
 * 的 `AND deleted=0` changes=0 → 专注积分静默丢失。
 * Run: node --test tests/unit/store/f3-focus-task-verify.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import tomato from '../../../renderer/js/store/tomato.js'

const CLAIM_KEY = 'tomatoLastPhaseDone'
const LS_KEY = 'tomatoState'

function makeCtx (getByIdResult, statePatch = {}) {
  const calls = { getById: [], bumpSnow: [] }
  globalThis.window.todoAPI = {
    dbCall: async (op, params) => {
      if (op === 'getById') { calls.getById.push(params); return typeof getByIdResult === 'function' ? getByIdResult(params) : getByIdResult }
      if (op === 'bumpSnow') { calls.bumpSnow.push(params); return true }
      return null
    },
    notification: () => {}
  }
  const state = Object.assign({}, tomato.state, {
    status: 'startTomatoTime', startedAt: Date.now() - 25 * 60000, // 25 分钟前起跑:完整时长入账
    tomatoTime: 25, restTime: 5, enableNotification: false,
    attachTodo: { taskId: 't1', taskContent: '写周报' },
    tomatoRecordList: [], todayTomatoCount: 0
  }, statePatch)
  // G1 (R2-4): completeFocus re-verifies the shared LS transient after the getById await window
  // (give-up race). Production keeps LS in sync with the running focus via persistState — seed it
  // here so the re-verification sees the live phase instead of an empty LS (= default).
  globalThis.localStorage.setItem(LS_KEY, JSON.stringify({ schemaV: 1, status: 'startTomatoTime', startedAt: state.startedAt, tomatoTime: 25, restTime: 5 }))
  const ctx = {
    state,
    rootState: { todo: { todoList: [{ taskId: 't1', taskContent: '写周报' }] }, settings: {} },
    commit (m, p) { tomato.mutations[m] && tomato.mutations[m](state, p) },
    dispatch () { return Promise.resolve() }
  }
  // focusTodoPool(this):生产里 Vuex dispatch 把 this 绑到 store(rootState 在 this 上);测试用 .call 同构绑定
  const storeLike = { state: { todo: ctx.rootState.todo }, rootState: ctx.rootState }
  const run = () => tomato.actions.completeFocus.call(storeLike, ctx)
  return { ctx, state, calls, run }
}

test('completeFocus: 任务已在他窗删除(getById 报 deleted)→ 按 free focus 记账,不发 bumpSnow', async () => {
  globalThis.localStorage.removeItem(CLAIM_KEY)
  const { state, calls, run } = makeCtx({ taskId: 't1', delete: true })
  await run()
  assert.deepEqual(calls.getById, ['t1'], '记账前向主进程核验了任务存在性')
  assert.equal(calls.bumpSnow.length, 0, '死任务不发 bumpSnow(旧路径 changes=0 静默丢积分)')
  assert.equal(state.tomatoRecordList.length, 1)
  assert.equal(state.tomatoRecordList[0].focusTaskId, null, '账目不带死任务链接')
  assert.equal(state.tomatoRecordList[0].focusDuration, 25, '专注时长照常入账')
})

test('completeFocus: 任务存活 → 保留链接并正常 bumpSnow(原行为保留)', async () => {
  globalThis.localStorage.removeItem(CLAIM_KEY)
  const { state, calls, run } = makeCtx({ taskId: 't1', delete: false })
  await run()
  assert.equal(calls.bumpSnow.length, 1)
  assert.deepEqual(calls.bumpSnow[0], { taskId: 't1', minutes: 25 })
  assert.equal(state.tomatoRecordList[0].focusTaskId, 't1')
})

test('completeFocus: getById 通道失败 → 保持本窗判定,不因 IPC 故障丢记账', async () => {
  globalThis.localStorage.removeItem(CLAIM_KEY)
  const { state, calls, run } = makeCtx(() => { throw new Error('ipc down') })
  await run()
  assert.equal(state.tomatoRecordList[0].focusTaskId, 't1', '核验失败按本窗池判定记账')
  assert.equal(calls.bumpSnow.length, 1, 'bumpSnow 照发')
})
