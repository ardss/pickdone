/* QC Round-3 P1 regression tests (2026-09-21, fix/round3-p1) — CLI data lifecycle:
 *   F8  `project <name> --off` also scrubs the id from the legacy `projectCategoryIds` blob
 *       (renderer rewriteLegacyProjectIdsWithout parity — the union reader resurrected it).
 *   F9  `category rm` backs project meta up into `catProjectMetaBak.<id>` BEFORE clearing the
 *       live keys (the UI recover path restores exactly this blob).
 *   F10 purge deletes attachment files only via the ownsAttachmentFile guard — a task whose id
 *       is a PREFIX of another task's id can no longer delete the other task's files.
 *   F11 chipsRestoreSnapshot clears the snapshot meta with deleteMeta (tombstone), not setMeta ''.
 *
 * Run: node --test tests/unit/cli/round3-cli-data-lifecycle.test.mjs
 */
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'module'
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-round3-cli-'))
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')

db.init(process.env.TODO_DB_DIR)

const metaGet = k => db.call('getMeta', k)
const metaSet = (k, v) => db.call('setMeta', [k, v])

let seq = 0
function seedRecycledTask (taskId) {
  const now = Date.now() + (seq++)
  db.call('upsert', {
    taskId, complete: false, createTime: now, delete: true, deletedAt: now, reminderTime: 0,
    reminderOffsets: [], estimate: 0, difficulty: 0, repeatId: null, subtasks: null, image: null,
    files: null, categoryId: 0, updateTime: now, syncTime: 0, taskContent: 'round3 ' + taskId,
    taskDescribe: '', taskSort: 0, todoTime: 0, userId: 1, status: 'delete', version: 0,
  })
}

/* ---------- F8: project --off legacy-blob scrub ---------- */

test('F8: unmarking a project scrubs the id from the legacy projectCategoryIds blob', () => {
  const cat = lib.addCategory('R3LegacyBlob')
  const id = String(cat.categoryId)
  // Simulate a stale legacy blob (old renderer/CLI write) that still carries the id.
  metaSet('projectCategoryIds', JSON.stringify([id, '999']))
  metaSet('projectCategoryFlag:' + id, '1')
  const r = lib.setProjectFlag('R3LegacyBlob', false)
  assert.equal(r.isProject, false)
  assert.equal(metaGet('projectCategoryFlag:' + id), null, 'flag key tombstoned')
  const arr = JSON.parse(metaGet('projectCategoryIds') || '[]')
  assert.ok(!arr.includes(id), 'the legacy blob must NOT keep the unset id (union reader would resurrect it)')
  assert.ok(arr.includes('999'), 'other legacy entries survive')
})

/* ---------- F9: category rm writes catProjectMetaBak.<id> ---------- */

test('F9: category rm backs up project meta before clearing the live keys', () => {
  const cat = lib.addCategory('R3Backup')
  const id = String(cat.categoryId)
  metaSet('projectCategoryFlag:' + id, '1')
  metaSet('projectStatus:' + id, 'paused')
  metaSet('projectDeadline:' + id, '1735689600000')
  metaSet('projectMilestones:' + id, JSON.stringify([{ id: 'ms1', title: 'MVP', date: 1735689600000, taskIds: [] }]))

  const r = lib.deleteCategory('R3Backup')
  assert.equal(r.deleted.length, 1)

  const bak = JSON.parse(metaGet('catProjectMetaBak.' + id) || 'null')
  assert.ok(bak, 'backup blob written')
  assert.equal(bak.flag, true)
  assert.equal(bak.status, 'paused')
  assert.equal(bak.deadline, '1735689600000')
  assert.ok(String(bak.milestones).includes('MVP'), 'milestones are in the backup')
  // live keys are cleared AFTER the backup (recover restores into empty keys)
  assert.equal(metaGet('projectCategoryFlag:' + id), null)
  assert.equal(metaGet('projectStatus:' + id), null)
  assert.equal(metaGet('projectDeadline:' + id), null)
  assert.equal(metaGet('projectMilestones:' + id), null)
})

test('F9: deleting a NON-project category writes no backup blob', () => {
  const cat = lib.addCategory('R3PlainCat')
  lib.deleteCategory('R3PlainCat')
  assert.equal(metaGet('catProjectMetaBak.' + cat.categoryId), null, 'nothing to back up → no blob')
})

/* ---------- F10: purge attachment ownership guard ---------- */

test('F10: purging a task whose id is a PREFIX of another id leaves the other task\'s files', () => {
  seedRecycledTask('r3a') // only 'r3a' is purged; 'r3a_b' is a LIVE task (never in the bin)
  const filesDir = path.join(process.env.TODO_DB_DIR, 'files')
  fs.mkdirSync(filesDir, { recursive: true })
  const ts = Date.now()
  const mine = `r3a_${ts}_mine.png`
  const other = `r3a_b_${ts}_other.png`
  fs.writeFileSync(path.join(filesDir, mine), 'x')
  fs.writeFileSync(path.join(filesDir, other), 'y')
  try {
    lib.purgeRecycleBin()
    assert.ok(!fs.existsSync(path.join(filesDir, mine)), 'the purged task\'s own file is deleted')
    assert.ok(fs.existsSync(path.join(filesDir, other)), 'prefix collision: the OTHER task\'s file survives (timestamp-segment ownership)')
  } finally {
    try { fs.rmSync(path.join(filesDir, other)) } catch { /* test cleanup */ }
  }
})

/* ---------- F11: chipsRestoreSnapshot deleteMeta ---------- */

test('F11: chipsRestoreSnapshot removes the snapshot meta row (deleteMeta, not setMeta \'\')', () => {
  const taskId = 'r3chips1'
  const now = Date.now()
  db.call('upsert', {
    taskId, complete: false, createTime: now, delete: true, deletedAt: now, reminderTime: 0,
    reminderOffsets: [], estimate: 0, difficulty: 0, repeatId: null, subtasks: null, image: null,
    files: null, categoryId: 0, updateTime: now, syncTime: 0, taskContent: 'chips r3',
    taskDescribe: '', taskSort: 0, todoTime: 0, userId: 1, status: 'delete', version: 0,
  })
  metaSet('planChipsSnapshot:' + taskId, JSON.stringify([{ id: 'c1', content: 'chip' }]))
  lib.chipsRestoreSnapshot(taskId)
  assert.equal(metaGet('planChipsSnapshot:' + taskId), null, 'the meta row is GONE (a tombstone), not an empty string')
})
