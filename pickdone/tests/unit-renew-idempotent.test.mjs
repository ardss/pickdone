/** Real tests of renewal-instance idempotency - prevents multi-window concurrency + repeated CLI triggers from generating two renewals at the same instant.
 *  Run: npm test */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import './setup.mjs'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'
const require_ = createRequire(import.meta.url)

function tmpDir () { return fs.mkdtempSync(path.join(os.tmpdir(), 'todo-renew-')) }
function seedDefaultCat (db) {
  db.call('upsertCategory', { id: 0, userId: 1, name: 'default', color: '#000', createdAt: Date.now(), sort: 0, isFolder: 0, parentId: 0, deleted: 0 })
}
function today0 () {
  const d = new Date(); d.setHours(0, 0, 0, 0); return +d
}

test('addTodo idempotency: a second addTodo with the same rid + same dayStart returns the existing instance', () => {
  process.env.TODO_DB_DIR = tmpDir()
  const db = require_('../src/main/db.js')
  const lib = require_('../cli/lib.js')
  db.init(process.env.TODO_DB_DIR)
  seedDefaultCat(db)
  const rid = 'rid_t1'
  const day = today0() + 86400000 * 2
  const r1 = lib.addTodo({ content: 'A', date: day, category: 0, repeatId: rid })
  const r2 = lib.addTodo({ content: 'A', date: day, category: 0, repeatId: rid })
  assert.equal(r1.taskId, r2.taskId, 'the second addTodo returns the existing instance taskId')
  const list = db.call('queryTodos', { deleted: 0, repeatId: rid })
  assert.equal(list.filter(t => t.dayStart === day).length, 1, 'the DB holds only 1 renewal instance')
})

test('addTodo idempotency: different dayStarts do not interfere with each other', () => {
  process.env.TODO_DB_DIR = tmpDir()
  const db = require_('../src/main/db.js')
  const lib = require_('../cli/lib.js')
  db.init(process.env.TODO_DB_DIR)
  seedDefaultCat(db)
  const rid = 'rid_t2'
  const t0 = today0()
  const r1 = lib.addTodo({ content: 'X', date: t0 + 86400000, category: 0, repeatId: rid })
  const r2 = lib.addTodo({ content: 'X', date: t0 + 86400000 * 2, category: 0, repeatId: rid })
  assert.notEqual(r1.taskId, r2.taskId)
  assert.equal(db.call('queryTodos', { deleted: 0, repeatId: rid }).length, 2)
})

test('addTodo idempotency: non-renewal scenarios (repeatId=null) are unaffected', () => {
  process.env.TODO_DB_DIR = tmpDir()
  const db = require_('../src/main/db.js')
  const lib = require_('../cli/lib.js')
  db.init(process.env.TODO_DB_DIR)
  seedDefaultCat(db)
  const today = today0()
  const a = lib.addTodo({ content: 'A', date: today, category: 0 })
  const b = lib.addTodo({ content: 'B', date: today, category: 0 })
  assert.notEqual(a.taskId, b.taskId, 'same-day tasks without repeatId do not affect each other')
  assert.equal(db.call('queryTodos', { deleted: 0, dayStartFrom: today, dayStartTo: today }).length, 2)
})

test('toggleComplete end-to-end: completing the last instance of a repeat group does not generate two renewals', () => {
  process.env.TODO_DB_DIR = tmpDir()
  const db = require_('../src/main/db.js')
  const lib = require_('../cli/lib.js')
  db.init(process.env.TODO_DB_DIR)
  seedDefaultCat(db)
  const rid = 'rid_e2e'
  const today = today0()
  db.call('setMeta', ['repeatRule:' + rid, JSON.stringify({ repeatType: '天', repeatInterval: 1, repeatDayCount: 30 })])
  db.call('upsert', {
    taskId: 'tid_only', userId: 1, taskContent: 'only', taskDescribe: '',
    complete: false, completedAt: 0, deletedAt: 0, delete: false,
    createTime: Date.now(), updateTime: Date.now(), syncTime: 0,
    scheduledAt: today, scheduledDay: today, remindAt: 0, sort: 0,
    priority: 0, deadlineTs: 0,
    important: 0, urgent: 0, status: 'add', version: 0, taskSort: 0,
    todoTime: today, estimate: 0, difficulty: 0,
    repeatId: rid, subtasks: null, image: null, files: null,
    categoryId: 0, dayStart: today, reminderTime: 0
  })
  lib.toggleComplete('only', true)
  const insts = db.call('queryTodos', { deleted: 0, repeatId: rid }).filter(x => x.dayStart !== today)
  assert.equal(insts.length, 1, 'the CLI renewal instance should be exactly 1 (not duplicated)')
})
