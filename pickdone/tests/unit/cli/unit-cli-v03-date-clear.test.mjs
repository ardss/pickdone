/** CLI v0.3 — `edit --date none|clear` moves a dated task back to the todo box (replaces the old
 *  create-new + delete-old workaround). Parity source for the cleared field shape was READ, not guessed:
 *  renderer EditPanel.setDate('none') → applyDate(0) → queueSave({ todoTime: 0, reminderTime: 0,
 *  reminderExtra: kept }) → store/todo.js updateTodoFields (derived dayStart = 0) + rowChipSync
 *  date-removed branch (snapshotForDelete → meta planChipsSnapshot:<id>, then clearTaskChips = planDeleteTask).
 *  Isolated temp DB via TODO_DB_DIR, never touches real data; CLI-surface checks spawn cli/pickdone.js
 *  with the same TODO_DB_DIR (cli-smoke.js / unit-cli-v02 pattern).
 *  Run: node --test tests/unit-cli-v03-date-clear.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-v03-dateclear-'))
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const core = require_('../../../src/main/core/todo-core.js')
const dayjs = require_('dayjs')

db.init(process.env.TODO_DB_DIR)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')
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

const chipsOf = taskId => db.call('planAll', []).filter(r => r.taskId === taskId)
const tomorrow930 = () => +dayjs().add(1, 'day').hour(9).minute(30).second(0).millisecond(0)

test('clearTodoDate writes the renderer\'s exact cleared shape (todoTime=0, dayStart=0, main reminder drops, extras kept) and the task lands in list --no-date', () => {
  const extraTs = +dayjs().add(2, 'day').hour(10).minute(0).second(0).millisecond(0)
  const noBefore = lib.overview().noDate
  const t = seed({
    taskContent: 'v3清除甲',
    todoTime: tomorrow930(),
    reminderTime: +dayjs().add(1, 'day').hour(8).minute(0).second(0).millisecond(0),
    reminderExtra: [extraTs]
  })
  assert.equal(t.dayStart, +dayjs().add(1, 'day').startOf('day'), 'seed sanity: db derives dayStart from todoTime')
  const r = lib.clearTodoDate('v3清除甲')
  assert.equal(r.changed, true)
  // exact field shape the App writes when a user clears the date (EditPanel applyDate(0) → updateTodoFields)
  const row = db.call('getById', t.taskId)
  assert.equal(row.todoTime, 0)
  assert.equal(row.dayStart, 0, 'dayStart (today grouping) must be cleared consistently with todoTime')
  assert.equal(row.reminderTime, 0, 'the App zeroes the main reminder along with its date')
  assert.deepEqual(row.reminderExtra, [extraTs], 'extra reminders are kept as-is, same as the App')
  assert.equal(row.status, 'update', 'edit semantics: status=update like the renderer\'s updateTodoFields')
  assert.ok(row.updateTime >= t.updateTime, 'updateTime must be bumped')
  // todo box visibility: noDate listing + overview counter
  assert.ok(lib.listTodos({ noDate: true }).some(x => x.taskId === t.taskId), 'cleared task must appear in the no-date (todo box) listing')
  assert.equal(lib.overview().noDate, noBefore + 1, 'overview no-date counter must increase by exactly 1')
})

test('CLI `edit --date clear` (alias) and `--date none` both clear; JSON carries the updated row', () => {
  const a = seed({ taskContent: 'v3别名乙', todoTime: tomorrow930() })
  const out = runCli(['edit', a.taskId, '--date', 'clear', '--json'])
  assert.equal(out.ok, true)
  assert.equal(out.data.todoTime, 0)
  assert.equal(out.data.dayStart, 0)
  assert.ok((out.next || []).some(s => s.includes('todo box')), 'next hints point at the todo box')
  assert.equal(db.call('getById', a.taskId).todoTime, 0, 'subprocess write must be visible through the shared OPS table')

  const b = seed({ taskContent: 'v3主形式丙', todoTime: tomorrow930() })
  const out2 = runCli(['edit', 'v3主形式丙', '--date', 'none', '--json'])
  assert.equal(out2.ok, true)
  assert.equal(out2.data.todoTime, 0)
  assert.equal(db.call('getById', b.taskId).dayStart, 0)
})

test('schedule chips of the cleared task are removed (snapshot kept); other tasks\' chips on the same day stay untouched', () => {
  const ymd = dayjs(+dayjs().add(3, 'day').startOf('day')).format('YYYY-MM-DD')
  const otherYmd = dayjs(+dayjs().add(4, 'day').startOf('day')).format('YYYY-MM-DD')
  const a = seed({ taskContent: 'v3排程甲', todoTime: +dayjs().add(3, 'day').hour(9).minute(0) })
  const b = seed({ taskContent: 'v3旁观乙', todoTime: +dayjs().add(3, 'day').hour(15).minute(0) })
  db.call('planAddMany', [
    { taskId: a.taskId, day: ymd, mm: '09:00' },
    { taskId: a.taskId, day: ymd, mm: '10:30' },
    { taskId: a.taskId, day: otherYmd, mm: '08:00' }, // chip on a foreign day (possible via plan set --date)
    { taskId: b.taskId, day: ymd, mm: '11:00' }
  ])
  assert.equal(chipsOf(a.taskId).length, 3, 'seed sanity: 3 chips on task A')
  const r = lib.clearTodoDate(a.taskId)
  assert.equal(r.changed, true)
  assert.equal(chipsOf(a.taskId).length, 0, 'no chip may survive a date clear — they have no day to live on')
  const keep = chipsOf(b.taskId)
  assert.equal(keep.length, 1, 'other tasks\' chips must stay untouched')
  assert.equal(keep[0].day, ymd)
  assert.equal(keep[0].mm, '11:00')
  // renderer parity: rowChipSync snapshots before clearing so a later restore can backfill
  const snap = JSON.parse(db.call('getMeta', 'planChipsSnapshot:' + a.taskId) || '[]')
  assert.equal(snap.length, 3, 'chips snapshot kept in meta, same as the App\'s date-removed branch')
})

test('audit entry records the change with before/after (date → none) and a clear note', () => {
  const t = seed({ taskContent: 'v3审计丙', todoTime: tomorrow930() })
  const beforeCount = lib.readAuditLog({ n: 1000, action: 'edit' }).length
  lib.clearTodoDate(t.taskId)
  const entries = lib.readAuditLog({ n: 1000, action: 'edit' })
  assert.equal(entries.length, beforeCount + 1, 'exactly one edit audit entry per clear')
  const e = entries[entries.length - 1]
  assert.ok((e.targets || []).some(x => x.taskId === t.taskId))
  const c = (e.changes || [])[0]
  assert.equal(c.taskId, t.taskId)
  assert.ok(c.before && c.before.todoTime > 0 && c.before.dayStart > 0, 'before snapshot carries the old date + derived day')
  assert.equal(c.after.todoTime, 0)
  assert.equal(c.after.dayStart, 0)
  assert.equal(e.note, 'date cleared → todo box')
})

test('already-undated task: documented no-op (changed:0, nothing written, no audit entry)', () => {
  const t = seed({ taskContent: 'v3无日期丁' })
  const beforeCount = lib.readAuditLog({ n: 1000, action: 'edit' }).length
  const r = lib.clearTodoDate(t.taskId)
  assert.equal(r.changed, false)
  assert.equal(r.task.taskId, t.taskId)
  assert.equal(lib.readAuditLog({ n: 1000, action: 'edit' }).length, beforeCount, 'no-op must not write an audit entry')
  assert.equal(db.call('getById', t.taskId).todoTime, 0)
  // CLI surface: changed:0 contract for machine consumers
  const out = runCli(['edit', t.taskId, '--date', 'none', '--json'])
  assert.equal(out.ok, true)
  assert.equal(out.data.changed, 0)
  assert.equal(out.data.dateCleared, false)
})

test('dry-run previews todoTime 0 without writing; only the exact words none|clear clear (typos still hit the date parser); normal --date reschedule unaffected', () => {
  const t = seed({ taskContent: 'v3预演戊', todoTime: tomorrow930() })
  const out = runCli(['edit', t.taskId, '--date', 'none', '--dry-run', '--json'])
  assert.equal(out.data.dryRun, true)
  assert.equal(out.data.patch.todoTime, 0, 'dry run must preview the cleared shape')
  assert.equal(db.call('getById', t.taskId).todoTime, tomorrow930(), 'dry run must not clear the date')
  // error parity: anything but none/clear goes through the normal date parser and fails loudly
  assert.throws(() => runCli(['edit', t.taskId, '--date', 'nne', '--json']), /cannot parse date/)
  // regression: a real date still reschedules through the same edit path
  const out2 = runCli(['edit', t.taskId, '--date', '+2d', '--json'])
  assert.equal(out2.ok, true)
  assert.equal(db.call('getById', t.taskId).dayStart, +dayjs().add(2, 'day').startOf('day'))
})
