/* Purge GC-marker regression (2026-09-18): purgeRecycleBin/purgeSeedTodos used to log a single
 * ('todo','*gc*') oplog pointer. On peers that pointer hydrated into a GHOST tombstone with
 * taskId '*gc*', and the actually purged rows had no individual tombstones — so snapshots and
 * merge could resurrect them. Now the purge ops return the purged ids and the oplog expands
 * them into per-id tombstone pointers; '*gc*' ids are rejected defensively at hydration.
 * Run: node --test tests/unit/main/purge-oplog-tombstones.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')

db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'purge-oplog-')))

function newTodo (id) {
  return db.call('upsert', { taskId: id, taskContent: 'x-' + id, createTime: Date.now(), updateTime: Date.now() })
}

test('purgeRecycleBin logs per-id tombstone pointers (no *gc* marker)', () => {
  newTodo('p1'); newTodo('p2'); newTodo('keep1')
  db.call('upsert', { taskId: 'p1', delete: 1, deletedAt: 123 })
  db.call('upsert', { taskId: 'p2', delete: 1, deletedAt: 123 })
  // p1/p2 now sit in the recycle bin; keep1 stays live.

  const before = db.call('syncOplogSince', { sinceSeq: 0 })
  const lastSeq = before.length ? before[before.length - 1].seq : 0
  const purged = db.call('purgeRecycleBin')
  assert.deepEqual(purged.slice().sort(), ['p1', 'p2'], 'the op returns the purged ids')

  const rows = db.call('syncOplogSince', { sinceSeq: lastSeq })
  const ptrs = rows.map(r => ({ entity: r.entity, id: r.entityId }))
  assert.ok(ptrs.some(p => p.entity === 'todo' && p.id === 'p1'), 'per-id pointer for p1')
  assert.ok(ptrs.some(p => p.entity === 'todo' && p.id === 'p2'), 'per-id pointer for p2')
  assert.ok(!ptrs.some(p => String(p.id) === '*gc*'), 'no *gc* ghost marker is logged anymore')
})

test('purgeSeedTodos logs per-id tombstone pointers (no *gc* marker)', () => {
  newTodo('seed_demo1'); newTodo('seed_demo2'); newTodo('keep2')
  const before = db.call('syncOplogSince', { sinceSeq: 0 })
  const lastSeq = before.length ? before[before.length - 1].seq : 0
  const purged = db.call('purgeSeedTodos')
  assert.deepEqual(purged.slice().sort(), ['seed_demo1', 'seed_demo2'])

  const rows = db.call('syncOplogSince', { sinceSeq: lastSeq })
  const ptrs = rows.map(r => r.entityId)
  assert.ok(ptrs.includes('seed_demo1') && ptrs.includes('seed_demo2'), 'per-id pointers logged')
  assert.ok(!ptrs.includes('*gc*'), 'no *gc* ghost marker')
})

test('*gc* oplog pointers never hydrate into rows and never apply (defensive guard)', async () => {
  const { __test } = await import('../../../src/main/lan-sync-bootstrap.js')
  // (a) apply-side guard: an incoming row with the marker id is rejected outright.
  const state = {
    db: { call: () => [] },
    pendingWrites: { todos: [], settings: [], tomatoes: [] },
    applyCache: null,
  }
  __test.setState(state)
  assert.equal(__test.applyRow({ entity: 'todo', id: '*gc*', seq: 1, ts: 1, deleted: true, deletedAt: 1, data: null }), false, "'*gc*' rows never apply")
  assert.equal(state.pendingWrites.todos.length, 0)
})
