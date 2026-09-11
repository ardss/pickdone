/** CLI semantic-layer unit tests (cli/lib.js) — the whole run uses a TODO_DB_DIR isolated temp DB, never touching real data.
 *  Covers: list filter params / task and category resolution tolerance / read-write commands / subtasks / projects / milestones / deadlines / doctor / audit.
 *  Assertion discipline: verify business-semantic values (exact counts/field values/side-effect contents); no tautological "returned an object so it passes" assertions.
 *  Run: npm test */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-lib-'))
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const dayjs = require_('dayjs')

db.init(process.env.TODO_DB_DIR)

/** Seed a task straight into the DB (bypasses lib.addTodo for easier field control) */
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
  if (!t.taskId) t.taskId = require_('../../../src/main/core/todo-core.js').genTaskId(1, now)
  db.call('upsert', t)
  return db.call('getById', t.taskId)
}

function seedCat (id, name, isFolder = 0) {
  db.call('upsertCategory', { id, userId: 1, name, color: '#0f9d8f', createdAt: Date.now(), sort: id, isFolder, parentId: 0, deleted: 0 })
}

test('CLI: listTodos filter params (today/keyword/done/noDate/limit)', () => {
  const today0 = +dayjs().startOf('day')
  seed({ taskContent: 'CLI列表甲', todoTime: today0 })          // today
  seed({ taskContent: 'CLI列表乙keywordXYZ' })                   // no date
  seed({ taskContent: 'CLI已完成', complete: true, completedAt: Date.now() })
  const todayHits = lib.listTodos({ range: 'today' })
  assert.ok(todayHits.some(t => t.taskContent === 'CLI列表甲'), 'range=today should include todays task')
  assert.ok(todayHits.every(t => t.taskContent !== 'CLI列表乙keywordXYZ'), 'a no-date task does not belong to today')
  assert.equal(lib.listTodos({ keyword: 'keywordxyz' }).length, 1) // case-insensitive
  assert.ok(lib.listTodos({ done: true }).every(t => t.complete))
  assert.ok(lib.listTodos({ done: true }).length >= 1)
  const noDate = lib.listTodos({ noDate: true })
  assert.ok(noDate.some(t => t.taskContent === 'CLI列表乙keywordXYZ'), 'noDate should include the no-date task')
  assert.ok(noDate.every(t => !t.dayStart), 'noDate results must not include dated tasks')
  assert.ok(lib.listTodos({}).length <= 200) // default limit 200
})

test('CLI: resolveTask wide-whitespace normalization/ambiguity/not found', () => {
  seed({ taskContent: 'CLI唯一任务Unique' })
  assert.equal(lib.resolveTask('cli唯一任务unique').taskContent, 'CLI唯一任务Unique')
  assert.throws(() => lib.resolveTask('不存在的任务XYZ'), e => e.code === 'TASK_NOT_FOUND')
  seed({ taskContent: '歧义甲UniqueAmb' })
  seed({ taskContent: '歧义乙UniqueAmb' })
  assert.throws(() => lib.resolveTask('UniqueAmb'), e => e.code === 'AMBIGUOUS_MATCH')
})

test('CLI: category resolution (none/by id/by name/not found)', () => {
  assert.throws(() => lib.resolveCategory('任意'), e => e.code === 'NO_CATEGORIES')
  seedCat(11, 'CLI工作分类')
  assert.equal(lib.resolveCategory('11'), 11)
  assert.equal(lib.resolveCategory('CLI工作分类'), 11)
  assert.equal(lib.resolveCategory('none'), null)
  assert.equal(lib.resolveCategory(''), null)
  assert.throws(() => lib.resolveCategory('不存在分类'), e => e.code === 'CATEGORY_NOT_FOUND')
})

