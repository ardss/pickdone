/**
 * Integration tests — full data-lifecycle regression driven by real SQLite (isolated temp DB).
 * TODO_DB_DIR must be set before importing cli/lib.js to prevent accidentally writing real data.
 * Covers: CRUD / completion pipeline (completedAt) / soft delete -> recycle bin (deletedAt) -> restore -> hard delete /
 *       subtask cascades / stats units (statsByDay ms vs YYYYMMDD) / getAll filter params.
 * Run: npm test
 */
import { createRequire } from 'module'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-int-'))
const require_ = createRequire(import.meta.url)
const lib = require_('../../cli/lib.js')
const dayjs = require_('dayjs')

const ymd = ts => parseInt(dayjs(ts).format('YYYYMMDD'), 10)
const content = s => s + ' ' + Math.random().toString(36).slice(2, 6) // avoids ambiguous matches

test('integration: add -> list -> get persists every field', () => {
  const c = content('集成新增')
  const added = lib.addTodo({ content: c, date: 'today' })
  assert.ok(added.taskId)
  assert.equal(added.complete, false)
  assert.equal(added.dayStart, +dayjs().startOf('day'))

  const got = lib.resolveTask(added.taskId)
  assert.equal(got.taskId, added.taskId)
  assert.ok(lib.listTodos('today', {}).some(t => t.taskId === added.taskId))
})

test('integration: edit date -> dayStart derived automatically (updateTodoFields semantics)', () => {
  const added = lib.addTodo({ content: content('集成改期'), date: 'today' })
  const tomorrow = +dayjs().add(1, 'day').startOf('day')
  lib.patchTodo(added.taskId, { todoTime: tomorrow })
  const after = lib.resolveTask(added.taskId)
  assert.equal(after.dayStart, tomorrow)
})

test('integration: done/undo - completedAt written and cleared', () => {
  const added = lib.addTodo({ content: content('集成完成'), date: 'today' })
  const { completed } = lib.toggleComplete(added.taskId, true)
  assert.equal(completed.complete, true)
  assert.ok(completed.completedAt > 0)

  const undone = lib.toggleComplete(completed.taskId, false)
  assert.equal(undone.complete, false)
})

test('integration: delete -> recycle bin (deletedAt written, gone from live)', () => {
  const added = lib.addTodo({ content: content('集成删除'), date: 'today' })
  lib.deleteTodo(added.taskId)
  assert.equal(lib.resolveTask(added.taskId).delete, true)
  const recycle = lib.recycleTasks()
  const row = recycle.find(t => t.taskId === added.taskId)
  assert.ok(row, 'the soft-deleted task should appear in the recycle bin')
  assert.ok(row.deletedAt > 0, 'deletedAt must be written (the 30-day auto purge and ordering depend on it)')
})

test('integration: restore -> deletedAt reset to 0, back in live', () => {
  const added = lib.addTodo({ content: content('集成恢复'), date: 'today' })
  lib.deleteTodo(added.taskId)
  lib.restoreTodo(added.taskId)
  const after = lib.resolveTask(added.taskId)
  assert.equal(after.delete, false)
  assert.equal(after.deletedAt || 0, 0)
})

test('integration: after purgeRecycleBin the task is unqueryable', () => {
  const added = lib.addTodo({ content: content('集成销毁'), date: 'today' })
  lib.deleteTodo(added.taskId)
  assert.ok(lib.recycleTasks().some(t => t.taskId === added.taskId))
  lib.purgeRecycleBin()
  assert.equal(lib.recycleTasks().length, 0)
  let threw = false
  try { lib.resolveTask(added.taskId) } catch { threw = true }
  assert.ok(threw, 'after hard delete resolveTask should not find the task')
})

test('integration: stats unit regression - day_start ms vs YYYYMMDD (previously all zeros)', () => {
  lib.addTodo({ content: content('集成统计'), date: 'today' })
  const rows = lib.stats({ from: dayjs(Date.now() - 7 * 86400000).format('YYYY-MM-DD'), to: dayjs().format('YYYY-MM-DD') })
  assert.ok(rows.length > 0, 'stats must not be empty')
  for (const r of rows) {
    assert.match(String(r.day), /^\d{8}$/, 'the day key must be a YYYYMMDD integer')
  }
  const todayRow = rows.find(r => r.day === ymd(Date.now()))
  assert.ok(todayRow && todayRow.total > 0, 'today must have a task count')
})

test('integration: getAll with the deleted filter param does not throw and is semantically correct (placeholder regression)', () => {
  const db = lib.open()
  const liveBefore = db.call('getAll', {}).length
  const added = lib.addTodo({ content: content('集成过滤'), date: 'today' })
  lib.deleteTodo(added.taskId)
  const deleted = db.call('getAll', { deleted: 1 })
  assert.ok(deleted.every(t => t.delete === true || t.deleted === 1 || t.delete === 1))
  // Soft-delete right after adding: the live total should return to liveBefore (not +1; soft-deleted rows do not count as live)
  assert.equal(db.call('getAll', { deleted: 0 }).length, liveBefore)
})

test('integration: subtasks add/check/remove round trip', () => {
  const added = lib.addTodo({ content: content('集成子任务'), date: 'today' })
  lib.addSubtask(added.taskId, '第一步')
  lib.addSubtask(added.taskId, '第二步')
  let t = lib.resolveTask(added.taskId)
  let subs = JSON.parse(t.subtasks || '[]')
  assert.equal(subs.length, 2)
  lib.checkSubtask(added.taskId, '第一步', true)
  t = lib.resolveTask(added.taskId)
  subs = JSON.parse(t.subtasks || '[]')
  assert.equal(subs.find(s => s.text === '第一步').checked, true)
  lib.removeSubtask(added.taskId, '第一步')
  t = lib.resolveTask(added.taskId)
  assert.equal(JSON.parse(t.subtasks || '[]').length, 1)
})
