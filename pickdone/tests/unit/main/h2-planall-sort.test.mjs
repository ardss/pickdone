/* H2 fix #6 regression: planAll must include the sort column — the snapshot/restore round-trip
   previously dropped it and restore's ON CONFLICT upsert overwrote sort with 0.
   Run: node --test tests/unit/main/h2-planall-sort.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')

db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'h2-planall-')))

test('planAll rows carry sort; snapshot/restore round-trip preserves it', () => {
  const [a, b] = db.call('planAddMany', [
    { taskId: 'h2_pt', day: '2026-09-16', mm: '09:00', sort: 7 },
    { taskId: 'h2_pt', day: '2026-09-16', mm: '10:00', sort: 3 }
  ])
  const snap = db.call('planAll', {})
  const ra = snap.find(c => c.id === a)
  assert.ok('sort' in ra, 'planAll row must include the sort column')
  assert.equal(ra.sort, 7)
  assert.equal(snap.find(c => c.id === b).sort, 3)

  // simulate restore: re-upsert the same ids via planAddMany (ON CONFLICT path)
  db.call('planAddMany', snap.map(c => ({ ...c })))
  const after = db.call('planAll', {})
  assert.equal(after.find(c => c.id === a).sort, 7, 'sort must survive the snapshot/restore upsert')
  assert.equal(after.find(c => c.id === b).sort, 3)
})