test('CLI: addTodo field semantics and overview deltas', () => {
  seedCat(12, 'CLI项目分类')
  const before = lib.overview()
  const a = lib.addTodo({ content: 'CLI新任务', date: 'tomorrow', category: 'CLI项目分类', difficulty: 3, desc: '说明' })
  // addTodo contract: date = tomorrow 00:00; category/difficulty/description persisted
  assert.equal(a.dayStart, +dayjs().add(1, 'day').startOf('day'))
  assert.equal(a.categoryId, 12)
  assert.equal(a.difficulty, 3)
  assert.equal(a.taskDescribe, '说明')
  const p = lib.patchTodo('CLI新任务', { taskContent: 'CLI改名任务' })
  assert.equal(p.taskContent, 'CLI改名任务')
  const after = lib.overview()
  assert.equal(after.today.total, before.today.total) // tomorrows task is not counted in today
  assert.equal(after.upcoming7days, before.upcoming7days + 1) // tomorrow is within the next 7 days, exactly +1
  // stats: aggregated by due date (the window must explicitly include tomorrow; default is past 6 days through today); tomorrows row should show the task with done=0
  const tomorrowKey = parseInt(dayjs().add(1, 'day').format('YYYYMMDD'), 10)
  // stats from/to accept dayjs-parseable date strings (formatted to YYYYMMDD internally)
  const row = lib.stats({ from: dayjs().format('YYYY-MM-DD'), to: dayjs().add(1, 'day').format('YYYY-MM-DD') }).find(r => r.day === tomorrowKey)
  assert.ok(row && row.total >= 1 && row.done === 0, 'stats tomorrows row should include the task as incomplete')
})

test('CLI: subtasks parseSubs/add/check/remove', () => {
  const t = seed({ taskContent: 'CLI子任务载体', subtasks: JSON.stringify([{ text: '子甲', checked: false }]) })
  assert.equal(lib.parseSubs(t).length, 1)
  const after = lib.addSubtask('CLI子任务载体', '子乙')
  assert.equal(lib.parseSubs(after).length, 2)
  const checked = lib.checkSubtask('CLI子任务载体', 1, true)
  assert.equal(lib.parseSubs(checked)[0].checked, true)
  const removed = lib.removeSubtask('CLI子任务载体', 2)
  assert.equal(lib.parseSubs(removed).length, 1)
})

test('CLI: complete/undo/delete/restore/recycle-bin purge', () => {
  seed({ taskContent: 'CLI生命周期' })
  const done = lib.toggleComplete('CLI生命周期', true)
  assert.equal(done.completed.complete, true) // complete returns {completed, renewed}
  assert.ok(done.completed.completedAt > 0)
  const undone = lib.toggleComplete('CLI生命周期', false)
  assert.equal(undone.complete, false) // undo returns the row object
  const del = lib.deleteTodo('CLI生命周期')
  assert.equal(del.delete, true)
  const res = lib.restoreTodo('CLI生命周期')
  assert.equal(res.delete, false)
  lib.deleteTodo('CLI生命周期')
  assert.equal(lib.recycleTasks().length, 1) // this file soft-deletes only this one
  lib.purgeRecycleBin()
  assert.equal(lib.recycleTasks().length, 0)
})

test('CLI: project flag/four-question stats/deadline', () => {
  const set = lib.setProjectFlag('CLI项目分类', true)
  assert.equal(set.isProject, true)
  // Category 12 now has two: CLI改名任务 (tomorrow) + this one (today)
  seed({ taskContent: 'CLI项目内任务', categoryId: 12, todoTime: +dayjs().startOf('day'), estimate: 25 })
  const projects = lib.getProjects()
  const proj = projects.find(p => p.categoryId === 12)
  // projectStatus four-question stats exact values: total=2 all incomplete, 1 today within next7days
  // focusMinutes=真实专注记录口径(2026-09-04 定稿):预计番茄不再是专注统计;种子任务无记录故为 0
  assert.equal(proj.total, 2)
  assert.equal(proj.done, 0)
  assert.equal(proj.progress, 0)
  assert.equal(proj.next7days, 2)
  assert.equal(proj.focusMinutes, 0)
  assert.equal(proj.overdue, 0)
  const dl = lib.setProjectDeadline('CLI项目分类', '+14d')
  assert.ok(dl.deadline > Date.now())
  assert.equal(lib.getProjectDeadline(12), dl.deadline)
  const cleared = lib.setProjectDeadline('CLI项目分类', 'none')
  assert.equal(cleared.deadline, 0)
  assert.throws(() => lib.setProjectDeadline('CLI项目分类', '不是日期XYZ'), e => e.code === 'BAD_DATE')
  lib.setProjectFlag('CLI项目分类', false)
  assert.ok(!lib.getProjectIds().includes(12))
})

