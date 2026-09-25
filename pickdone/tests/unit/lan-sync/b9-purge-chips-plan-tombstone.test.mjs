/* B9 (2026-09-26): emptying the recycle bin (or purging seed todos) physically DELETEs the
 * tasks' plan_chips, but the oplog captured only per-id TODO tombstones — no plan tombstone
 * ever existed for the deleted chips, so a peer that still held those chips live re-applied
 * them to the purging device via LWW (ghost chips of purged todos, resurrected on every peer).
 * Now the purge captures the doomed chip ids INSIDE its transaction (they are physically gone
 * by oplog-expansion time) and the oplog expands them into per-chip ('plan', id) tombstone
 * pointers; a peer lands them through the existing planRemoveIds tombstone apply path.
 * Two fresh-db nodes via TODO_USER_DATA_DIR/TODO_DB_DIR temp dirs — the real %APPDATA% is
 * never touched.
 * Run: node --test tests/unit/lan-sync/b9-purge-chips-plan-tombstone.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'b9-purge-chips-'))
process.env.TODO_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'b9-purge-chips-ud-'))

const db = require_('../../../src/main/db.js')
const { __test } = require_('../../../src/main/lan-sync-bootstrap.js')

const dirA = fs.mkdtempSync(path.join(os.tmpdir(), 'b9-node-a-'))
const dirB = fs.mkdtempSync(path.join(os.tmpdir(), 'b9-node-b-'))

function chipOn (dir, id, taskId) {
  db.init(dir)
  const r = db.call('planAddMany', [{ id, taskId, day: '2026-09-26', mm: '09:00', updatedAt: 100 }])
  return r && r[0]
}

test('B9: purgeRecycleBin logs per-chip plan tombstone pointers, and a peer holding the chip live lands the deletion', () => {
  /* --- node A: todo + chip, then empty the recycle bin --- */
  db.init(dirA)
  db.call('upsert', { taskId: 't1', taskContent: 'chipped task', createTime: 1, updateTime: 1 })
  const landed = chipOn(dirA, 'chip1', 't1')
  assert.equal(landed, 'chip1', 'chip exists on node A')
  db.call('upsert', { taskId: 't1', delete: 1, deletedAt: 123 })

  const before = db.call('syncOplogSince', { sinceSeq: 0 })
  const lastSeq = before.length ? before[before.length - 1].seq : 0
  const purged = db.call('purgeRecycleBin')
  assert.deepEqual(purged.slice().sort(), ['t1'], 'the op still returns the purged TODO ids (shape preserved)')

  const ptrs = db.call('syncOplogSince', { sinceSeq: lastSeq })
  const planPtr = ptrs.find(p => p.entity === 'plan' && p.entityId === 'chip1')
  assert.ok(planPtr, 'THE FIX: a per-chip (plan, chip1) tombstone pointer must be logged (fails on pre-fix code)')
  assert.ok(ptrs.some(p => p.entity === 'todo' && p.entityId === 't1'), 'per-id todo pointer still logged')
  assert.equal(db.call('planAll').length, 0, 'the chip is physically gone on the purging node')

  /* --- node B: same task + chip still LIVE (its purge pointer not yet seen) --- */
  db.init(dirB)
  db.call('upsert', { taskId: 't1', taskContent: 'chipped task', createTime: 1, updateTime: 1 })
  chipOn(dirB, 'chip1', 't1')
  assert.equal(db.call('planAll').length, 1, 'node B still holds the chip live')
  assert.equal(db.call('planTombstones').length, 0)

  // Pipe node A's captured plan pointer through the real sync-apply into node B. Hydration on
  // A (the sender) yields exactly this row shape: A's chip row is physically gone, so the
  // pointer hydrates as a data-less tombstone stamped with the pointer's ts (see hydrateRow's
  // `if (!p) return { ...base, deleted: true, deletedAt: ptr.ts, data: null }`).
  const state = {
    deviceId: 'node-B',
    localUserId: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    db: { call: (op, p) => db.call(op, p) },
    applyCache: null,
  }
  __test.setState(state)
  const ok = __test.applyRow({
    entity: 'plan', id: 'chip1', seq: planPtr.seq, ts: planPtr.ts, updatedAt: planPtr.ts,
    deleted: true, deletedAt: planPtr.ts, data: null,
  })
  assert.equal(ok, true, 'the peer-side tombstone must apply (chip exists locally → not a ghost)')
  assert.ok(state.pendingWrites.plans.length === 0, 'the live chip must NOT be re-pushed as a plan write')
  assert.equal(db.call('planAll').length, 0, 'B\'s chip is deleted — the ghost-chip resurrection is closed')
  assert.equal(db.call('planTombstones').filter(t => String(t.id) === 'chip1').length, 1, 'the chip ends as a real tombstone (delete propagates further)')
})

test('B9: purgeSeedTodos logs the same per-chip plan tombstone pointers', () => {
  db.init(dirA)
  db.call('upsert', { taskId: 'seed_x1', taskContent: 'seed', createTime: 1, updateTime: 1 })
  chipOn(dirA, 'chip_s1', 'seed_x1')
  const before = db.call('syncOplogSince', { sinceSeq: 0 })
  const lastSeq = before.length ? before[before.length - 1].seq : 0
  db.call('purgeSeedTodos')
  const ptrs = db.call('syncOplogSince', { sinceSeq: lastSeq })
  assert.ok(ptrs.some(p => p.entity === 'plan' && p.entityId === 'chip_s1'), 'seed purge logs the per-chip pointer too')
  assert.ok(ptrs.some(p => p.entity === 'todo' && p.entityId === 'seed_x1'))
})
