/**
 * maint/d26b fixer round (CLI):
 *  - F5 `task restore` re-stamps the restored schedule chips' updatedAt (renderer twin:
 *    renderer/js/utils/dayPlans.js restoreSnapshot). The snapshot rows carried their PRE-DELETE
 *    updatedAt (planAddMany preserves explicit stamps) while the delete stamped a FRESH tombstone
 *    — over LAN, newer peer chip-tombstones won every LWW round and the restored chips were
 *    silently re-deleted.
 *  - F6 `tomato record fix --task/--free` syncs the denormalized `focus` name text in the SAME
 *    write (renderer twin: store/tomato.js updateRecordTask, D15-B14) — the old rebind left the
 *    previous task's name stale on every surface that reads rec.focus.
 * Run: node --test tests/unit/cli/fixer-d26b-cli-restore-focus.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-cli-d26b-')
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
    taskContent: 'd26b task', taskDescribe: '',
    taskSort: 0, todoTime: 0, userId: 1, status: 'add', version: 0, ...over
  }
  if (!t.taskId) t.taskId = core.genTaskId(1, now)
  db.call('upsert', t)
  return db.call('getById', t.taskId)
}

test('[F5] restore re-stamps restored chips: updatedAt >= the delete stamp, not the pre-delete age', () => {
  const t = seed({ taskContent: 'd26b chips restore', todoTime: +require_('dayjs')('2026-10-08').valueOf() })
  const added = db.call('planAddMany', [{ taskId: t.taskId, day: '2026-10-08', mm: '09:00' }])
  assert.ok(added && added.length, 'chip seeded')
  const preDelete = db.call('planAll', []).find(r => r.taskId === t.taskId)
  assert.ok(preDelete.updatedAt > 0 && preDelete.updatedAt <= Date.now())
  // let the pre-delete stamp age visibly behind the delete
  const deletedRow = lib.deleteTodo(t.taskId)
  const restored = lib.restoreTodo(t.taskId)
  assert.ok(restored, 'restore succeeds')
  const chip = db.call('planAll', []).find(r => r.taskId === t.taskId)
  assert.ok(chip, 'chip is back after restore')
  assert.ok(chip.updatedAt >= deletedRow.deletedAt,
    'red before the fix: the restored chip carried its PRE-DELETE updatedAt and lost every LWW round against newer peer tombstones')
  assert.ok(chip.updatedAt > preDelete.updatedAt, 'the re-stamp is strictly newer than the pre-delete age')
})

test('[F6] record fix --task rebinds focusTaskId AND the denormalized focus name in the same write', () => {
  const a = seed({ taskContent: 'd26b task A' })
  const b = seed({ taskContent: 'd26b task B' })
  const rec = lib.backfillRecord({ taskId: a.taskId, content: a.taskContent, date: '2026-10-08', at: '09:00', minutes: 25 })
  assert.equal(rec.focus, a.taskContent, 'backfill names the original task')
  const fixed = lib.recordFix(rec.tomatoId, { task: b.taskId })
  assert.equal(fixed.rec.focusTaskId, b.taskId)
  assert.equal(fixed.rec.focus, b.taskContent, 'red before the fix: the old task A name stayed stale in the row')
  // the DB row (not just the return shape) carries the new name
  const row = lib.resolveRecord(rec.tomatoId)
  assert.equal(row.focus, b.taskContent, 'the ledger row itself was rewritten with the new name')
})

test('[F6] record fix --free clears focusTaskId and the focus name', () => {
  const a = seed({ taskContent: 'd26b task C' })
  const rec = lib.backfillRecord({ taskId: a.taskId, content: a.taskContent, date: '2026-10-08', at: '10:00', minutes: 25 })
  const fixed = lib.recordFix(rec.tomatoId, { free: true })
  assert.equal(fixed.rec.focusTaskId, null)
  assert.equal(fixed.rec.focus, '', 'red before the fix: the stale task name survived the unbind')
  assert.equal(lib.resolveRecord(rec.tomatoId).focus, '', 'the DB row agrees')
})