test('CLI: milestones add/remove/link/progress/out-of-range', () => {
  lib.setProjectFlag('CLI项目分类', true)
  lib.addMilestone('CLI项目分类', 'CLI 里程碑甲', '+7d')
  const msList = lib.getMilestones('CLI项目分类').milestones
  assert.ok(msList.length >= 1)
  const idx = msList.length
  const linked = lib.linkMilestone('CLI项目分类', idx, 'CLI项目内任务', true)
  assert.deepEqual(linked.milestone.taskIds, [lib.resolveTask('CLI项目内任务').taskId])
  // msProgress: 1 linked incomplete task -> done=0/total=1/pct=0
  assert.ok(linked.progress && linked.progress.total === 1 && linked.progress.done === 0 && linked.progress.pct === 0)
  const unlinked = lib.linkMilestone('CLI项目分类', idx, 'CLI项目内任务', false)
  assert.equal(unlinked.milestone.taskIds.length, 0)
  assert.throws(() => lib.linkMilestone('CLI项目分类', 99, 'CLI项目内任务'), e => e.code === 'MS_NOT_FOUND')
  const rm = lib.removeMilestone('CLI项目分类', idx)
  assert.equal(rm.milestones.length, idx - 1) // removal took effect: count reduced by one
  assert.throws(() => lib.addMilestone('CLI项目分类', '坏日期里程碑', 'garbage-date'), e => e.code === 'BAD_DATE')
})

test('CLI: doctor read-only checkup + audit trail with full before/after snapshots', () => {
  const d = lib.doctor()
  assert.equal(d.ok, true)
  assert.ok(Array.isArray(d.checks) && d.checks.length >= 3)
  const entries = lib.readAuditLog()
  // Key side effect: the audit is the only traceable evidence for delete-type operations; it must contain the before snapshot and the action semantics
  const purge = entries.find(e => e.action === 'purge')
  assert.ok(purge && purge.changes.length >= 1 && purge.changes[0].before, 'purge audit must contain the before snapshot')
  const doneEntry = entries.find(e => e.action === 'done')
  assert.ok(doneEntry && doneEntry.changes[0].after.complete === true, 'done audit must contain the post-completion state')
})

/* ================= data-safety batch (isolation env gate / TODO_USER_DATA_DIR / restore-backup) ================= */
const { spawnSync } = await import('node:child_process')
const { fileURLToPath } = await import('node:url')
const HERE = path.dirname(fileURLToPath(import.meta.url))
const CLI = file => path.join(HERE, '../../..', 'cli', file)
const CLEAN = path.join(HERE, '../../..')

function spawnCleanEnv (args, extraEnv = {}) {
  const env = { ...process.env }
  delete env.TODO_DB_DIR
  delete env.TODO_USER_DATA_DIR
  return spawnSync(process.execPath, args, { cwd: CLEAN, env: { ...env, ...extraEnv }, encoding: 'utf8', timeout: 30000 })
}

test('CLI data-safety: e2e-walkthrough fails fast (non-zero) without any isolation env', () => {
  const r = spawnCleanEnv([CLI('e2e-walkthrough.js')])
  assert.notEqual(r.status, 0, 'must refuse to spawn the App against the real userData')
  assert.match((r.stderr || '') + (r.stdout || ''), /TODO_USER_DATA_DIR/, 'error message must explain how to set the isolation dir')
})

