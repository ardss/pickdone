/** CLI v0.2 features — saved views (dual-end with the App's smart lists) + explicit project status + lunar annotation.
 *  Isolated temp DB via TODO_DB_DIR, never touches real data.
 *  Covers: view add/list/rm round-trip through filterList (the App's read channel) / conds shape parity with the
 *  renderer contract (db.js normConds: {catId, priority, dateMode}, -1/'all' = off) / list --view filtering semantics
 *  (mirrors renderer FilterView.list: undone only) / project --status set/none + projects status field/filter /
 *  deterministic --lunar output against a fixed date.
 *  Run: node --test tests/unit-cli-v02-views-status.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-v02-views-'))
const require_ = createRequire(import.meta.url)
const db = require_('../src/main/db.js')
const lib = require_('../cli/lib.js')
const core = require_('../src/main/core/todo-core.js')
const dayjs = require_('dayjs')

db.init(process.env.TODO_DB_DIR)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const runCli = args => JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'cli', 'pickdone.js'), ...args], { encoding: 'utf8' }))
const runCliRaw = args => execFileSync(process.execPath, [path.join(ROOT, 'cli', 'pickdone.js'), ...args], { encoding: 'utf8' })

const today0 = () => +dayjs().startOf('day')
let _seq = 0
function seed (over = {}) {
  const now = Date.now() + (_seq++)
  const t = {
    complete: false, createTime: now, delete: false,
    reminderTime: 0, reminderOffsets: [], estimate: 0, difficulty: 0,
    repeatId: null, subtasks: null, image: null, files: null,
    categoryId: 0, updateTime: now, syncTime: 0,
    taskContent: '任务', taskDescribe: '',
    taskSort: 0, todoTime: 0, userId: 1, status: 'add', version: 0, ...over
  }
  if (!t.taskId) t.taskId = core.genTaskId(1, now)
  db.call('upsert', t)
  return db.call('getById', t.taskId)
}

/* ---------------- saved views ---------------- */
test('view add round-trips through filterList (the App read channel) with the exact renderer conds shape', () => {
  const cat = lib.addCategory('视图分类甲v2')
  const v = lib.viewAdd('紧急工作v2', { category: '视图分类甲v2', priority: '2', overdue: true })
  assert.ok(v.id > 0)
  // The row the App's filters store loads must carry exactly the normConds shape: keys {catId, priority, dateMode}
  const row = db.call('filterList').find(f => f.name === '紧急工作v2')
  assert.ok(row, 'CLI-created view must be visible on the UI read channel (filterList)')
  assert.deepEqual(Object.keys(row.conds).sort(), ['catId', 'dateMode', 'priority'], 'conds shape parity: exactly the three renderer fields')
  assert.equal(row.conds.catId, cat.categoryId, 'name resolved to the real categoryId (the App renders it as the category chip)')
  assert.equal(row.conds.priority, 2)
  assert.equal(row.conds.dateMode, 'overdue')
  // ...and through the CLI read path
  assert.deepEqual(lib.resolveView('紧急工作v2').conds, row.conds)
})

test('view add defaults + nodate/overdue conflict + duplicate name + bad priority', () => {
  const v = lib.viewAdd('默认全量v2', {})
  assert.deepEqual(v.conds, { catId: -1, priority: -1, dateMode: 'all' }, 'absent flags = condition off, renderer baseline shape')
  const nodate = lib.viewAdd('收件箱视图v2', { nodate: true })
  assert.equal(nodate.conds.dateMode, 'none', '--nodate maps to the renderer none date mode')
  assert.throws(() => lib.viewAdd('冲突视图v2', { overdue: true, nodate: true }), e => e.code === 'USAGE')
  assert.throws(() => lib.viewAdd('紧急工作v2', {}), e => e.code === 'VIEW_EXISTS', 'duplicate names are rejected')
  assert.throws(() => lib.viewAdd('坏优先级v2', { priority: '9' }), e => e.code === 'USAGE')
  assert.throws(() => lib.viewAdd('坏优先级v2', { priority: '高' }), e => e.code === 'USAGE')
  assert.throws(() => lib.viewAdd('坏分类v2', { category: '不存在的分类XYZ' }), e => e.code === 'CATEGORY_NOT_FOUND')
  assert.throws(() => lib.viewAdd('  ', {}), e => e.code === 'USAGE')
})

test('UI-channel filter (FilterModal write shape) is consumed by the CLI read/apply path', () => {
  // Exactly what renderer FilterModal.save dispatches: {name, conds:{catId, priority, dateMode}, sort}
  const cat = lib.addCategory('视图分类乙v2')
  const id = db.call('filterUpsert', { name: 'UI侧视图v2', conds: { catId: cat.categoryId, priority: -1, dateMode: 'week' }, sort: 0 })
  const v = lib.resolveView(id)
  assert.equal(v.name, 'UI侧视图v2')
  assert.deepEqual(v.conds, { catId: cat.categoryId, priority: -1, dateMode: 'week' })
})

