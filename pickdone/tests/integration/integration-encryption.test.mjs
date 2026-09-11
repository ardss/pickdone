/**
 * Database encryption integration tests — key generation/readable after restart/auto migration of an existing plaintext DB/header is genuinely not plaintext SQLite.
 * Run: npm test
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-enc-'))
const require_ = createRequire(import.meta.url)
const db = require_('../../src/main/db.js')


test('encryption: first launch generates the key file, write/read round trip, header is not plaintext SQLite', () => {
  db.init(process.env.TODO_DB_DIR)
  assert.ok(fs.existsSync(path.join(process.env.TODO_DB_DIR, 'db.key')))
  db.call('upsert', {
    taskId: 'enc1', userId: 1, taskContent: '加密测试', taskDescribe: '', complete: false,
    completedAt: 0, deleted: false, deletedAt: 0, createdAt: 1, updatedAt: 1,
    syncTime: 0, scheduledAt: 0, scheduledDay: 0, remindAt: 0, sort: 0,
    focusMinutes: 0, difficulty: 0, recurGroupId: null, subtasks: null,
    imageUrls: null, fileAttach: null, categoryId: 0, priority: 0, deadlineTs: 0,
    status: 'add', version: 0
  })
  const raw = fs.readFileSync(path.join(process.env.TODO_DB_DIR, 'todos.db'))
  assert.ok(!raw.slice(0, 15).toString().startsWith('SQLite format'), 'file header must not be plaintext SQLite')
})

test('encryption: data readable after reopening the connection (simulated restart)', () => {
  db.init(process.env.TODO_DB_DIR)
  const row = db.call('getById', 'enc1')
  assert.equal(row.taskContent, '加密测试')
})

test('encryption: existing plaintext DB (no key file + has data) migrates automatically with data preserved', () => {
  // Build the plaintext DB with the current schema (the v0.0 snake_case migration was removed with the "no existing users" decision)
  const Database = require_('../../vendor/better-sqlite3-multiple-ciphers')
  const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-legacy-'))
  const legacy = new Database(path.join(legacyDir, 'todos.db'))
  legacy.exec(db.SCHEMA)
  legacy.prepare('INSERT INTO todos (id, content, scheduledDay, scheduledAt, createdAt, updatedAt) VALUES (?,?,?,?,?,?)')
    .run('old1', '老用户数据', 1787846400000, 1787846400000, 1, 1)
  legacy.close()

  // Copy the plaintext DB into a new directory without the key file -> triggers the migration path
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-mig-'))
  for (const f of ['todos.db']) fs.copyFileSync(path.join(legacyDir, f), path.join(dir2, f))
  process.env.TODO_DB_DIR = dir2
  db.init(dir2)
  const row = db.call('getById', 'old1')
  assert.equal(row.taskContent, '老用户数据', 'data must be readable after migration')
  assert.ok(fs.existsSync(path.join(dir2, 'db.key')), 'a key file must be generated after migration')
  assert.ok(fs.existsSync(path.join(dir2, 'todos.db.plain-bak')), 'the plaintext original must be kept as a fallback')
  const raw = fs.readFileSync(path.join(dir2, 'todos.db'))
  assert.ok(!raw.slice(0, 15).toString().startsWith('SQLite format'), 'the file must be encrypted after migration')
})
