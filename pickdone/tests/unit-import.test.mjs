/** CLI import engine unit tests (cli/import.js) — runs on a TODO_DB_DIR isolated temp DB, never touching real data.
 *  Fixtures use the vendors' real export column layouts (TickTick v3.0 backup, dida365 25-col backup, Todoist template).
 *  Covers: RFC4180 parsing / format detection / field+structure mapping (subtasks, completed, priority, lists→categories)
 *  / dedup across re-import and within one file / dry-run writes nothing / one audit entry per import.
 *  Run: node --test tests/unit-import.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-import-'))
const require_ = createRequire(import.meta.url)
const db = require_('../src/main/db.js')
const lib = require_('../cli/lib.js')
const imp = require_('../cli/import.js')
const dayjs = require_('dayjs')

db.init(process.env.TODO_DB_DIR)
const FIXTURE = name => path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'import', name)

/* ---- CSV parser ---- */
test('import: RFC4180 parser (quotes, escaped quotes, CRLF, BOM)', () => {
  const rows = imp.parseCsv('\uFEFF"a,b","c""d""",plain\r\n"x","y","z"\n')
  assert.deepEqual(rows, [['a,b', 'c"d"', 'plain'], ['x', 'y', 'z']])
})

test('import: format detection (ticktick meta lines / dida superset / todoist / unknown)', () => {
  assert.equal(imp.detectFormat(fs.readFileSync(FIXTURE('ticktick-backup.csv'), 'utf8')), 'ticktick')
  assert.equal(imp.detectFormat(fs.readFileSync(FIXTURE('dida365-backup.csv'), 'utf8')), 'dida365')
  assert.equal(imp.detectFormat(fs.readFileSync(FIXTURE('todoist-template.csv'), 'utf8')), 'todoist')
  assert.throws(() => imp.detectFormat('foo,bar\n1,2'), e => e.code === 'FORMAT_UNKNOWN')
})

/* ---- field/structure mapping ---- */
test('import: ticktick rows map to normalized items (header after meta lines, dedup pair, done row)', () => {
  const items = imp.rowsToItems(fs.readFileSync(FIXTURE('ticktick-backup.csv'), 'utf8'), 'ticktick')
  assert.equal(items.length, 6) // all data rows parse; the 买牛奶 pair dedups at import stage
  const report = imp.importItems(items, { format: 'ticktick', useLists: true })
  assert.equal(report.total, 6)
  assert.equal(report.imported, 5)
  assert.equal(report.duplicates, 1) // 买牛奶 twice inside one file
  assert.equal(report.skipped, 0)
  assert.deepEqual(report.categoriesCreated.sort(), ['生活', '工作'].sort())
  // field-level semantics on the written rows
  const all = lib.listTodos({ range: null, done: null, limit: 500 })
  const summary = all.find(t => t.taskContent === '写季度总结')
  assert.ok(summary, '写季度总结 imported')
  assert.equal(summary.priority, 3) // ticktick 5 (high) → 3
  assert.equal(summary.todoTime, +dayjs('2026/09/12').startOf('day'))
  assert.equal(summary.reminderTime, +dayjs('2026/09/12 09:00'))
  const rent = all.find(t => t.taskContent === '交房租')
  assert.equal(rent.complete, true, 'Status 1 imports as completed')
  assert.equal(rent.completedAt, +dayjs('2026/09/01 10:30'), 'Completed Time carried over')
  assert.equal(rent.priority, 1) // ticktick 1 (low) → 1
  const cats = lib.getCategories()
  const life = cats.find(c => c.categoryName === '生活')
  assert.equal(rent.categoryId, life.categoryId, 'list name becomes the task category')
  const weekly = all.find(t => t.taskContent === '周报')
  assert.equal(weekly.priority, 2) // ticktick 3 (medium) → 2
})