test('applyViewConds mirrors renderer FilterView.list: undone only, cat/priority equality, date windows', () => {
  const cat = lib.addCategory('过滤分类v2')
  const overdue = seed({ taskContent: '过滤逾期v2', categoryId: cat.categoryId, priority: 2, todoTime: +dayjs().subtract(3, 'day') })
  const today = seed({ taskContent: '过滤今日v2', categoryId: cat.categoryId, priority: 2, todoTime: today0() })
  const otherDay = seed({ taskContent: '过滤未来v2', categoryId: cat.categoryId, priority: 1, todoTime: +dayjs().add(30, 'day') })
  const doneOverdue = seed({ taskContent: '过滤已完成v2', categoryId: cat.categoryId, priority: 2, todoTime: +dayjs().subtract(3, 'day'), complete: true, completedAt: Date.now() })
  const noDate = seed({ taskContent: '过滤无日期v2', priority: 2 })
  const v = lib.viewAdd('逾期视图v2', { category: '过滤分类v2', priority: '2', overdue: true })
  const got = lib.applyViewConds(v.conds, lib.liveTasks())
  const ids = got.map(t => t.taskId)
  assert.ok(ids.includes(overdue.taskId))
  assert.ok(!ids.includes(today.taskId) && !ids.includes(otherDay.taskId), 'date window is applied')
  assert.ok(!ids.includes(doneOverdue.taskId), 'FilterView hides completed tasks — CLI must match')
  assert.ok(!ids.includes(noDate.taskId), 'no-date task is not overdue')
  // none mode: inbox only
  const inbox = lib.applyViewConds({ catId: -1, priority: -1, dateMode: 'none' }, lib.liveTasks())
  assert.ok(inbox.some(t => t.taskId === noDate.taskId))
  assert.ok(inbox.every(t => !t.dayStart))
  // priority filter only
  const prio = lib.applyViewConds({ catId: -1, priority: 2, dateMode: 'all' }, lib.liveTasks())
  assert.ok(prio.every(t => (t.priority || 0) === 2))
})

test('view rm by name and by id; unknown view errors', () => {
  const v = lib.viewAdd('待删视图v2', {})
  const removed = lib.viewRm('待删视图v2')
  assert.equal(removed.id, v.id)
  assert.ok(!db.call('filterList').some(f => f.id === v.id), 'row gone from the shared filters table')
  assert.throws(() => lib.viewRm('待删视图v2'), e => e.code === 'VIEW_NOT_FOUND')
  const v2 = lib.viewAdd('按id删v2', {})
  assert.equal(lib.viewRm(String(v2.id)).id, v2.id)
  assert.throws(() => lib.resolveView('不存在视图XYZ'), e => e.code === 'VIEW_NOT_FOUND')
})

test('view CLI surface: view add/list --json + list --view applies conds (and drops the default today clip)', () => {
  const cat = lib.addCategory('CLI视图分类v2')
  seed({ taskContent: 'CLI视图逾期v2', categoryId: cat.categoryId, todoTime: +dayjs().subtract(1, 'day') })
  seed({ taskContent: 'CLI视图今日v2', categoryId: cat.categoryId, todoTime: today0() })
  const created = runCli(['view', 'add', 'CLI逾期视图v2', '--category', 'CLI视图分类v2', '--overdue', '--json'])
  assert.ok(created.data.id > 0)
  const list = runCli(['view', 'list', '--json'])
  const row = list.data.find(v => v.name === 'CLI逾期视图v2')
  assert.deepEqual(row.conds, { catId: cat.categoryId, priority: -1, dateMode: 'overdue' })
  // list --view: only the overdue undone task of that category; without --all it must NOT be clipped to today
  const out = runCliRaw(['list', '--view', 'CLI逾期视图v2'])
  assert.ok(out.includes('CLI视图逾期v2'), 'overdue task from the view shows up')
  assert.ok(!out.includes('CLI视图今日v2'), 'view conditions filter the rest out')
  // unrepresentable flags are rejected (would be stripped by normConds and silently never applied in the App)
  let rejected = false
  try { execFileSync(process.execPath, [path.join(ROOT, 'cli', 'pickdone.js'), 'view', 'add', '关键词视图v2', '--keyword', 'x', '--json'], { encoding: 'utf8' }) } catch (e) { rejected = e.status === 1 && JSON.parse(e.stderr).error === 'USAGE' }
  assert.ok(rejected, '--keyword must be rejected with a USAGE error')
  const rm = runCli(['view', 'rm', 'CLI逾期视图v2', '--json'])
  assert.ok(!runCli(['view', 'list', '--json']).data.some(v => v.id === rm.data.id))
})

