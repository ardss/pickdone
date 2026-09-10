/** CLI v0.2 features — batch operations + category folder hierarchy. Isolated temp DB via TODO_DB_DIR, never touches real data.
 *  Covers: batch done/date/category/tag (dry-run writes nothing, per-task failures never abort, ids-only discipline)
 *  / folder create + move + cycle guard / hierarchy listing (folders as roots, children indented — mirrors the App's
 *  `hierarchical` getter which drops nested folders, so folder→folder moves must be rejected).
 *  CLI surface checks spawn cli/pickdone.js with the same TODO_DB_DIR (cli-smoke.js pattern).
 *  Run: node --test tests/unit-cli-v02-batch-folder.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-v02-batch-'))
const require_ = createRequire(import.meta.url)
const db = require_('../src/main/db.js')
const lib = require_('../cli/lib.js')
const core = require_('../src/main/core/todo-core.js')
const dayjs = require_('dayjs')

db.init(process.env.TODO_DB_DIR)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const runCli = args => JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'cli', 'pickdone.js'), ...args], { encoding: 'utf8' }))

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

/* ---------------- batch: done ---------------- */
test('batch done completes many tasks, one audit entry per task', () => {
  const a = seed({ taskContent: '批量甲v2' })
  const b = seed({ taskContent: '批量乙v2' })
  const c = seed({ taskContent: '批量丙v2' })
  const before = lib.readAuditLog({ n: 500, action: 'done' }).length
  const r = lib.batchRun('done', [a.taskId, b.taskId, c.taskId])
  assert.equal(r.op, 'done')
  assert.equal(r.matched, 3)
  assert.equal(r.changed, 3)
  assert.deepEqual(r.failures, [])
  for (const id of [a.taskId, b.taskId, c.taskId]) assert.equal(db.call('getById', id).complete, true)
  const entries = lib.readAuditLog({ n: 500, action: 'done' })
  assert.equal(entries.length, before + 3, 'one audit entry per task change')
})

test('batch: unknown/ambiguous id lands in failures, the rest still execute', () => {
  const a = seed({ taskContent: '批量容错甲v2' })
  const b = seed({ taskContent: '批量容错乙v2' })
  const r = lib.batchRun('done', ['NOPE_missing_id', a.taskId, b.taskId])
  assert.equal(r.changed, 2)
  assert.equal(r.failures.length, 1)
  assert.equal(r.failures[0].taskId, 'NOPE_missing_id')
  assert.ok(r.failures[0].error.includes('NOPE_missing_id'))
  assert.equal(db.call('getById', a.taskId).complete, true, 'failure must not abort the remaining tasks')
  assert.equal(db.call('getById', b.taskId).complete, true)
})

test('batch is ids-only: a keyword that would match resolveTask must fail', () => {
  seed({ taskContent: '批量唯独一无关键词UniqueKeyword' })
  const r = lib.batchRun('done', ['UniqueKeyword'])
  assert.equal(r.changed, 0)
  assert.equal(r.failures.length, 1)
  assert.equal(r.failures[0].taskId, 'UniqueKeyword')
  const doneEntries = lib.readAuditLog({ n: 500, action: 'done' })
  assert.ok(!doneEntries.some(e => (e.targets || []).some(t => (t.content || '').includes('UniqueKeyword'))), 'no task may be completed via keyword matching')
})

test('batch --dry-run prints the plan and writes nothing', () => {
  const a = seed({ taskContent: '批量预演v2', todoTime: +dayjs().startOf('day') })
  const r = lib.batchRun('date', [a.taskId], { to: '+2d', dryRun: true })
  assert.equal(r.dryRun, true)
  assert.equal(r.matched, 1)
  assert.equal(r.plan.length, 1)
  assert.equal(r.plan[0].taskId, a.taskId)
  assert.ok(r.plan[0].label.includes('+2d'), 'plan line names the target date')
  const after = db.call('getById', a.taskId)
  assert.equal(after.todoTime, +dayjs().startOf('day'), 'dry run must not reschedule')
  const r2 = lib.batchRun('done', [a.taskId], { dryRun: true })
  assert.equal(r2.plan.length, 1)
  assert.equal(db.call('getById', a.taskId).complete, false, 'dry run must not complete')
})

test('batch date reschedules via the same parser as edit and migrates chips', () => {
  const a = seed({ taskContent: '批量改期v2', todoTime: +dayjs().startOf('day') })
  lib.planSet(a.taskId, '09:00', {})
  const r = lib.batchRun('date', [a.taskId], { to: '+1d' })
  assert.equal(r.changed, 1)
  const after = db.call('getById', a.taskId)
  assert.equal(after.dayStart, +dayjs().add(1, 'day').startOf('day'))
  const ymd = d => dayjs(d).format('YYYY-MM-DD')
  const chips = db.call('planAll', []).filter(x => x.taskId === a.taskId)
  assert.ok(chips.length, 'task keeps its chips')
  assert.ok(chips.every(x => x.day === ymd(after.dayStart)), 'chips follow the task to the new day (same semantics as edit --date)')
})