test('CLI data-safety: ui-smoke --launch fails fast without any isolation env', () => {
  const r = spawnCleanEnv([CLI('ui-smoke.js'), '--launch'])
  assert.notEqual(r.status, 0, '--launch must not spawn the App against the real userData')
  assert.match((r.stderr || '') + (r.stdout || ''), /TODO_USER_DATA_DIR/)
})

test('CLI data-safety: lib.userDataDir accepts TODO_USER_DATA_DIR as fallback (TODO_DB_DIR keeps priority)', () => {
  const savedDbDir = process.env.TODO_DB_DIR
  const uddRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-udd-'))
  delete process.env.TODO_DB_DIR
  process.env.TODO_USER_DATA_DIR = uddRoot
  try {
    assert.equal(lib.userDataDir(), uddRoot) // same top-level layout as the App userData (todos.db sits directly inside)
    assert.equal(lib.hasIsolationEnv(), true)
    // backward compat: TODO_DB_DIR still wins when both are set
    process.env.TODO_DB_DIR = savedDbDir
    assert.equal(lib.userDataDir(), savedDbDir)
  } finally {
    process.env.TODO_DB_DIR = savedDbDir
    process.env.TODO_USER_DATA_DIR = undefined
  }
  assert.equal(lib.userDataDir(), savedDbDir)
})

test('CLI data-safety: restore-backup without args lists auto snapshots and never writes the DB', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-restore-'))
  fs.mkdirSync(path.join(dir, 'backups'))
  fs.writeFileSync(path.join(dir, 'backups', 'auto-20260901-120000.json'), JSON.stringify({ todos: [{ taskId: 'a' }], categories: [] }))
  const r = spawnSync(process.execPath, [CLI('pickdone.js'), 'restore-backup'], {
    cwd: CLEAN, env: { ...process.env, TODO_DB_DIR: dir }, encoding: 'utf8', timeout: 30000
  })
  assert.equal(r.status, 0, (r.stderr || '') + (r.stdout || ''))
  assert.match(r.stdout, /auto-20260901-120000\.json/)
  assert.match(r.stdout, /modified 20\d\d-\d\d-\d\d \d\d:\d\d:\d\d/, 'listing must include the snapshot mtime')
  // no write side effects: the isolated DB was never created by this read-only command
  assert.equal(fs.existsSync(path.join(dir, 'todos.db')), false, 'restore-backup list must not open/create the database')
})

/* ---------- events import helpers + add --created-at (backfill scenario, 2026-09-04) ---------- */
test('CLI: eventFocusMinutes = duration×0.75 rounded to 25-min pomodoros, floor 25', () => {
  assert.equal(lib.eventFocusMinutes(60), 50)   // 45min → round(1.8)=2 tomatoes
  assert.equal(lib.eventFocusMinutes(120), 100) // 90min → round(3.6)=4 tomatoes
  assert.equal(lib.eventFocusMinutes(180), 125) // 135min → round(5.4)=5 tomatoes
  assert.equal(lib.eventFocusMinutes(10), 25)   // sub-threshold floors at one tomato
})
test('CLI: eventKey dedupes on dayStart+title', () => {
  const a = lib.eventKey({ date: '2026-09-10', start: '10:00', title: '拾事:发布' })
  const b = lib.eventKey({ date: '2026-09-10', start: '14:00', title: '拾事:发布' })
  const c = lib.eventKey({ date: '2026-09-11', start: '10:00', title: '拾事:发布' })
  assert.equal(a, b, 'same day+title dedupes regardless of start time')
  assert.notEqual(a, c, 'different day does not dedupe')
})
test('CLI: addTodo --created-at backfills createTime (rebuild scenario)', () => {
  const t = lib.addTodo({ content: '补录-创建时间回填', date: '2026-09-01 09:00', createTime: '2026-09-01 08:30' })
  const row = require_('../../../src/main/db.js').call('getById', t.taskId)
  assert.equal(dayjs(row.createTime).format('YYYY-MM-DD HH:mm'), '2026-09-01 08:30')
  assert.equal(dayjs(row.todoTime).format('YYYY-MM-DD HH:mm'), '2026-09-01 09:00')
})
