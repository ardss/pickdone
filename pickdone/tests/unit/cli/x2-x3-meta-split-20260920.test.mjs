/* X2/X3 regression tests (per-task tomato estimate keys + per-category project flags, 2026-09-20).
 * X2 contract: `tomatoEstimateState:<taskId>` = plain integer string; legacy whole-doc blob
 *   `tomatoEstimateState` lazily migrated on first write (emit per-task keys, deleteMeta legacy);
 *   readers fall back to the legacy blob only on a per-task miss.
 * X3 contract: `projectCategoryFlag:<categoryId>` = '1' (set = setMeta, unmark = deleteMeta);
 *   readers union the legacy `projectCategoryIds` array with the flags.
 * Run: node --test tests/unit/cli/x2-x3-meta-split-20260920.test.mjs
 */
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'module'
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-x2x3-'))
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')

db.init(process.env.TODO_DB_DIR)

let seq = 0
function seedTask (over = {}) {
  const now = Date.now() + (seq++)
  const t = {
    taskId: 'tid_x_' + seq, complete: false, createTime: now, delete: false, reminderTime: 0,
    reminderOffsets: [], estimate: 0, difficulty: 0, repeatId: null, subtasks: null, image: null,
    files: null, categoryId: 0, updateTime: now, syncTime: 0, taskContent: 'x2 task',
    taskDescribe: '', taskSort: 0, todoTime: 0, userId: 1, status: 'add', version: 0, ...over
  }
  db.call('upsert', t)
  return t
}

const metaGet = k => db.call('getMeta', k)

/* ---------- X2: per-task tomato estimate keys ---------- */

test('X2: CLI set estimate writes per-task key (plain integer string), not the legacy blob', () => {
  const t = seedTask()
  const r = lib.setEstimate(String(t.taskId), 7)
  assert.equal(r.tomatoEstimate, 7)
  assert.equal(metaGet('tomatoEstimateState:' + t.taskId), '7', 'per-task key = plain integer string')
  assert.equal(metaGet('tomatoEstimateState'), null, 'legacy whole-doc blob is not written anymore')
})

test('X2: first write lazily migrates the legacy blob to per-task keys and deletes the legacy key', () => {
  const t = seedTask()
  // Simulate pre-migration state written by an old CLI/renderer: whole-doc blob.
  db.call('setMeta', ['tomatoEstimateState', JSON.stringify({ [t.taskId]: 5, 'legacy-other': 3 })])
  const r = lib.setEstimate(String(t.taskId), 9)
  assert.equal(r.tomatoEstimate, 9)
  assert.equal(metaGet('tomatoEstimateState:' + t.taskId), '9', 'touched task gets its fresh per-task key')
  assert.equal(metaGet('tomatoEstimateState:legacy-other'), '3', 'untouched legacy entries are fanned out to per-task keys')
  assert.equal(metaGet('tomatoEstimateState'), null, 'legacy blob key is deleteMeta-d after migration (sync tombstone)')
})

test('X2: reader falls back to the legacy blob only when the per-task key is absent', () => {
  const t = seedTask()
  db.call('setMeta', ['tomatoEstimateState', JSON.stringify({ [t.taskId]: 4 })])
  assert.equal(lib.getEstimateOf(String(t.taskId)), 4, 'legacy fallback answers on per-task miss')
  db.call('setMeta', ['tomatoEstimateState:' + t.taskId, '6'])
  assert.equal(lib.getEstimateOf(String(t.taskId)), 6, 'per-task key wins over the legacy blob')
})

test('X2: clearing an estimate deleteMeta-s the per-task key (tombstone, not empty string)', () => {
  const t = seedTask()
  lib.setEstimate(String(t.taskId), 3)
  lib.setEstimate(String(t.taskId), 0)
  assert.equal(metaGet('tomatoEstimateState:' + t.taskId), null, 'cleared = key deleted')
})

/* ---------- X3: per-category project flags ---------- */

test('X3: marking a project writes flag key projectCategoryFlag:<id> = \'1\' and leaves the legacy array alone', () => {
  const c = lib.addCategory('X3Proj')
  lib.setProjectFlag(c.categoryId, true)
  assert.equal(metaGet('projectCategoryFlag:' + c.categoryId), '1')
  assert.equal(metaGet('projectCategoryIds'), null, 'legacy whole-doc array is no longer written')
  assert.ok(lib.getProjects().some(p => String(p.categoryId) === String(c.categoryId)))
})

test('X3: unmarking deleteMeta-s the flag key', () => {
  const c = lib.addCategory('X3Unmark')
  lib.setProjectFlag(c.categoryId, true)
  lib.setProjectFlag(c.categoryId, false)
  assert.equal(metaGet('projectCategoryFlag:' + c.categoryId), null)
  assert.equal(lib.getProjects().some(p => String(p.categoryId) === String(c.categoryId)), false)
})

test('X3: legacy whole-doc array is still honored (union read fallback)', () => {
  const c = lib.addCategory('X3Legacy')
  db.call('setMeta', ['projectCategoryIds', JSON.stringify([c.categoryId])])
  assert.ok(lib.getProjectIds().includes(String(c.categoryId)), 'legacy array ids surface via the union reader')
  assert.ok(lib.getProjects().some(p => String(p.categoryId) === String(c.categoryId)), 'legacy-only project still lists')
  // Mixed state: flags + legacy ids are unioned, no clobber either way.
  const c2 = lib.addCategory('X3Mixed')
  lib.setProjectFlag(c2.categoryId, true)
  const ids = lib.getProjectIds()
  assert.ok(ids.includes(String(c.categoryId)) && ids.includes(String(c2.categoryId)))
})