test('batch date rejects a bad --to before writing anything', () => {
  const a = seed({ taskContent: '批量坏日期v2' })
  assert.throws(() => lib.batchRun('date', [a.taskId], { to: '不是日期XYZ' }), e => /cannot parse date/.test(e.message))
  assert.throws(() => lib.batchRun('date', [a.taskId], {}), e => e.code === 'USAGE')
  assert.equal(db.call('getById', a.taskId).todoTime, 0)
})

test('batch category recategorizes many tasks', () => {
  const target = lib.addCategory('批量目标分类v2')
  const a = seed({ taskContent: '批量归类甲v2' })
  const b = seed({ taskContent: '批量归类乙v2' })
  const r = lib.batchRun('category', [a.taskId, b.taskId], { to: '批量目标分类v2' })
  assert.equal(r.changed, 2)
  assert.equal(db.call('getById', a.taskId).categoryId, target.categoryId)
  assert.equal(db.call('getById', b.taskId).categoryId, target.categoryId)
})

test('batch tag add/rm rewrites title via the same path as tag rename; absent tag = per-task failure', () => {
  const a = seed({ taskContent: '批量标签甲v2' })
  const b = seed({ taskContent: '批量标签乙v2 带尾空格  ' })
  const r = lib.batchRun('tag', [a.taskId, b.taskId], { add: 'urgent' })
  assert.equal(r.changed, 2)
  assert.equal(db.call('getById', a.taskId).taskContent, '批量标签甲v2 #urgent')
  assert.equal(db.call('getById', b.taskId).taskContent, '批量标签乙v2 带尾空格 #urgent', 'trailing whitespace trimmed before appending (EditPanel.addTag semantics)')
  // re-add = per-task failure, not a silent duplicate
  const dup = lib.batchRun('tag', [a.taskId], { add: 'urgent' })
  assert.equal(dup.changed, 0)
  assert.equal(dup.failures[0].taskId, a.taskId)
  // rm removes from title and description
  lib.patchTodo(a.taskId, { taskDescribe: 'see #urgent notes' })
  const rm = lib.batchRun('tag', [a.taskId], { rm: 'urgent' })
  assert.equal(rm.changed, 1)
  assert.equal(db.call('getById', a.taskId).taskContent, '批量标签甲v2')
  assert.equal(db.call('getById', a.taskId).taskDescribe, 'see notes')
  // rm on a task without the tag = explicit failure
  const untagged = seed({ taskContent: '批量无标签v2' })
  const missing = lib.batchRun('tag', [untagged.taskId], { rm: 'urgent' })
  assert.equal(missing.changed, 0)
  assert.equal(missing.failures.length, 1)
})

test('batch rejects unknown ops and empty id lists', () => {
  assert.throws(() => lib.batchRun('purge', ['x']), e => e.code === 'USAGE')
  assert.throws(() => lib.batchRun('done', []), e => e.code === 'USAGE')
  assert.throws(() => lib.batchRun('tag', ['x'], {}), e => e.code === 'USAGE', 'tag needs exactly one of --add/--rm')
})

test('batch CLI --json envelope is {op, matched, changed, failures, ok}; partial failure exits 2', () => {
  const a = seed({ taskContent: '批量信封甲v2' })
  let r
  try {
    execFileSync(process.execPath, [path.join(ROOT, 'cli', 'pickdone.js'), 'batch', 'done', a.taskId, 'NOPE_x', '--json'], { encoding: 'utf8' })
    assert.fail('partial failure must exit non-zero')
  } catch (e) {
    r = JSON.parse(e.stdout)
    assert.equal(e.status, 2, 'partial failure exit code mirrors events import')
  }
  assert.equal(r.ok, true, 'envelope ok stays true (command ran); the run outcome lives in data')
  assert.equal(r.data.ok, false, 'per-task failure surfaces as data.ok=false')
  assert.equal(r.data.op, 'done')
  assert.equal(r.data.matched, 2)
  assert.equal(r.data.changed, 1)
  assert.equal(r.data.failures[0].taskId, 'NOPE_x')
  const okRun = runCli(['batch', 'done', seed({ taskContent: '批量信封乙v2' }).taskId, '--json'])
  assert.equal(okRun.data.ok, true)
  assert.equal(okRun.data.changed, 1)
})

/* ---------------- category folders ---------------- */
test('category add --folder creates a folder; --parent places under an existing folder only', () => {
  const folder = lib.addCategory('文件夹甲v2', { folder: true })
  assert.equal(folder.folderIs, true)
  const child = lib.addCategory('子分类甲v2', { parent: '文件夹甲v2' })
  assert.equal(child.folderIs, false)
  assert.equal(child.folderId, folder.categoryId)
  // rows round-trip through the SQLite categories table (isFolder/parentId columns) the App reads
  const row = db.call('getAllCategories').find(c => c.categoryId === folder.categoryId)
  assert.equal(row.folderIs, true)
  assert.throws(() => lib.addCategory('孤儿子v2', { parent: '子分类甲v2' }), e => e.code === 'CATEGORY_NOT_FOLDER', 'parent must be a folder')
})

