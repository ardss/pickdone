/**
 * D21-DOMB plan-chip regressions (src/main/db-plan-ops.js):
 *  [B7] planUpdateChip is a no-op (return false, no updatedAt re-stamp) when day/mm do not change —
 *       the unconditional UPDATE re-stamped identical writes and minted a phantom oplog delta per call
 *  [B8] planAddMany re-mints colliding ids (same-ms mint used to let the ON CONFLICT upsert MOVE an
 *       unrelated chip onto the colliding id — D20 category-mint parity, cli/lib-categories.cjs)
 * Run: node --test tests/unit/main/d21-domb-plan-ops.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')

db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'd21-planops-')))

test('B7: planUpdateChip on identical day/mm returns false and does NOT re-stamp updatedAt', () => {
  const [id] = db.call('planAddMany', [{ taskId: 'd21_b7', day: '2026-10-02', mm: '09:00', sort: 1 }])
  const before = db.call('planAll', {}).find(c => c.id === id)
  assert.equal(db.call('planUpdateChip', { id, day: '2026-10-02', mm: '09:00' }), false, 'identical write is a no-op')
  const after = db.call('planAll', {}).find(c => c.id === id)
  assert.equal(after.updatedAt, before.updatedAt, 'no-op leaves the LWW stamp untouched (no oplog delta)')
  assert.ok(db.call('planUpdateChip', { id, day: '2026-10-03', mm: '10:30' }), 'a real change still returns true')
  const moved = db.call('planAll', {}).find(c => c.id === id)
  assert.equal(moved.day, '2026-10-03')
  assert.equal(moved.mm, '10:30')
  assert.ok(moved.updatedAt > before.updatedAt, 'a real change re-stamps')
})

test('B7: planUpdateChip on a missing/deleted chip returns false (no ghost stamp)', () => {
  assert.equal(db.call('planUpdateChip', { id: 'pl_never', day: '2026-10-02', mm: '09:00' }), false)
})

test('B8: planAddMany ids are unique within one batch and never reuse a stored id', () => {
  const ids = db.call('planAddMany', [
    { taskId: 'd21_b8', day: '2026-10-02', mm: '08:00' },
    { taskId: 'd21_b8', day: '2026-10-02', mm: '09:00' },
    { taskId: 'd21_b8', day: '2026-10-02', mm: '10:00' }
  ])
  assert.equal(new Set(ids).size, ids.length, 'same-ms batch mints never collapse onto one id')
  const rows = db.call('planAll', {}).filter(c => c.taskId === 'd21_b8')
  assert.equal(rows.length, 3, 'no chip was silently MOVED onto a colliding id by the ON CONFLICT upsert')
  assert.equal(new Set(rows.map(r => r.mm)).size, 3, 'all three distinct time slots survived')
})