test('import: dida365 parentId builds subtasks, tags/status carried', () => {
  const items = imp.rowsToItems(fs.readFileSync(FIXTURE('dida365-backup.csv'), 'utf8'), 'dida365')
  assert.equal(items.length, 2) // 筹备搬家(2 subs) + 晨跑; 2 child rows folded into parent
  const move = items.find(i => i.title === '筹备搬家')
  assert.deepEqual(move.subs.map(s => s.text), ['联系搬家公司', '打包书籍'])
  assert.equal(move.subs.find(s => s.text === '联系搬家公司').checked, true) // child Status 1 → checked
  assert.deepEqual(move.tags, ['生活', '杂务'])
  const report = imp.importItems(items, { format: 'dida365', useLists: true })
  assert.equal(report.imported, 2)
  const parent = lib.listTodos({ keyword: '筹备搬家', limit: 10 })[0]
  const subs = JSON.parse(parent.subtasks)
  assert.equal(subs.length, 2)
  assert.equal(subs[0].checked, true)
})

test('import: todoist INDENT hierarchy + note rows + priority scale', () => {
  const items = imp.rowsToItems(fs.readFileSync(FIXTURE('todoist-template.csv'), 'utf8'), 'todoist')
  assert.equal(items.length, 2) // 迁移到拾事(2 subs) + 给同事写交接文档
  const root = items.find(i => i.title === '迁移到拾事')
  assert.deepEqual(root.subs.map(s => s.text), ['注册新账号', '导出旧数据'])
  assert.equal(root.priority, 3) // todoist p4 → 3
  assert.equal(root.notes.includes('导出前先去设置里找 Backup'), true, 'note row folded into parent notes')
  assert.equal(root.due, +dayjs('2026-09-15'))
  const doc = items.find(i => i.title === '给同事写交接文档')
  assert.equal(doc.priority, 0) // todoist p1 → 0
  assert.equal(doc.due, 0, 'natural-language date (明天) imports as no-date rather than garbage')
})

/* ---- dedup / dry-run / audit ---- */
test('import: re-importing the same file is a full no-op (dedup across runs, incl. recycle bin)', () => {
  const r1 = imp.importFile(FIXTURE('ticktick-backup.csv'), { format: 'ticktick' })
  assert.equal(r1.imported, 0)
  assert.equal(r1.duplicates, 6) // all 6 rows hit the fingerprint pool (5 live + the in-file duplicate)
  // delete one imported task (it sits in the recycle bin now), re-import: the recycled row must still block re-insert
  const victim = lib.listTodos({ keyword: '周报', limit: 5 })[0]
  lib.deleteTodo(victim.taskId)
  const r2 = imp.importFile(FIXTURE('ticktick-backup.csv'), { format: 'ticktick' })
  assert.equal(r2.imported, 0, 'a task sitting in the recycle bin still blocks re-import')
  assert.ok(!lib.listTodos({ keyword: '周报', limit: 5 }).length, 'the deleted task was not resurrected by re-import')
})

test('import: dry-run creates nothing (no tasks, no categories, no audit entry)', () => {
  const catsBefore = lib.getCategories().length
  const auditBefore = lib.readAuditLog({ action: 'import' }).length
  const r = imp.importFile(FIXTURE('dida365-backup.csv'), { format: 'dida365', dryRun: true })
  assert.equal(r.imported, 0, 'dry-run reports create actions but imports nothing')
  assert.ok(r.tasks.every(t => t.action === 'duplicate' || t.action === 'create'))
  assert.equal(lib.getCategories().length, catsBefore, 'dry-run must not create categories')
  assert.equal(lib.readAuditLog({ action: 'import' }).length, auditBefore, 'dry-run must not write audit')
  // first real dida import happened in an earlier test; this run should now be all-duplicates too
  assert.equal(r.duplicates, 2)
})

test('import: --category override + audit trail', () => {
  const cats = lib.getCategories()
  const target = cats.find(c => c.categoryName === '工作')
  const r = imp.importFile(FIXTURE('dida365-backup.csv'), { format: 'dida365', category: String(target.categoryId) })
  assert.equal(r.imported, 0, 'already imported in the dida test above — everything must be deduped')
  const entries = lib.readAuditLog({ action: 'import' })
  assert.equal(entries.length, 2, 'one audit entry per real import (dida + first ticktick) and none for dry-run/re-imports')
  assert.ok(entries[entries.length - 1].note.includes('duplicates'), 'audit note carries the dedup counts')
})

test('import: error paths (missing file, unknown format flag)', () => {
  assert.throws(() => imp.importFile('Z:/no/such.csv'), e => e.code === 'FILE_NOT_FOUND')
  assert.throws(() => imp.importFile(FIXTURE('todoist-template.csv'), { format: 'excel' }), e => e.code === 'USAGE')
})
