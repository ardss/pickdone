/* Provenance root fix (protocol v3, 2026-09-29): junk conflict-copy class eliminated at the
 * decision point. The 2026-09-28 three-machine drill observed: one edit on A, B and C each
 * still holding the unmodified base — when the edit arrived, B AND C each minted a "conflict"
 * copy of the UNCHANGED base (there was no divergent edit to preserve!) and the copies synced
 * back to A. Root cause: rows carried no author, so the merge could not tell a stale echo of
 * the same writer's line apart from an independent edit.
 *
 * These tests pin the apply-layer behavior: same-author stale base -> no copy, winner write
 * keeps the ORIGINAL author (never re-stamped to the receiver); different-author divergence
 * -> copy minted with the loser's lineage.
 *
 * Run: node --test tests/unit/lan-sync/provenance-stale-base-20260929.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const syncApply = require('../../../src/main/sync-apply.js')

function mockState (localRow) {
  const state = {
    deviceId: 'device-b',
    localUserId: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    db: { call (op) { if (op === 'getAll') return [] ; return null } },
  }
  const todoMap = new Map(localRow ? [[localRow.taskId, localRow]] : [])
  state.applyCache = { todo: id => todoMap.get(String(id)) }
  return state
}

const incoming = over => ({
  entity: 'todo', id: 'tid_base_1', seq: 9, ts: 2000, updatedAt: 2000,
  deleted: false, deletedAt: 0, ...over,
})

test('stale base from the SAME writer: no junk copy, winner keeps the original author', () => {
  // B's stored row was applied from A (author A). A then edited (v2, still author A). The echo
  // of B's base losing to v2 is NOT a conflict.
  const state = mockState({ taskId: 'tid_base_1', taskContent: 'v0', updateTime: 1000, delete: 0, deletedAt: 0, syncAuthor: 'device-a' })
  syncApply.applyRowSafe(state, incoming({ author: 'device-a', data: { taskId: 'tid_base_1', taskContent: 'v2', updateTime: 2000, delete: 0 } }))
  const copies = state.pendingWrites.todos.filter(t => String(t.taskId || '').includes('-conflict-'))
  assert.equal(copies.length, 0, 'same-writer stale base must not mint a copy')
  const winner = state.pendingWrites.todos.find(t => t.taskId === 'tid_base_1')
  assert.ok(winner, 'winner write fired')
  assert.equal(winner.syncAuthor, 'device-a', 'author preserved across apply (never re-stamped to receiver)')
})

test('divergent edit from a DIFFERENT writer: copy minted with the loser lineage', () => {
  // A wrote the base (author A, stored on B). B never edited it; C's independent edit arrives
  // older than A's v2? No — make the INCOMING lose: local v2 (A) vs incoming v1 (C) — local
  // wins, nothing lands; flip: local v1 (C) vs incoming v2 (A) — incoming wins, v1 diverges.
  const state = mockState({ taskId: 'tid_base_1', taskContent: 'C edit', updateTime: 1500, delete: 0, deletedAt: 0, syncAuthor: 'device-c' })
  syncApply.applyRowSafe(state, incoming({ author: 'device-a', data: { taskId: 'tid_base_1', taskContent: 'A v2', updateTime: 2000, delete: 0 } }))
  const copies = state.pendingWrites.todos.filter(t => String(t.taskId || '').includes('-conflict-'))
  assert.equal(copies.length, 1, 'divergent edit from another writer IS a conflict')
  assert.equal(copies[0].taskContent, 'C edit', 'loser content preserved')
  assert.equal(copies[0].syncAuthor, 'device-c', 'copy keeps the loser lineage')
  const winner = state.pendingWrites.todos.find(t => t.taskId === 'tid_base_1')
  assert.equal(winner.syncAuthor, 'device-a', 'winner write carries the winner author')
})

test('unknown author on either side: conservative — old behavior (copy minted)', () => {
  // Pre-v7 legacy rows carry no author; they must behave exactly as before the field existed.
  const state = mockState({ taskId: 'tid_base_1', taskContent: 'legacy base', updateTime: 1000, delete: 0, deletedAt: 0 })
  syncApply.applyRowSafe(state, incoming({ data: { taskId: 'tid_base_1', taskContent: 'newer', updateTime: 2000, delete: 0 } }))
  const copies = state.pendingWrites.todos.filter(t => String(t.taskId || '').includes('-conflict-'))
  assert.equal(copies.length, 1, 'legacy unknown-vs-unknown stays conservative')
})

test('hydrateRow egress stamps the top-level author from the stored row', async () => {
  // Egress contract: author rides TOP-LEVEL so withPeerDeviceId (which only overwrites
  // deviceId) cannot destroy it at any hop.
  const hydrate = require('../../../src/main/sync-apply-hydrate.js')
  const state = { deviceId: 'device-b', localUserId: null, pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] }, db: { call (op) { if (op === 'getAll') return [{ taskId: 'tid_1', taskContent: 'x', updateTime: 5, delete: 0, deletedAt: 0, syncAuthor: 'device-a' }]; return null } } }
  state.applyCache = hydrate.createHydrationCache(state)
  const row = hydrate.hydrateRow(state, { entity: 'todo', entityId: 'tid_1', seq: 3, ts: 5 }, state.applyCache)
  assert.ok(row, 'row hydrates')
  assert.equal(row.author, 'device-a', 'top-level author from syncAuthor column')
})
