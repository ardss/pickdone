/**
 * F3[5] 回归:habits persist 的整包 setMeta 属 MAIN_WINDOW_ONLY_OPS,辅助窗(浮窗/快捷窗)直写被
 * 主进程拒 → LS 已改、DB 永久副本永不更新。修法:辅助窗只写 LS + 中继 ping,由主窗 storage 监听
 * 代写 DB(与 dbMirror writeNow 同款辅助窗判定)。
 * 注:storage 跨窗事件语义无法在单进程 node:test 里端到端模拟(监听器在浏览器窗口注册),
 *     这里单测 persist 的分流逻辑;跨窗中联手工验证步骤见文件尾注释。
 * Run: node --test tests/unit/store/f3-habits-aux-persist.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { default: habitsStore, isAuxWindow } = await import('../../../renderer/js/store/habits.js')

function stubApi () {
  const calls = { setMeta: [] }
  globalThis.window.todoAPI = { dbCall: async (op, params) => { if (op === 'setMeta') calls.setMeta.push(params); return null } }
  return calls
}

test('habits persist: 主窗(hash 无辅助窗标记)直写 setMeta(原行为保留)', () => {
  globalThis.window.location = { hash: '#/' }
  const calls = stubApi()
  const s = habitsStore.state()
  habitsStore.mutations.addHabit(s, { name: '主窗习惯' })
  assert.equal(calls.setMeta.length, 1, '主窗直写 DB')
  assert.equal(calls.setMeta[0][0], 'habitsState')
  assert.equal(isAuxWindow(), false)
})

test('habits persist: 辅助窗不直写 setMeta,改写中继 ping 交主窗代写', () => {
  globalThis.window.location = { hash: '#/__tomato-float' }
  assert.equal(isAuxWindow(), true, 'dbMirror 同款判定:浮窗 hash')
  const calls = stubApi()
  globalThis.localStorage.removeItem('habitsSyncPing')
  const s = habitsStore.state()
  habitsStore.mutations.addHabit(s, { name: '浮窗习惯' })
  assert.equal(calls.setMeta.length, 0, '辅助窗 setMeta 不再被拒——根本不发')
  assert.ok(globalThis.localStorage.getItem('habitsSyncPing'), '发出中继 ping,主窗 storage 监听代写 DB')
  assert.ok(JSON.parse(globalThis.localStorage.getItem('habitsState')).habits.some(h => h.name === '浮窗习惯'), 'LS 照写(跨窗同步通道)')
  globalThis.window.location = { hash: '#/__quick-add' }
  assert.equal(isAuxWindow(), true, '快捷窗 hash 同样命中')
})

test('habits persist: 快捷窗同样不直写 setMeta', () => {
  globalThis.window.location = { hash: '#/__quick-add' }
  const calls = stubApi()
  const s = habitsStore.state()
  habitsStore.mutations.addHabit(s, { name: '快捷窗习惯' })
  assert.equal(calls.setMeta.length, 0)
})

/*
 * 跨窗中继手工验证步骤(单进程测试无法覆盖 storage 事件):
 *  1. 启动应用,打开番茄浮窗(辅助窗)。
 *  2. 在浮窗勾选/新增一个习惯。
 *  3. 主窗%APPDATA%数据库中 meta 表 habitsState 行应含该改动
 *     (修前:LS 已改但 meta 行不变,重启/清 LS 后勾选丢失)。
 *  4. 重启应用,浮窗里的勾选仍在(initFromDb 从 DB 恢复成功)。
 */
