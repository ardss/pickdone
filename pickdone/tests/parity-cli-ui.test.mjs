/** CLI ⇄ UI 数据对等门禁（data parity gate）——根治「功能先有 UI 后补 CLI/两边不是一本账」一类问题的结构性防线（2026-09-03 立门）。
 *
 *  背景：CLI 与 UI 共用 src/main/db.js 的 OPS + SQLite + meta 表（cli/lib.js:22 直接 require 同一文件）。
 *  本测试对每个数据域做**双向**回路断言：
 *    CLI 通道写入（cli/lib.js 高层命令）→ db.OPS 读回（= UI 的 dbCall 通道）必须可见且语义正确
 *    UI 通道写入（按 UI 的落库形态直写 OPS）→ CLI 命令读回必须可见且语义正确
 *  任何一域单向可见 = 门禁红。新增数据域时必须在本文件补一组回路。
 *
 *  全程 TODO_DB_DIR 隔离临时库，不碰真实数据。跑法: node tests/parity-cli-ui.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-cli-ui-'))
const require_ = createRequire(import.meta.url)
const db = require_('../src/main/db.js')
const lib = require_('../cli/lib.js')
db.init(process.env.TODO_DB_DIR)

const dayjs = require_('dayjs')
const today0 = () => +dayjs().startOf('day')

test('域:任务 — CLI add 落库后 UI(OPS)可见,dayStart 派生正确', () => {
  const t = lib.addTodo({ content: '对等·任务A', date: 'today' })
  const row = db.call('getById', t.taskId)
  assert.equal(row.taskContent, '对等·任务A')
  assert.equal(row.dayStart, today0(), 'add --date today 必须 dayStart=今日0点(而非落待办箱)')
  assert.equal(row.delete, false)
})

test('域:任务 — UI(upsert)写入后 CLI list 可见', () => {
  const now = Date.now()
  const t = {
    complete: false, createTime: now, delete: false, reminderTime: 0, reminderOffsets: [], estimate: 0,
    difficulty: 0, repeatId: null, subtasks: null, image: null, files: null,
    categoryId: 9101, updateTime: now, syncTime: 0, taskContent: '对等·任务B(UI写)',
    taskSort: 512, todoTime: today0(), userId: 1, status: 'add', version: 0,
    taskId: require_('../src/main/core/todo-core.js').genTaskId(1, now)
  }
  db.call('upsert', t)
  const seen = lib.listTodos({ all: true }).find(x => x.taskId === t.taskId)
  assert.ok(seen, 'CLI listTodos 必须看到 UI 直写的任务')
  assert.equal(seen.taskContent, '对等·任务B(UI写)')
})

test('域:完成态 — CLI toggleComplete 落 completedAt,UI 通道可见', () => {
  const [t] = lib.listTodos({ all: true }).filter(x => x.taskContent === '对等·任务A')
  lib.toggleComplete(String(t.taskId), true)
  const row = db.call('getById', t.taskId)
  assert.equal(row.complete, true)
  assert.ok(row.completedAt > 0, '完成必须带 completedAt(已达成页分组依赖)')
})

test('域:分类 — CLI addCategory 与 UI(upsertCategory)互相可见', () => {
  lib.addCategory('对等分类', {})
  const cats = db.call('getAllCategories')
  assert.ok(cats.some(c => c.categoryName === '对等分类'), 'CLI 建的分类 UI 通道可见')
  db.call('upsertCategory', { id: 9877, userId: 1, name: '同级对等乙', color: '#0f9d8f', createdAt: Date.now(), sort: 9877, isFolder: 0, parentId: 0, deleted: 0 })
  assert.equal(lib.resolveCategory('同级对等乙'), 9877, 'UI 建的分类 CLI 可解析')
})

test('域:项目标识 — CLI setProjectFlag 与 UI 通道(setMeta projectCategoryIds)同账', () => {
  lib.setProjectFlag('对等分类', true)
  const ids = JSON.parse(db.call('getMeta', 'projectCategoryIds') || '[]')
  const catId = lib.resolveCategory('对等分类')
  assert.ok(ids.includes(catId), 'CLI 打的项目标必须落在共享 meta 键上')
  // UI 通道: 直接 setMeta(等价 category/setProject 的持久化形态);9877=上一测试经 UI 通道建的真分类
  const ids2 = [...ids, 9877]
  db.call('setMeta', ['projectCategoryIds', JSON.stringify(ids2)])
  assert.ok(lib.getProjects().some(p => p.categoryId === 9877), 'UI 打的项目标 CLI getProjects 必须可见')
})

test('域:项目截止/里程碑 — CLI 写入 meta 后 UI 同键可读', () => {
  lib.setProjectFlag('同级对等乙', true)
  lib.setProjectDeadline('同级对等乙', '2026-12-31')
  const catId = lib.resolveCategory('同级对等乙')
  assert.equal(Number(db.call('getMeta', 'projectDeadline:' + catId)), +dayjs('2026-12-31').startOf('day'))
  lib.addMilestone('同级对等乙', '对等里程碑', '2026-12-25')
  const ms = JSON.parse(db.call('getMeta', 'projectMilestones:' + catId) || '[]')
  assert.equal(ms.length, 1)
  assert.equal(ms[0].title, '对等里程碑')
})

test('域:重复规则 — CLI repeatOn 落 meta repeatRule:<rid>,UI 同键可读', () => {
  const [t] = lib.listTodos({ all: true }).filter(x => x.taskContent === '对等·任务B(UI写)')
  const rule = lib.buildRepeatRule({ type: 'daily', interval: 1 })
  lib.repeatOn(String(t.taskId), rule, null)
  const row = db.call('getById', t.taskId)
  const rid = row.repeatId
  assert.ok(rid, '开启重复必须写 repeatId')
  const stored = JSON.parse(db.call('getMeta', 'repeatRule:' + rid) || 'null')
  assert.ok(stored && stored.repeatType === 'day', 'repeatRule meta 必须可被 UI 解析(UI 依赖此键续期)')
})

test('域:时间轴排程 — CLI planSet 落 plan_chips 行存储,UI(DayRail)同库', () => {
  const [t] = lib.listTodos({ all: true }).filter(x => x.taskContent === '对等·任务A')
  const r = lib.planSet(String(t.taskId), '09:30', {})
  const rows = db.call('planAll', []).filter(x => x.day === r.day && x.taskId === t.taskId)
  assert.ok(rows.length, '排程芯片必须落 plan_chips 行存储(UI DayRail 同库读写)')
  assert.deepEqual(rows.map(e => e.mm).sort(), ['09:30'])
  const gone = db.call('getMeta', 'dayPlanState')
  assert.equal(gone, null, '旧 meta dayPlanState 必须已迁移移除(v3)')
})

test('域:时间轴排程 — planSet --replace 返回值=落库实态(审计不失真)', () => {
  const t = lib.addTodo({ content: '对等·replace任务', date: 'today' })
  const tid = String(t.taskId)
  lib.planSet(tid, '09:00', {})
  lib.planSet(tid, '10:00', {})
  const r = lib.planSet(tid, '14:00', { replace: true })
  assert.deepEqual(r.chips, ['14:00'], 'replace 后返回值必须等于落库实态')
  const rows = db.call('planAll', []).filter(x => x.taskId === tid)
  assert.deepEqual(rows.map(x => x.mm), ['14:00'])
})

test('域:时间轴排程 — planSet 同刻重复抛 PLAN_EXISTS 且不产生第二行', () => {
  const t = lib.addTodo({ content: '对等·exists任务', date: 'today' })
  const tid = String(t.taskId)
  lib.planSet(tid, '09:00', {})
  const before = db.call('planAll', []).length
  assert.throws(() => lib.planSet(tid, '09:00', {}), e => e.code === 'PLAN_EXISTS')
  assert.equal(db.call('planAll', []).length, before, '重复排不产生第二行')
})

test('域:时间轴排程 — UI 通道 planAddMany 写入后 CLI planList 可见(双向回路)', () => {
  const t = lib.addTodo({ content: '对等·UI通道任务', date: 'today' })
  const tid = String(t.taskId)
  const day = dayjs().format('YYYY-MM-DD')
  db.call('planAddMany', [{ taskId: tid, day, mm: '08:15' }]) // UI 的 dbCall 通道同款写入
  const r = lib.planList(day)
  const row = r.tasks.find(x => x.taskId === tid)
  assert.ok(row, 'UI 写入对 CLI planList 可见')
  assert.deepEqual(row.chips, ['08:15'])
})

test('域:时间轴排程 — 删除任务快照芯片,恢复回灌(CLI 与 UI 同语义)', () => {
  const t = lib.addTodo({ content: '对等·快照任务', date: 'today' })
  const tid = String(t.taskId)
  lib.planSet(tid, '09:00', {})
  lib.deleteTodo(tid)
  assert.equal(db.call('planAll', []).filter(x => x.taskId === tid).length, 0, '删除后芯片清行(防孤儿)')
  assert.ok(db.call('getMeta', 'planChipsSnapshot:' + tid), '快照保留在 meta')
  lib.restoreTodo(tid)
  const rows = db.call('planAll', []).filter(x => x.taskId === tid)
  assert.deepEqual(rows.map(x => x.mm), ['09:00'], '恢复后回灌快照芯片')
})

test('域:设置 — CLI settingsSet 落 meta db.settingsState(UI 镜像同键)', () => {
  const rows = lib.settingsList()
  const key = rows.find(r => r.type === 'boolean' && !r.protected)
  assert.ok(key, '设置域至少应有一个可写布尔键')
  lib.settingsSet(key.key, true)
  const doc = JSON.parse(db.call('getMeta', 'db.settingsState') || '{}')
  assert.equal(doc[key.key], true, 'CLI 改的设置必须落在 UI 可见的共享镜像键')
})

test('域:工作量 — CLI setEstimate 写共享 meta,UI initFromDb 同账', () => {
  const [t] = lib.listTodos({ all: true }).filter(x => x.taskContent === '对等·任务A')
  lib.setEstimate(String(t.taskId), 3)
  const map = JSON.parse(db.call('getMeta', 'tomatoEstimateState') || '{}')
  assert.equal(map[t.taskId], 3, '预计番茄必须落在渲染端 tomatoEstimate/initFromDb 同款 meta 键')
  assert.ok(Number(db.call('getMeta', 'tomatoEstimateStateAt')) > 0, '必须带时间戳(渲染端谁新用谁的判据)')
})