test('category move: under folder, back to root; folder→folder rejected (App drops nested folders)', () => {
  const folder = lib.addCategory('文件夹乙v2', { folder: true })
  const cat = lib.addCategory('可移动分类v2')
  const moved = lib.moveCategory(cat.categoryId, '文件夹乙v2')
  assert.equal(moved.folderId, folder.categoryId)
  assert.equal(moved.parentName, '文件夹乙v2')
  assert.equal(db.call('getAllCategories').find(c => c.categoryId === cat.categoryId).folderId, folder.categoryId)
  const rooted = lib.moveCategory(cat.categoryId, 'root')
  assert.equal(rooted.folderId, 0)
  assert.equal(rooted.parentName, null)
  assert.throws(() => lib.moveCategory(cat.categoryId, '可移动分类v2'), e => e.code === 'CATEGORY_CYCLE', 'moving under itself is a cycle')
  const folder2 = lib.addCategory('文件夹丙v2', { folder: true })
  assert.throws(() => lib.moveCategory(folder.categoryId, folder2.categoryId), e => e.code === 'CATEGORY_NESTED_FOLDER',
    'the App hierarchical getter renders folders as roots only — folder→folder moves are rejected for consistency')
  assert.throws(() => lib.moveCategory(cat.categoryId, '可移动分类v2'), e => e.code === 'CATEGORY_CYCLE')
})

test('category move cycle guard protects legacy nested-folder data', () => {
  // The CLI never creates nested folders, but legacy/future data may hold some — the guard must still close loops
  const grand = { id: 880001, userId: 1, name: '嵌套爷v2', color: '#0f9d8f', createdAt: Date.now(), sort: 880001, isFolder: 1, parentId: 0, deleted: 0 }
  const mid = { id: 880002, userId: 1, name: '嵌套父v2', color: '#0f9d8f', createdAt: Date.now(), sort: 880002, isFolder: 1, parentId: 880001, deleted: 0 }
  db.call('upsertCategory', grand)
  db.call('upsertCategory', mid)
  assert.throws(() => lib.moveCategory(880001, 880002), e => e.code === 'CATEGORY_CYCLE', 'grand folder into its own descendant = cycle')
  const okMove = lib.moveCategory(880002, 'root') // to root is always fine
  assert.equal(okMove.folderId, 0)
})

test('categories listing: hierarchy order with folders marked, JSON rows gain additive folderIs/folderId/parentName', () => {
  const folder = lib.addCategory('层级文件夹v2', { folder: true })
  const c1 = lib.addCategory('层级子一v2', { parent: folder.categoryId })
  const c2 = lib.addCategory('层级子二v2', { parent: folder.categoryId })
  const root = lib.addCategory('层级散件v2')
  const tree = lib.categoryHierarchy()
  const names = tree.map(x => x.row.categoryName)
  const idx = n => names.indexOf(n)
  assert.ok(idx('层级文件夹v2') < idx('层级子一v2') && idx('层级子一v2') < idx('层级子二v2'), 'children render after their folder')
  assert.equal(tree.find(x => x.row.categoryId === folder.categoryId).depth, 0, 'folders are roots')
  assert.equal(tree.find(x => x.row.categoryId === c1.categoryId).depth, 1, 'children are indented one level')
  assert.equal(tree.find(x => x.row.categoryId === root.categoryId).depth, 0, 'plain categories stay at root level')
  // JSON: same flat rows as getAllCategories plus additive fields only
  const rows = lib.categoryRows()
  const row = rows.find(c => c.categoryId === c2.categoryId)
  assert.equal(row.parentName, '层级文件夹v2')
  assert.equal(row.folderIs, false)
  assert.equal(row.folderId, folder.categoryId)
  const folderRow = rows.find(c => c.categoryId === folder.categoryId)
  assert.equal(folderRow.folderIs, true)
  assert.equal(folderRow.parentName, null)
  const plainRow = rows.find(c => c.categoryId === root.categoryId)
  assert.equal(plainRow.parentName, null, 'root rows carry parentName null')
  // CLI surface: categories --json stays additive (existing rows keep their fields)
  const cliRows = runCli(['categories', '--json'])
  assert.ok(cliRows.ok)
  const cliRow = cliRows.data.find(c => c.categoryName === '层级子一v2')
  assert.equal(cliRow.parentName, '层级文件夹v2')
  assert.ok(cliRow.categoryId && 'folderIs' in cliRow && 'folderId' in cliRow, 'app-shaped row fields survive the CLI output')
})
