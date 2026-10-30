/**
 * W7 CLI consistency round (2026-10-23):
 *   W7-1 [P1] `done --undo` renewal-instance removal uses the shared createTime >= completedAt
 *         discriminator (shared/repeat-undo-core.mjs, renderer repeatUndo.js parity with the
 *         2026-10-09 P1 root fix): a `repeat on` PRE-GENERATED future instance (createTime set
 *         BEFORE the completion) is no longer soft-deleted by undoing the completion. Legacy rows
 *         without createTime/completedAt keep the old day-only behavior (documented downgrade).
 *   W7-2 [P3] `purge` GCs orphaned `repeatRule:<rid>` meta: a rule whose last reference was purged
 *         dies with the group; a rule still referenced by a live row survives (computeMetaGc parity,
 *         src/main/handlers/shared.js — repeatRule keys to LIVE rows only, recycle-bin rows do not
 *         keep a rule alive).
 *   W7-3 [P3, verification only] removeRenewedInstance (renderer) does no content comparison after
 *         the discriminator — design decision, recorded in the fix report, no test.
 * Isolated temp DB via TODO_DB_DIR, never touches real data (f3-cli-consistency pattern).
 * Run: node --test tests/unit/main/w7-cli-consistency.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-cli-w7-')
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const core = require_('../../../src/main/core/todo-core.js')
const dayjs = require_('dayjs')

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

const today9 = () => +dayjs().hour(9).minute(0).second(0).millisecond(0)
const tomorrow9 = () => +dayjs().add(1, 'day').hour(9).minute(0).second(0).millisecond(0)

/* ---------------- W7-1: undo keeps a `repeat on` pre-generated future instance ---------------- */

test('w7-1: undo does NOT delete a pre-generated next instance whose createTime predates completedAt', () => {
  const rid = 'repeat_w7pre1'
  const t = seed({ taskContent: 'w7撤销预生成', repeatId: rid, todoTime: today9(), dayStart: +dayjs().startOf('day') })
  // `repeat on` pre-generated the next instance BEFORE the completion → its createTime is older
  db.call('setMeta', ['repeatRule:' + rid, JSON.stringify({ ...core.REPEAT_DEFAULTS, repeatType: 'day', repeatInterval: 1 })])
  const pre = seed({
    taskContent: 'w7撤销预生成', repeatId: rid,
    todoTime: tomorrow9(), dayStart: +dayjs().add(1, 'day').startOf('day'),
    taskSort: 512, createTime: Date.now() - 60000
  })
  const { renewed } = lib.toggleComplete(t.taskId, true)
  assert.equal(renewed, null, 'a pre-generated next instance means the completed row is not the group last — no renewal fires')
  const completedAt = db.call('getById', t.taskId).completedAt
  assert.ok(completedAt > pre.createTime, 'precondition: the pre-generated instance predates the completion')
  lib.toggleComplete(t.taskId, false) // done --undo
  const after = db.call('getById', pre.taskId)
  assert.ok(!after.delete, 'the PRE-GENERATED future instance survives the undo (old day-only heuristic soft-deleted it and cascaded its chips)')
  const undone = db.call('getById', t.taskId)
  assert.equal(undone.complete, false, 'the completed row itself is still unchecked')
})

test('w7-1b: undo still removes a genuine renewal instance (createTime >= completedAt) — no regression', () => {
  const rid = 'repeat_w7renew1'
  const t = seed({ taskContent: 'w7撤销真续期', repeatId: rid, todoTime: today9(), dayStart: +dayjs().startOf('day') })
  db.call('setMeta', ['repeatRule:' + rid, JSON.stringify({ ...core.REPEAT_DEFAULTS, repeatType: 'day', repeatInterval: 1 })])
  const { renewed } = lib.toggleComplete(t.taskId, true)
  assert.ok(renewed && !renewed.delete, 'renewal minted')
  lib.toggleComplete(t.taskId, false)
  const after = db.call('getById', renewed.taskId)
  assert.ok(after.delete, 'the renewal instance is soft-deleted with the undo as before')
  assert.equal(after.version, 0, 'version reset to 0 so the soft delete re-enters the sync snapshot')
})

test('w7-1c: legacy rows without createTime keep the old day-only downgrade (removal preserved)', () => {
  const rid = 'repeat_w7legacy1'
  const t = seed({ taskContent: 'w7遗留行', repeatId: rid, todoTime: today9(), dayStart: +dayjs().startOf('day') })
  db.call('setMeta', ['repeatRule:' + rid, JSON.stringify({ ...core.REPEAT_DEFAULTS, repeatType: 'day', repeatInterval: 1 })])
  const { renewed } = lib.toggleComplete(t.taskId, true)
  assert.ok(renewed, 'renewal minted')
  // strip createTime/completedAt to simulate legacy data
  const legacy = { ...db.call('getById', renewed.taskId), createTime: 0 }
  db.call('upsert', legacy)
  db.call('upsert', { ...db.call('getById', t.taskId), completedAt: 0, complete: true })
  lib.toggleComplete(t.taskId, false)
  assert.ok(db.call('getById', renewed.taskId).delete,
    'legacy rows without createTime/completedAt fall back to the day-only heuristic (documented downgrade)')
})

/* ---------------- W7-2: purge GCs orphaned repeatRule meta ---------------- */

test('w7-2: purge deletes the repeatRule meta of a fully-purged group and keeps a still-referenced rule', () => {
  const ridOrphan = 'repeat_w7orphan'
  const ridShared = 'repeat_w7shared'
  db.call('setMeta', ['repeatRule:' + ridOrphan, JSON.stringify({ ...core.REPEAT_DEFAULTS, repeatType: 'day', repeatInterval: 1 })])
  db.call('setMeta', ['repeatRule:' + ridShared, JSON.stringify({ ...core.REPEAT_DEFAULTS, repeatType: 'day', repeatInterval: 1 })])
  // orphan group: every row gets purged
  const victim = seed({ taskContent: 'w7孤儿规则', repeatId: ridOrphan })
  // shared rule: a live row survives the purge and still references it
  seed({ taskContent: 'w7共享规则-存活', repeatId: ridShared })
  const victim2 = seed({ taskContent: 'w7共享规则-清除', repeatId: ridShared })
  lib.deleteTodo(victim.taskId)
  lib.deleteTodo(victim2.taskId)
  lib.purgeRecycleBin()
  assert.ok(db.call('getMeta', 'repeatRule:' + ridOrphan) == null,
    'the orphaned rule meta is deleted when its last referencing row was purged')
  assert.ok(db.call('getMeta', 'repeatRule:' + ridShared) != null,
    'a rule still referenced by a live row survives the purge')
})
