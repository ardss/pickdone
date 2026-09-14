/** F1-round CLI fixes regression tests (pickdone/cli/lib.js / import.js), isolated temp DB via
 *  TODO_DB_DIR — never touches real data (f6-cli-round6-fixes pattern).
 *  Run: node --test tests/unit/cli/f1-round-cli-fixes.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-f1-'))
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

/* ---------- Fix 1: restore spends the one-shot chips snapshot only after the row write succeeds ---------- */
test('fix1: restoreTodo writes the row BEFORE consuming the snapshot (upsert failure keeps the snapshot spendable)', () => {
  const t = seed({ taskContent: 'f1快照任务', delete: true, deletedAt: Date.now(), status: 'delete' })
  const chips = [{ taskId: t.taskId, day: '2026-09-15', mm: '10:00' }]
  db.call('setMeta', ['planChipsSnapshot:' + t.taskId, JSON.stringify(chips)])
  // Force the upsert to throw (mid-way failure): the old first-line snapshot consumption permanently
  // destroyed the snapshot before the failure surfaced
  const origCall = db.call
  db.call = function (op, ...args) {
    if (op === 'upsert') throw new Error('simulated upsert failure')
    return origCall.call(db, op, ...args)
  }
  try {
    assert.throws(() => lib.restoreTodo('f1快照任务'), /simulated upsert failure/)
  } finally {
    db.call = origCall
  }
  const raw = db.call('getMeta', 'planChipsSnapshot:' + t.taskId)
  assert.ok(raw && raw.length, 'snapshot meta must survive a failed restore (old code consumed it first)')
  // Now a retry succeeds and backfills the chips
  const after = lib.restoreTodo('f1快照任务')
  assert.equal(after.delete, false)
  assert.equal(db.call('getMeta', 'planChipsSnapshot:' + t.taskId), '', 'successful restore consumes the one-shot snapshot')
  const backfilled = db.call('planAll', []).filter(r => r.taskId === t.taskId)
  assert.equal(backfilled.length, chips.length, 'chips are backfilled on the successful path')
})

/* ---------- Fix 4: deleteTodo resets version to 0 so a re-delete re-enters the sync snapshot ---------- */
test('fix4: deleteTodo writes version:0 (syncTodos excludes acked delete rows with version > 0)', () => {
  const t = seed({ taskContent: 'f1删除任务', version: 7 })
  const after = lib.deleteTodo(String(t.taskId))
  assert.equal(after.delete, true)
  assert.equal(after.version, 0, 'deleted row must carry version:0, matching renderer deleteTodo (store/todo.js)')
  assert.equal(after.status, 'delete')
})