/* ---------------- explicit project status ---------------- */
test('project --status sets the pinned meta key; none deletes it (falls back to active)', () => {
  const cat = lib.addCategory('状态项目v2')
  lib.setProjectFlag('状态项目v2', true)
  const paused = lib.setProjectStatus('状态项目v2', 'paused')
  assert.equal(paused.status, 'paused')
  assert.equal(db.call('getMeta', 'projectStatus:' + cat.categoryId), 'paused', 'contract key: projectStatus:<categoryId>')
  assert.equal(lib.explicitStatus(cat.categoryId), 'paused')
  // full enum accepted
  for (const s of ['active', 'done', 'cancelled']) {
    lib.setProjectStatus('状态项目v2', s)
    assert.equal(lib.explicitStatus(cat.categoryId), s)
  }
  // none clears the meta row entirely
  lib.setProjectStatus('状态项目v2', 'active')
  const cleared = lib.setProjectStatus('状态项目v2', 'none')
  assert.equal(cleared.cleared, true)
  assert.equal(db.call('getMeta', 'projectStatus:' + cat.categoryId), null, 'none deletes the meta key')
  assert.equal(lib.explicitStatus(cat.categoryId), 'active', 'absent key falls back to active')
  // validation
  assert.throws(() => lib.setProjectStatus('状态项目v2', 'archived'), e => e.code === 'USAGE')
  assert.throws(() => lib.setProjectStatus('不存在分类XYZ', 'paused'), e => e.code === 'CATEGORY_NOT_FOUND')
})

test('projectStatus stats row and getProjects carry the explicit status without breaking derived stats', () => {
  const cat = lib.addCategory('状态项目乙v2')
  lib.setProjectFlag('状态项目乙v2', true)
  seed({ taskContent: '状态项目任务v2', categoryId: cat.categoryId, todoTime: today0() })
  lib.setProjectStatus('状态项目乙v2', 'paused')
  const p = lib.getProjects().find(x => x.categoryId === cat.categoryId)
  assert.equal(p.status, 'paused')
  assert.equal(typeof p.total, 'number', 'derived stats fields still present')
  assert.equal(typeof p.progress, 'number')
  assert.equal(p.name, '状态项目乙v2')
  lib.setProjectStatus('状态项目乙v2', 'none')
  assert.equal(lib.getProjects().find(x => x.categoryId === cat.categoryId).status, 'active')
})

test('project status CLI surface: --status set/clear, projects --json rows + --status filter', () => {
  const a = lib.addCategory('CLI状态甲v2')
  lib.setProjectFlag('CLI状态甲v2', true)
  const b = lib.addCategory('CLI状态乙v2')
  lib.setProjectFlag('CLI状态乙v2', true)
  const set = runCli(['project', 'CLI状态甲v2', '--status', 'paused', '--json'])
  assert.equal(set.data.status, 'paused')
  const all = runCli(['projects', '--json'])
  assert.equal(all.data.find(p => p.name === 'CLI状态甲v2').status, 'paused')
  assert.ok('status' in all.data.find(p => p.name === 'CLI状态乙v2'), 'rows without an explicit key still report active')
  const filtered = runCli(['projects', '--json', '--status', 'paused'])
  assert.deepEqual(filtered.data.map(p => p.name), ['CLI状态甲v2'])
  const cleared = runCli(['project', 'CLI状态甲v2', '--status', 'none', '--json'])
  assert.equal(cleared.data.status, 'active')
  const detail = runCli(['project', 'CLI状态乙v2', '--json'])
  assert.equal(detail.data.status, 'active', 'project detail --json gains status')
  let rejected = false
  try { execFileSync(process.execPath, [path.join(ROOT, 'cli', 'pickdone.js'), 'project', 'CLI状态乙v2', '--status', 'archived', '--json'], { encoding: 'utf8' }) } catch (e) { rejected = e.status === 1 && JSON.parse(e.stderr).error === 'USAGE' }
  assert.ok(rejected, 'invalid status value rejected')
  assert.equal(a.categoryId > 0 && b.categoryId > 0, true)
})

/* ---------------- lunar annotation (deterministic, fixed date) ---------------- */
test('lunar annotation is deterministic for a fixed date (2026-09-10 → 七月廿九)', () => {
  const ts = +dayjs('2026-09-10 14:30')
  assert.equal(lib.lunarOf({ todoTime: ts }), '七月廿九')
  assert.equal(lib.lunarAnnotate({ todoTime: ts }), '2026-09-10 · 七月廿九')
  assert.equal(lib.lunarOf({ dayStart: +dayjs('2026-09-10') }), '七月廿九', 'dayStart fallback works')
  assert.equal(lib.lunarOf({ todoTime: 0, dayStart: 0 }), null, 'undated tasks carry no annotation')
})

test('list --lunar: JSON rows gain the additive lunar field; text dates gain the annotation', () => {
  seed({ taskContent: '农历固定任务v2', todoTime: +dayjs('2026-09-10 14:30') })
  seed({ taskContent: '农历无日期任务v2' })
  const rows = runCli(['list', '--all', '--lunar', '--json'])
  const dated = rows.data.find(t => t.taskContent === '农历固定任务v2')
  const undated = rows.data.find(t => t.taskContent === '农历无日期任务v2')
  assert.equal(dated.lunar, '2026-09-10 · 七月廿九')
  assert.equal(undated.lunar, null)
  const text = runCliRaw(['list', '--all', '--lunar'])
  assert.ok(text.includes('· 七月廿九'), 'text output annotates displayed dates')
  const plain = runCliRaw(['list', '--all'])
  assert.ok(!plain.includes('七月廿九'), 'without --lunar the annotation stays absent')
})
