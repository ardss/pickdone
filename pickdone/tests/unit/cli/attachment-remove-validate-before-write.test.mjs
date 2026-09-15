/* removeAttachment validate-before-write (cli/lib-attachments.cjs): an attachment whose url does not
   resolve to a file key must fail with ATTACH_KEY_INVALID BEFORE the row is patched — previously the
   row was mutated first (attachment dropped from the JSON) and only then the command errored, so a
   retry hit ATTACH_NOT_FOUND with the row already changed. Isolated temp DB via TODO_DB_DIR.
   Run: node --test tests/unit/cli/attachment-remove-validate-before-write.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-attach-'))
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

test('removeAttachment: unresolvable url → ATTACH_KEY_INVALID and the row is left untouched', () => {
  const badItem = { url: '', name: 'ghost.png', size: 1 }
  const goodItem = { url: 'local://real.png', name: 'real.png', size: 2 }
  const t = seed({ image: JSON.stringify([badItem, goodItem]) })
  assert.throws(
    () => lib.removeAttachment(t.taskId, 'img', 1),
    e => e.code === 'ATTACH_KEY_INVALID'
  )
  const after = db.call('getById', t.taskId)
  assert.equal(after.image, JSON.stringify([badItem, goodItem]), 'row must not be mutated when key resolution fails')
})

test('removeAttachment: valid url still removes the entry and reports the name', () => {
  const good = { url: 'local://keep.png', name: 'keep.png', size: 3 }
  const t = seed({ image: JSON.stringify([good]) })
  const out = lib.removeAttachment(t.taskId, 'img', 1)
  assert.equal(out.removed, 'keep.png')
  const after = db.call('getById', t.taskId)
  assert.equal(after.image, '[]')
})
