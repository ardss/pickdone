/** plan_chips 行存储单元测试(2026-09-03 根修配套) — 直连 db 层,不拉起 Electron
 *  覆盖:原子 op 语义/字段校验/迁移 v3 幂等与容错/INSERT OR REPLACE id 冲突语义/prune
 *  运行:被 tests/run-all.mjs 自动发现(check:all 门禁项) */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dbm = require('../src/main/db.js')

function freshDb () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pd-plan-'))
  fs.writeFileSync(path.join(dir, 'todos.db'), '')
  dbm.init(dir)
  return dir
}

test('域:排程芯片 — planAddMany 校验与原子写入', () => {
  const dir = freshDb()
  try {
    assert.throws(() => dbm.call('planAddMany', [{ taskId: '', day: '2026-09-04', mm: '12:00' }]), 'taskId 必填')
    assert.throws(() => dbm.call('planAddMany', [{ taskId: 't1', day: '20260904', mm: '12:00' }]), 'day 必须 YYYY-MM-DD')
    assert.throws(() => dbm.call('planAddMany', [{ taskId: 't1', day: '2026-09-04', mm: '24:00' }]), 'mm 必须 HH:mm')
    const ids = dbm.call('planAddMany', [
      { taskId: 't1', day: '2026-09-04', mm: '12:00' },
      { taskId: 't2', day: '2026-09-04', mm: '09:30' }
    ])
    assert.equal(ids.length, 2, '每个芯片返回一个 id')
    const rows = dbm.call('planAll', [])
    assert.equal(rows.length, 2)
    assert.deepEqual(rows.map(r => r.mm), ['09:30', '12:00'], 'planAll 按 day,mm 排序')
  } finally { dbm.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('域:排程芯片 — planUpdateChip 移动单枚(id 不变)与不存在 id', () => {
  const dir = freshDb()
  try {
    const [id] = dbm.call('planAddMany', [{ taskId: 't1', day: '2026-09-04', mm: '08:00' }])
    assert.equal(dbm.call('planUpdateChip', { id, day: '2026-09-05', mm: '10:00' }), true, '移动成功')
    const rows = dbm.call('planAll', [])
    assert.equal(rows[0].day, '2026-09-05')
    assert.equal(rows[0].id, id, 'id 不变(拖拽锚定依赖)')
    assert.equal(dbm.call('planUpdateChip', { id: 'pl_nope', day: '2026-09-05', mm: '10:00' }), false, '不存在的 id 返回 false')
  } finally { dbm.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('域:排程芯片 — planMoveTask 整任务迁移(改期语义)', () => {
  const dir = freshDb()
  try {
    dbm.call('planAddMany', [
      { taskId: 't1', day: '2026-09-04', mm: '09:00' },
      { taskId: 't1', day: '2026-09-04', mm: '10:00' },
      { taskId: 't2', day: '2026-09-04', mm: '11:00' }
    ])
    const n = dbm.call('planMoveTask', { taskId: 't1', fromDay: '2026-09-04', toDay: '2026-09-06' })
    assert.equal(n, 2, '迁移该任务该日的全部芯片')
    const days = dbm.call('planAll', []).filter(r => r.taskId === 't1').map(r => r.day)
    assert.deepEqual([...new Set(days)], ['2026-09-06'])
    assert.equal(dbm.call('planMoveTask', { taskId: 'tX', fromDay: '2026-09-04', toDay: '2026-09-06' }), 0, '无芯片任务迁移 0 行')
  } finally { dbm.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('域:排程芯片 — planDeleteTask/planDeleteTaskDay/planRemoveIds', () => {
  const dir = freshDb()
  try {
    const [id1] = dbm.call('planAddMany', [{ taskId: 't1', day: '2026-09-04', mm: '09:00' }])
    dbm.call('planAddMany', [{ taskId: 't1', day: '2026-09-05', mm: '10:00' }])
    dbm.call('planRemoveIds', [id1])
    assert.equal(dbm.call('planAll', []).filter(r => r.day === '2026-09-04').length, 0, '按 id 删除')
    dbm.call('planDeleteTaskDay', { taskId: 't1', day: '2026-09-05' })
    assert.equal(dbm.call('planAll', []).filter(r => r.taskId === 't1').length, 0, '按任务+日删除')
    dbm.call('planAddMany', [{ taskId: 't2', day: '2026-09-04', mm: '09:00' }])
    dbm.call('planDeleteTask', 't2')
    assert.equal(dbm.call('planAll', []).length, 0, '按任务全清(删除任务/移除日期语义)')
  } finally { dbm.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('域:排程芯片 — planPrune 只清窗口外日桶', () => {
  const dir = freshDb()
  try {
    dbm.call('planAddMany', [
      { taskId: 't1', day: '2025-01-01', mm: '09:00' },
      { taskId: 't1', day: '2026-09-04', mm: '09:00' }
    ])
    const n = dbm.call('planPrune', { keepDays: ['2026-09-04'] })
    assert.equal(n, 1)
    assert.equal(dbm.call('planAll', []).length, 1)
    assert.equal(dbm.call('planPrune', { keepDays: [] }), 0, '空 keep 拒绝(防误清全表)')
  } finally { dbm.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('域:排程芯片 — INSERT OR REPLACE 同 id 覆盖语义(显式文档化)', () => {
  const dir = freshDb()
  try {
    dbm.call('planAddMany', [{ id: 'pl_fixed', taskId: 't1', day: '2026-09-04', mm: '09:00' }])
    dbm.call('planAddMany', [{ id: 'pl_fixed', taskId: 't1', day: '2026-09-04', mm: '11:00' }])
    const rows = dbm.call('planAll', [])
    assert.equal(rows.length, 1, '同 id 是更新不是新增')
    assert.equal(rows[0].mm, '11:00')
  } finally { dbm.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('域:排程芯片 — 迁移 v3:meta JSON 入行存储+备份+幂等', () => {
  const dir = freshDb()
  try {
    // 模拟老库:回退 schemaVersion,塞入旧格式 dayPlanState,重开连接触发迁移
    dbm.call('setMeta', ['schemaVersion', '2'])
    dbm.call('setMeta', ['dayPlanState', JSON.stringify({
      _savedAt: 1,
      '2026-09-04': { t1: [{ mm: '12:00', id: 'pl_old1' }] },
      'garbage-key': { tX: [{ mm: '99:99' }] },
      '2026-09-05': { t2: [{ mm: '25:99' }, { mm: '08:00' }] }
    })])
    dbm.close()
    dbm.init(dir)
    const rows = dbm.call('planAll', [])
    assert.equal(rows.length, 2, '合法芯片导入(畸形日键/畸形 mm 丢弃)')
    assert.ok(rows.some(r => r.id === 'pl_old1' && r.day === '2026-09-04'), '老 id 保留')
    assert.equal(dbm.call('getMeta', 'dayPlanState'), null, '旧键移除')
    assert.ok(dbm.call('getMeta', 'dayPlanState.bak'), '备份键保留')
    assert.equal(dbm.call('getMeta', 'schemaVersion'), '3', '迁移版本推进')
    // 幂等:再次重开不重复导入
    dbm.close()
    dbm.init(dir)
    assert.equal(dbm.call('planAll', []).length, 2, '重开不重复导入')
  } finally { dbm.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})

test('域:排程芯片 — 迁移 v3 对损坏 JSON 容错(保留原键不推进数据丢失)', () => {
  const dir = freshDb()
  try {
    dbm.call('setMeta', ['schemaVersion', '2'])
    dbm.call('setMeta', ['dayPlanState', '{broken json'])
    dbm.close()
    dbm.init(dir) // 迁移体内 catch:保留原键,不得崩溃
    assert.equal(dbm.call('planAll', []).length, 0)
    assert.ok(dbm.call('getMeta', 'dayPlanState'), '损坏 JSON 原键保留(未迁移成功不删源)')
  } finally { dbm.close(); fs.rmSync(dir, { recursive: true, force: true }) }
})
