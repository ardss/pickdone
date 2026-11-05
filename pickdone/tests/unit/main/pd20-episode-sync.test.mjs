/* PD20 (2026-11-05) P0-3 — cross-device work-handoff sync: work_episodes / source_refs /
 * task_source_links leave the machine-local island and ride the v1 LAN sync pipeline as their
 * own entities. Real better-sqlite3 + real db.call + real oplog, no fabricated shapes
 * (round7-sync-lww harness doctrine). Asserted behavior:
 *   T1  local writes capture row-granular oplog pointers (episode/source/tasksource)
 *   T2  inbound episode rows land through the bus with the wire-carried LWW age; a local
 *       tombstone holds delete-wins against a stale peer edit; a ghost tombstone no-ops
 *   T3  pair-collapse: a peer source captured under a different id merges onto the LOCAL
 *       pair id (UNIQUE pair backstop) and its foreign id pointer applies as a no-op
 *   T4  machine-local gate: `file`-provider source refs never egress (allRows) and are
 *       refused on ingress; portable http(s) refs sync normally
 *   T5  snapshot enumeration (allRows) carries the three entities incl. tombstones
 * Run: node --test tests/unit/main/pd20-episode-sync.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const syncApply = require_('../../../src/main/sync-apply.js')
const bootstrap = require_('../../../src/main/lan-sync-bootstrap.js')
const { isMachineLocalSourceRef } = require_('../../../shared/machine-local-keys.mjs')

function freshDevice () {
  db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'pd20-epsync-')))
  const state = {
    deviceId: 'devPd20',
    localUserId: null,
    applyCache: null,
    applied: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    db: { call: (op, p) => db.call(op, p) },
  }
  bootstrap.__test.setState(state)
  return state
}

const pointers = entity => (db.call('syncOplogSince', { sinceSeq: 0, limit: 10000 }) || []).filter(r => r.entity === entity)

test('T1: local episode/source/tasksource writes capture row-granular oplog pointers', () => {
  freshDevice()
  const epId = db.call('episodePut', { taskId: 't1', startedAt: 100, endedAt: 200, note: 'goal:x' })
  const srcId = db.call('sourcePut', { providerId: 'github', externalId: '42', title: 'spec' })
  const linkId = db.call('taskSourcePut', { taskId: 't1', sourceRefId: srcId })
  for (const [entity, id] of [['episode', epId], ['source', srcId], ['tasksource', linkId]]) {
    const p = pointers(entity).find(r => r.entityId === String(id))
    assert.ok(p, `a ${entity} oplog pointer was captured for ${id}`)
  }
  // tombstone removes are result-aware: only the ACTUALLY changed id emits a pointer
  db.call('episodeRemoveIds', [epId, 'ghost-ep'])
  assert.equal(pointers('episode').filter(r => r.entityId === epId).length, 2, 'one live pointer (put) + one tombstone pointer (remove)')
  assert.ok(pointers('episode').some(r => r.entityId === epId), 'tombstone pointer emitted')
  assert.equal(pointers('episode').filter(r => r.entityId === 'ghost-ep').length, 0, 'a ghost remove emits NO phantom pointer')
  // a re-delete of an already-dead id is a no-op (no extra pointer, no echo fuel)
  const before = pointers('episode').length
  db.call('episodeRemoveIds', [epId])
  assert.equal(pointers('episode').length, before, 're-tombstoning a dead id emits no pointer')
})

test('T2: an inbound episode row lands with the wire age; a local tombstone holds delete-wins; a ghost tombstone no-ops', () => {
  const state = freshDevice()
  const T = Date.now() - 60000
  // live row lands via the bus, keeping the wire-carried LWW age
  const ok = syncApply.applyRowSafe(state, {
    entity: 'episode', id: 'ep-peer-1', seq: 1, ts: T, updatedAt: T, deleted: false, deletedAt: 0,
    data: { id: 'ep-peer-1', taskId: 't1', startedAt: 1, endedAt: 2, note: 'goal:peer work', deleted: 0, deletedAt: 0, updatedAt: T },
  })
  assert.equal(ok, true)
  const row = db.call('episodeAllRows', {}).find(r => r.id === 'ep-peer-1')
  assert.ok(row, 'the peer episode landed')
  assert.equal(row.updatedAt, T, 'the wire-carried LWW age survives the landing')
  assert.equal(row.deleted, 0)
  // a stale peer edit (older than a fresh LOCAL tombstone) does not resurrect the row
  const delAt = T + 5000
  db.call('episodeRemoveIds', [{ id: 'ep-peer-1', deletedAt: delAt, updatedAt: delAt }])
  const staleEdit = syncApply.applyRowSafe(state, {
    entity: 'episode', id: 'ep-peer-1', seq: 2, ts: T + 1000, updatedAt: T + 1000, deleted: false, deletedAt: 0,
    data: { id: 'ep-peer-1', taskId: 't1', startedAt: 1, endedAt: 9, note: 'stale', deleted: 0, deletedAt: 0, updatedAt: T + 1000 },
  })
  assert.equal(staleEdit, false, 'stale peer edit loses to the fresher local tombstone')
  assert.equal(db.call('episodeAllRows', {}).find(r => r.id === 'ep-peer-1').deleted, 1, 'local delete-wins held')
  // a NEWER peer edit resurrects (genuine LWW) — landing path sanity
  const newer = syncApply.applyRowSafe(state, {
    entity: 'episode', id: 'ep-peer-1', seq: 3, ts: delAt + 2000, updatedAt: delAt + 2000, deleted: false, deletedAt: 0,
    data: { id: 'ep-peer-1', taskId: 't1', startedAt: 1, endedAt: 12, note: 'revived on peer', deleted: 0, deletedAt: 0, updatedAt: delAt + 2000 },
  })
  assert.equal(newer, true)
  assert.equal(db.call('episodeAllRows', {}).find(r => r.id === 'ep-peer-1').deleted, 0, 'a strictly newer peer edit wins LWW')
  // ghost tombstone: peer deletes a row we never had — applied, watermark advances, NO junk row
  const ghost = syncApply.applyRowSafe(state, {
    entity: 'episode', id: 'ep-never-here', seq: 4, ts: T, updatedAt: T, deleted: true, deletedAt: T, data: null,
  })
  assert.equal(ghost, true, 'ghost tombstone counts as applied')
  assert.equal(db.call('episodeAllRows', {}).filter(r => r.id === 'ep-never-here').length, 0, 'no content-empty junk row materialized')
})

test('T3: pair-collapse merges a foreign-id peer source onto the LOCAL pair id (no second row, no loop fuel)', () => {
  const state = freshDevice()
  const localTs = Date.now() - 30000
  const localId = db.call('sourcePut', { providerId: 'github', externalId: '77', title: 'local capture', updatedAt: localTs })
  const peerTs = Date.now() - 10000 // strictly newer
  const ok = syncApply.applyRowSafe(state, {
    entity: 'source', id: 'src-peer-id', seq: 1, ts: peerTs, updatedAt: peerTs, deleted: false, deletedAt: 0,
    data: { id: 'src-peer-id', providerId: 'github', externalId: '77', title: 'peer capture', deleted: 0, deletedAt: 0, updatedAt: peerTs },
  })
  assert.equal(ok, true, 'the foreign-id pair row applies (as a merge)')
  const rows = db.call('sourceAllRows', {}).filter(r => r.providerId === 'github' && r.externalId === '77')
  assert.equal(rows.length, 1, 'UNIQUE pair backstop: still exactly ONE row for the pair')
  assert.equal(rows[0].id, localId, 'the row lives under the LOCAL pair id')
  assert.equal(rows[0].title, 'peer capture', 'the strictly newer peer content won the merge')
  assert.equal(rows[0].updatedAt, peerTs, 'the winner stamp carried over')
  // an OLDER foreign-id peer row must not clobber the local content
  const older = syncApply.applyRowSafe(state, {
    entity: 'source', id: 'src-peer-2', seq: 2, ts: localTs - 1000, updatedAt: localTs - 1000, deleted: false, deletedAt: 0,
    data: { id: 'src-peer-2', providerId: 'github', externalId: '77', title: 'older peer', deleted: 0, deletedAt: 0, updatedAt: localTs - 1000 },
  })
  assert.equal(older, true, 'the pointer applies (as a no-op merge)')
  assert.equal(db.call('sourceAllRows', {}).find(r => r.id === localId).title, 'peer capture', 'older foreign-id row changed nothing')
  assert.ok(!db.call('sourceAllRows', {}).some(r => r.id === 'src-peer-id'), 'the foreign id never materialized locally (no echo fuel)')
})

test('T4: `file`-provider source refs are machine-local — never egress, refused on ingress', () => {
  const state = freshDevice()
  assert.equal(isMachineLocalSourceRef('file', 'K:/notes/spec.md'), true, 'file provider = machine-local')
  assert.equal(isMachineLocalSourceRef('web', 'https://example.com'), false, 'portable refs sync')
  assert.equal(isMachineLocalSourceRef('', undefined), false, 'empty provider is not file')
  // egress: a file ref gets NO snapshot row (its oplog pointer hydrates to null — legit skip)
  db.call('sourcePut', { providerId: 'file', externalId: 'K:/notes/spec.md', title: 'secret path' })
  db.call('sourcePut', { providerId: 'web', externalId: 'https://example.com/a', title: 'portable' })
  const snap = bootstrap.__test.allRows().filter(r => r.entity === 'source')
  assert.equal(snap.length, 1, 'only the portable ref egresses')
  assert.equal(snap[0].data.externalId, 'https://example.com/a')
  // ingress mirror: a crafted/legacy peer row carrying a file path is refused outright
  const refused = syncApply.applyRowSafe(state, {
    entity: 'source', id: 'src-file-peer', seq: 1, ts: Date.now(), updatedAt: Date.now(), deleted: false, deletedAt: 0,
    data: { id: 'src-file-peer', providerId: 'file', externalId: 'C:/Users/peer/secret', title: 'x', deleted: 0, deletedAt: 0, updatedAt: Date.now() },
  })
  assert.equal(refused, false, 'a file-provider peer row is refused on ingress')
  assert.equal(db.call('sourceAllRows', {}).some(r => r.id === 'src-file-peer'), false)
})

test('T5: snapshot enumeration carries the three entities incl. tombstones and real ages', () => {
  freshDevice()
  const epId = db.call('episodePut', { taskId: 't5', startedAt: 1, endedAt: 2, note: 'n' })
  db.call('episodeRemoveIds', [epId])
  const linkId = db.call('taskSourcePut', { taskId: 't5', sourceRefId: 'src-x' })
  const snap = bootstrap.__test.allRows()
  const ep = snap.find(r => r.entity === 'episode' && r.id === epId)
  assert.ok(ep, 'episode row (tombstone) is in the snapshot')
  assert.equal(ep.deleted, true, 'the tombstone rides along')
  assert.ok(ep.updatedAt > 0, 'real age carried')
  assert.equal(ep.data, null, 'tombstone data is null (category doctrine)')
  const lk = snap.find(r => r.entity === 'tasksource' && r.id === linkId)
  assert.ok(lk && lk.deleted === false && lk.data && lk.data.taskId === 't5', 'live tasksource link rides with raw data')
})
