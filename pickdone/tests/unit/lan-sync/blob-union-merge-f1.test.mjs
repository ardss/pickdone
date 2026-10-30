/* F1 (2026-10-21) regression: array-shaped user-data meta blobs (projectMilestones:<catId>,
 * projectDocs:<catId>) used to sync whole-key LWW — two devices each adding an entry meant the
 * writer's blob overwrote the loser's whole document and the loser's entry vanished SILENTLY
 * (backup recoverable at best, gone at worst). Fix: sync-apply's meta channel union-merges these
 * keys BY ENTRY ID (local-only survive, incoming-only added, same id resolved per entry).
 * Covers: the shared pure merge, the applyRowInner integration (union lands instead of LWW),
 * non-array/absent-local fallback to whole-key LWW, and delete-whole-key staying whole-key.
 * Run: node --test tests/unit/lan-sync/blob-union-merge-f1.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const syncApply = require('../../../src/main/sync-apply.js')
const { mergeBlobMetaValue, isUnionMergeMetaKey } = require('../../../shared/blob-union-merge.mjs')

/** Minimal mock state (same shape as tests/unit/lan-sync/meta-entity.test.mjs). */
function mockState (tables = {}) {
  const calls = []
  const state = {
    calls,
    deviceId: 'local-device',
    localUserId: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    db: { call (op, params) { calls.push({ op, params }); return tables[op] ? tables[op](params) : null } },
  }
  return { state, calls }
}
const opCalls = (m, op) => m.calls.filter(c => c.op === op)

const MS_KEY = 'projectMilestones:c1'
const localMs = JSON.stringify([
  { id: 'ms_a', title: 'Local only', date: 1700000000000 },
  { id: 'ms_b', title: 'Shared', date: 1710000000000 },
])
const incomingMs = JSON.stringify([
  { id: 'ms_c', title: 'Remote only', date: 1720000000000 },
  { id: 'ms_b', title: 'Shared (remote edit)', date: 1710000000000 },
])

test('F1: shared merge — union by id, both sides kept, stamp-less same-id resolves deterministically', () => {
  const merged = JSON.parse(mergeBlobMetaValue(MS_KEY, localMs, incomingMs))
  assert.deepEqual(merged.map(m => m.id), ['ms_a', 'ms_b', 'ms_c'], 'local-only + incoming-only + shared, date-sorted')
  // Stamp-less (milestone) entries have no comparable age: the same-id winner is chosen by the
  // SYMMETRIC tiebreak (argument-order independent) so both peers converge byte-identically.
  const reversed = JSON.parse(mergeBlobMetaValue(MS_KEY, incomingMs, localMs))
  assert.equal(merged.find(m => m.id === 'ms_b').title, reversed.find(m => m.id === 'ms_b').title, 'same-id winner identical from either side')
  assert.ok(['Shared', 'Shared (remote edit)'].includes(merged.find(m => m.id === 'ms_b').title))
})

test('F1: docs merge — same id resolved by updatedAt, larger stamp wins', () => {
  const key = 'projectDocs:c2'
  const local = JSON.stringify([
    { id: 'd1', title: 'older local', updatedAt: 100 },
    { id: 'd2', title: 'local only', updatedAt: 300 },
  ])
  const incoming = JSON.stringify([
    { id: 'd1', title: 'newer remote', updatedAt: 200 },
    { id: 'd3', title: 'remote only', updatedAt: 400 },
  ])
  const merged = JSON.parse(mergeBlobMetaValue(key, local, incoming))
  const d1 = merged.find(m => m.id === 'd1')
  assert.equal(d1.title, 'newer remote', 'larger updatedAt wins per entry')
  assert.deepEqual(merged.map(m => m.id), ['d1', 'd2', 'd3'], 'union keeps all three, updatedAt-sorted')
})

test('F1: merge is deterministic — same input pair converges byte-identically (echo kills the loop)', () => {
  const a = mergeBlobMetaValue(MS_KEY, localMs, incomingMs)
  const b = mergeBlobMetaValue(MS_KEY, incomingMs, localMs)
  assert.equal(a, b, 'argument order must not change the converged blob')
})

test('F1: non-array or unaddressable shape → null (caller falls back to whole-key LWW)', () => {
  assert.equal(mergeBlobMetaValue(MS_KEY, '{"not":"an array"}', incomingMs), null)
  assert.equal(mergeBlobMetaValue(MS_KEY, localMs, 'garbage{'), null)
  assert.equal(mergeBlobMetaValue(MS_KEY, JSON.stringify([{ title: 'no id' }]), incomingMs), null)
  assert.equal(mergeBlobMetaValue('unrelatedKey', localMs, incomingMs), null)
})

