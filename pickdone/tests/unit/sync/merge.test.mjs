/**
 * Unit tests for sync-core merge rules — design doc §4.2 conflict table:
 * LWW, delete-wins, tomato larger-focusDuration, plan_chips LWW+tombstone.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeTodoRows, mergeChipRows, mergeTomatoRows, applyRow, SYNC_SCHEMA_VERSION } from '../../../shared/sync-core/merge.mjs'

const todo = (over = {}) => ({
  id: 't1', title: 'hello', done: 0, updatedAt: 100, seq: 1, deviceId: 'devA', deleted: 0, ...over,
})

test('LWW: later updatedAt wins, loser content becomes conflict copy', () => {
  const a = todo({ title: 'from A', updatedAt: 100, seq: 1 })
  const b = todo({ title: 'from B', updatedAt: 200, seq: 2, deviceId: 'devB' })
  for (const [local, remote, winner, loser] of [[a, b, b, a], [b, a, b, a]]) {
    const { row, conflictCopy } = mergeTodoRows(local, remote)
    assert.equal(row, winner)
    assert.ok(conflictCopy, 'loser content must be preserved')
    assert.equal(conflictCopy.title, loser.title)
    assert.equal(conflictCopy.conflictOf, 't1')
  }
})

test('LWW tie on updatedAt: later seq breaks the tie deterministically', () => {
  const a = todo({ title: 'A', updatedAt: 100, seq: 1 })
  const b = todo({ title: 'B', updatedAt: 100, seq: 9, deviceId: 'devB' })
  assert.equal(mergeTodoRows(a, b).row.title, 'B')
  assert.equal(mergeTodoRows(b, a).row.title, 'B')
})

test('LWW full tie (same updatedAt+seq+deviceId): stable, no conflict copy', () => {
  const a = todo()
  const b = todo()
  const { row, conflictCopy } = mergeTodoRows(a, b)
  assert.deepEqual(row, a)
  assert.equal(conflictCopy, null)
})

test('delete-wins: tombstone with deletedAt > live updatedAt wins', () => {
  const live = todo({ updatedAt: 100 })
  const tomb = todo({ deleted: 1, deletedAt: 150, updatedAt: 150, seq: 2, deviceId: 'devB' })
  const { row } = mergeTodoRows(live, tomb)
  assert.equal(row.deleted, 1)
  assert.equal(row.deletedAt, 150)
})

test('delete-wins boundary: live edit newer than tombstone survives (restore-like)', () => {
  const tomb = todo({ deleted: 1, deletedAt: 100, updatedAt: 100, seq: 1 })
  const live = todo({ title: 'edited after', updatedAt: 101, seq: 2, deviceId: 'devB' })
  const { row } = mergeTodoRows(tomb, live)
  assert.equal(row.deleted, 0)
  assert.equal(row.title, 'edited after')
})

test('delete-wins: losing a stale tombstone produces no conflict copy', () => {
  const tomb = todo({ deleted: 1, deletedAt: 50, updatedAt: 50 })
  const live = todo({ updatedAt: 100, seq: 2, deviceId: 'devB' })
  const { conflictCopy } = mergeTodoRows(tomb, live)
  assert.equal(conflictCopy, null)
})

test('tomato ledger: larger focusDuration wins regardless of recency', () => {
  const small = { tomatoId: 'x1', id: 'x1', focusDuration: 25, updatedAt: 900, seq: 9, deviceId: 'devA' }
  const big = { tomatoId: 'x1', id: 'x1', focusDuration: 50, updatedAt: 100, seq: 1, deviceId: 'devB' }
  assert.equal(mergeTomatoRows(small, big).row.focusDuration, 50)
  assert.equal(mergeTomatoRows(big, small).row.focusDuration, 50)
})

test('tomato ledger: equal duration -> later updatedAt wins', () => {
  const a = { tomatoId: 'x1', id: 'x1', focusDuration: 25, updatedAt: 100, seq: 1, deviceId: 'devA' }
  const b = { tomatoId: 'x1', id: 'x1', focusDuration: 25, updatedAt: 200, seq: 1, deviceId: 'devB' }
  assert.equal(mergeTomatoRows(a, b).row.updatedAt, 200)
})

test('plan_chips: row-level LWW + tombstone same as todos', () => {
  const live = { id: 'c1', day: '2026-09-15', payload: 'p1', updatedAt: 100, seq: 1, deviceId: 'devA', deleted: 0 }
  const tomb = { id: 'c1', day: '2026-09-15', payload: 'p1', updatedAt: 100, seq: 1, deviceId: 'devB', deleted: 1, deletedAt: 150 }
  assert.equal(mergeChipRows(live, tomb).row.deleted, 1)
  const newer = { ...live, payload: 'p2', updatedAt: 200, seq: 3 }
  assert.equal(mergeChipRows(tomb, newer).row.payload, 'p2')
})

test('determinism: no wall clock involved, same inputs -> same outputs', () => {
  const a = todo({ title: 'A' })
  const b = todo({ title: 'B', updatedAt: 300, seq: 2, deviceId: 'devB' })
  const r1 = mergeTodoRows(a, b)
  const r2 = mergeTodoRows(a, b)
  assert.deepEqual(r1, r2)
  assert.equal(SYNC_SCHEMA_VERSION, 1)
})

test('applyRow merges into a Map store and keeps one row per id', () => {
  const store = new Map()
  applyRow(store, todo())
  const { row, conflictCopy } = applyRow(store, todo({ title: 'newer', updatedAt: 500, seq: 5, deviceId: 'devB' }))
  assert.equal(store.size, 1)
  assert.equal(row.title, 'newer')
  assert.ok(conflictCopy)
})

// Provenance (protocol v3, 2026-09-29): author = the device whose write produced this version.
// Same author on both sides = the loser is a stale prior version of the same writer's line —
// never a conflict. This is the root fix for the junk-copy class (1 edit x N unsynced peers
// used to mint N recycle copies that synced back to the editor).

test('provenance: same-author stale version loses WITHOUT a conflict copy', () => {
  // A wrote v0, edited to v2. B still holds v0 and its echo arrives at A: same writer, so the
  // stale base is silently superseded — no divergent edit exists to preserve.
  const v0 = todo({ title: 'v0', updatedAt: 100, seq: 1, author: 'devA' })
  const v2 = todo({ title: 'v2', updatedAt: 300, seq: 3, deviceId: 'devA', author: 'devA' })
  assert.equal(mergeTodoRows(v2, v0).conflictCopy, null, 'same-writer stale base: no copy')
  assert.equal(mergeTodoRows(v0, v2).conflictCopy, null, 'order must not matter')
})

test('provenance: different-author older edit still yields a conflict copy', () => {
  // A wrote v0 then v2; B independently edited the shared base into v1 (author B). B's v1
  // losing to A's v2 IS a divergence — the copy must exist.
  const v1 = todo({ title: 'B edit', updatedAt: 200, seq: 2, deviceId: 'devB', author: 'devB' })
  const v2 = todo({ title: 'A v2', updatedAt: 300, seq: 3, deviceId: 'devA', author: 'devA' })
  const { conflictCopy } = mergeTodoRows(v2, v1)
  assert.ok(conflictCopy, 'divergent edit preserved')
  assert.equal(conflictCopy.title, 'B edit')
  assert.equal(conflictCopy.author, 'devB', 'copy keeps the loser lineage')
})

test('provenance: unknown author on either side stays conservative (mint)', () => {
  // Pre-v7 legacy rows carry no author — behave exactly as before the field existed.
  const legacy = todo({ title: 'legacy', updatedAt: 100, seq: 1 })
  const authored = todo({ title: 'new', updatedAt: 300, seq: 3, deviceId: 'devA', author: 'devA' })
  assert.ok(mergeTodoRows(authored, legacy).conflictCopy, 'unknown loser author mints')
  assert.ok(mergeTodoRows(legacy, authored).conflictCopy, 'unknown winner author mints')
})

test('provenance: syncAuthor stamps are bookkeeping, not content', () => {
  // Byte-identical payloads whose only difference is the per-device provenance stamp must be
  // content-EQUAL (the identical-content no-op depends on it).
  const a = todo({ title: 'same', updatedAt: 100, seq: 1, author: 'devA' })
  const b = todo({ title: 'same', updatedAt: 100, seq: 1, deviceId: 'devB', author: 'devB' })
  assert.equal(mergeTodoRows(a, b).conflictCopy, null, 'stamp-only difference: no conflict')
})
