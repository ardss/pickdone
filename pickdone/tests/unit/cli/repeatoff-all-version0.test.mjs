/* repeatOff --all soft-delete regression (cli/lib.js): the batch soft-delete of future repeat
   instances must reset version to 0, same as deleteTodo (P3 2026-09-12). syncTodos excludes delete
   rows already acked with version > 0, so keeping the old version meant the deletion silently
   never propagated. Isolated temp DB via TODO_DB_DIR.
   Run: node --test tests/unit/cli/repeatoff-all-version0.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-repoff-'))
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const core = require_('../../../src/main/core/todo-core.js')

db.init(process.env.TODO_DB_DIR)

let _seq = 0
function seed (over = {}) {
  const now = Date.now() + (_seq++)
  const t = {
    complete: false, createTime: now, delete: false,
    reminderTime: 0, reminderOffsets: [], reminderExtra: [], estimate: 0, difficulty: 0,
    repeatId: null, subtasks: null, image: null, files: null,
    categoryId: 0, updateTime: now, syncTime: 0,
    taskContent: '任务', taskDescribe: '',
    taskSort: 0, todoTime: 0, userId: 1, status: 'add', version: 0, ...over
  }
  if (!t.taskId) t.taskId = core.genTaskId(1, now)
  db.call('upsert', t)
  return db.call('getById', t.taskId)
}

test('repeatOff --all: soft-deleted repeat instances carry version 0 so syncTodos re-sends the deletion', () => {
  const rid = 'repeat_test_rid_1'
  const head = seed({ taskContent: 'repeatOff头任务', repeatId: rid, todoTime: Date.now(), status: 'sync', version: 3 })
  const future = seed({ taskContent: 'repeatOff未来实例', repeatId: rid, todoTime: Date.now() + 864e5, status: 'sync', version: 5 })
  lib.repeatOff(head.taskId, true)
  const after = db.call('getById', future.taskId)
  assert.equal(after.delete, true)
  assert.equal(after.status, 'delete')
  assert.equal(after.version, 0, 'delete row must reset version to 0 or syncTodos will never propagate it')
})