test('F1: sync apply — concurrent adds union-merge instead of whole-blob clobber (local-only survives)', () => {
  // local wrote the blob at ts=100; the peer's edit (ts=200, whole-key newer) arrives
  const m = mockState({
    getMeta: k => (k === MS_KEY ? localMs : null),
    syncOplogSince: () => [{ seq: 1, entity: 'meta', entityId: MS_KEY, ts: 100 }],
  })
  const ok = syncApply.applyRowSafe(m.state, { entity: 'meta', id: MS_KEY, seq: 9, ts: 200, updatedAt: 200, deleted: false, deletedAt: 0, data: { key: MS_KEY, value: incomingMs } })
  assert.equal(ok, true)
  const puts = opCalls(m, 'setMeta')
  assert.equal(puts.length, 1, 'exactly the merged write — NO metaConflictBackup, nothing was lost')
  const landed = JSON.parse(puts[0].params[1])
  assert.deepEqual(landed.map(x => x.id), ['ms_a', 'ms_b', 'ms_c'])
  assert.ok(landed.some(x => x.id === 'ms_a' && x.title === 'Local only'), 'the loser device\'s milestone SURVIVES (the F1 silent-loss bug)')
})

test('F1: sync apply — local already the union superset (echo of merged blob) is a no-op, no echo churn', () => {
  const mergedStr = mergeBlobMetaValue(MS_KEY, localMs, incomingMs)
  const m = mockState({
    getMeta: () => mergedStr,
    syncOplogSince: () => [{ seq: 1, entity: 'meta', entityId: MS_KEY, ts: 100 }],
  })
  const ok = syncApply.applyRowSafe(m.state, { entity: 'meta', id: MS_KEY, seq: 9, ts: 200, updatedAt: 200, deleted: false, deletedAt: 0, data: { key: MS_KEY, value: incomingMs } })
  assert.equal(ok, false)
  assert.equal(opCalls(m, 'setMeta').length, 0, 'merged blob re-landing must not re-write (idempotent, no oplog echo)')
})

test('F1: sync apply — key absent locally / inbound delete / corrupt shape stay on the regular path', () => {
  // absent local: plain inbound win (no merge needed)
  const m1 = mockState({ getMeta: () => null, syncOplogSince: () => [] })
  assert.equal(syncApply.applyRowSafe(m1.state, { entity: 'meta', id: MS_KEY, seq: 9, ts: 200, updatedAt: 200, deleted: false, deletedAt: 0, data: { key: MS_KEY, value: incomingMs } }), true)
  assert.deepEqual(opCalls(m1, 'setMeta')[0].params, [MS_KEY, incomingMs])
  // inbound DELETE: whole-key deleteMeta (no per-entry tombstones in this schema)
  const m2 = mockState({
    getMeta: () => localMs,
    syncOplogSince: () => [{ seq: 1, entity: 'meta', entityId: MS_KEY, ts: 100 }],
  })
  assert.equal(syncApply.applyRowSafe(m2.state, { entity: 'meta', id: MS_KEY, seq: 9, ts: 300, updatedAt: 300, deleted: true, deletedAt: 300, data: null }), true)
  assert.equal(opCalls(m2, 'deleteMeta').length, 1)
  assert.equal(opCalls(m2, 'setMeta').filter(c => !String(c.params[0]).startsWith('metaConflictBackup.')).length, 0, 'no union-merge write — deletes are whole-key')
  // corrupt local shape: falls back to whole-key LWW (with the existing conflict backup)
  const m3 = mockState({
    getMeta: () => '{"corrupt":true}',
    syncOplogSince: () => [{ seq: 1, entity: 'meta', entityId: MS_KEY, ts: 100 }],
  })
  assert.equal(syncApply.applyRowSafe(m3.state, { entity: 'meta', id: MS_KEY, seq: 9, ts: 200, updatedAt: 200, deleted: false, deletedAt: 0, data: { key: MS_KEY, value: incomingMs } }), true)
  const puts3 = opCalls(m3, 'setMeta')
  assert.equal(puts3.length, 2, 'backup + winner (whole-key LWW fallback unchanged)')
  assert.match(String(puts3[0].params[0]), /^metaConflictBackup\./)
})

test('F1: classifier single-source — sync-apply re-exports the shared predicate', () => {
  assert.equal(syncApply.isUnionMergeMetaKey, isUnionMergeMetaKey)
  assert.equal(isUnionMergeMetaKey('projectDocs:c9'), true)
  assert.equal(isUnionMergeMetaKey('projectCategoryIds'), false)
})
