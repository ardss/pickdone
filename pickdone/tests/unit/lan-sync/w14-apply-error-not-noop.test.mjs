/**
 * W14 (2026-10-27) regression: applyRowSafe must never translate a transient DB failure
 * (SQLITE_BUSY etc.) into a legitimate no-op.
 *
 * Contract under test:
 *   - applyRowSafe THROWS on an exception inside applyRowInner (undecided row) — the relay
 *     pull side (relay-sync-apply) and the LAN ingestSegment loop let the throw fail the
 *     round so the durable cursor/push watermark stays put and the same frames re-apply
 *     (idempotent by LWW no-op). Previously the catch returned false, the relay read it as
 *     "local already holds at-least-as-new content", advanced the cursor with verdict 'ok'
 *     and the remote change was lost one-way, never retried.
 *   - Legitimate false semantics are UNCHANGED (LWW loser, ghost tombstone, identical
 *     content): those are DECIDED no-ops and must still advance the cursor.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const syncApply = require('../../../src/main/sync-apply.js')
const db = require('../../../src/main/db.js')

const EMPTY_TABLES = {
  getAll: () => [],
  settingsRowsAll: () => [],
  tomatoAll: () => [],
  categoriesAllRows: () => [], planTombstones: () => [], filterTombstones: () => [],
  planAll: () => [],
  filterList: () => [],
}

function mockState (tables = {}) {
  const pendingWrites = { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] }
  const state = {
    db: { call: (op, params) => { if (tables[op]) return tables[op](params); return null } },
    pendingWrites,
    applyCache: null,
    deviceId: 'devSelf',
    localUserId: null,
  }
  return { state, pendingWrites }
}

test('w14 applyRowSafe: a transient SQLITE_BUSY inside applyRowInner THROWS (never a silent false)', () => {
  const { state, pendingWrites } = mockState({
    ...EMPTY_TABLES,
    getAll: () => { throw new Error('SQLITE_BUSY: database is locked') },
  })
  state.applyCache = syncApply.createHydrationCache(state)
  assert.throws(
    () => syncApply.applyRowSafe(state, { entity: 'todo', id: 'w14-1', updatedAt: Date.now(), deleted: false, deletedAt: 0, data: { taskId: 'w14-1', taskContent: 'peer edit', updateTime: Date.now() } }),
    /SQLITE_BUSY/,
    'an undecided row (DB failure) must surface as an exception so the round fails and the cursor stays put'
  )
  assert.equal(pendingWrites.todos.length, 0, 'a failed apply must not buffer a write')
})

test('w14 applyRowSafe: legitimate no-op (ghost tombstone on plan/filter) still returns false', () => {
  const { state } = mockState({ ...EMPTY_TABLES })
  state.applyCache = syncApply.createHydrationCache(state)
  // plan/filter ghost tombstones (id we never had) are DECIDED no-ops -> false (sync-apply.js
  // plan/filter branches). Todo ghost tombstones deliberately return true (applied, watermark
  // advances, merge idempotent) — that design is unchanged either way.
  const ok = syncApply.applyRowSafe(state, { entity: 'plan', id: 'never-had-chip', updatedAt: 100, deleted: true, deletedAt: 99, data: null })
  assert.equal(ok, false, 'ghost tombstone remains a DECIDED no-op (false), not an error')
})

test('w14 relay: applyPulledEnvelopes throws on a transient apply failure (cursor must not advance past it)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w14-relay-'))
  db.init(dir)
  try {
    const now = Date.now()
    const env = {
      revisionId: 'rt-w14-busy-1',
      entity: 'todo',
      entityId: 'w14-row-busy',
      authorDeviceId: 'devPeer',
      parents: [],
      payloadHash: 'w14-test-payloadhash',
      hlc: { physical: now, logical: 0, nodeId: 'devPeer' },
      payload: { id: 'w14-row-busy', userId: 1, content: 'peer change', deleted: 0, createdAt: now, updatedAt: now, sort: 0 },
    }
    const origCall = db.call
    db.call = (op, p) => {
      if (op === 'getAll') throw new Error('SQLITE_BUSY: database is locked')
      return origCall(op, p)
    }
    let threw = null
    try {
      const { applyPulledEnvelopes } = require('../../../src/main/relay-sync-apply.js')
      applyPulledEnvelopes([{ envelope: env, status: 'applied' }], null, 'devSelf')
    } catch (e) { threw = e } finally { db.call = origCall }
    assert.ok(threw, 'relay apply must NOT swallow the transient failure into a verdict-ok cursor advance')
    assert.match(String(threw && threw.message), /SQLITE_BUSY/)
    assert.equal(db.queryTodos({ deleted: 0 }).some(t => (t.taskId || t.id) === 'w14-row-busy'), false, 'the row never landed — nothing may be acked as applied')
    // Recovery: with the failure gone, the SAME frame re-applies and lands (round replay).
    const { applyPulledEnvelopes } = require('../../../src/main/relay-sync-apply.js')
    const r = applyPulledEnvelopes([{ envelope: env, status: 'applied' }], null, 'devSelf')
    assert.equal(r.businessApplied, 1, 'the replayed frame materializes once the transient failure clears')
    assert.equal(r.verdicts.get('rt-w14-busy-1'), 'ok')
    assert.ok(db.queryTodos({ deleted: 0 }).some(t => (t.taskId || t.id) === 'w14-row-busy'))
  } finally {
    try { db.close() } catch { /* temp db teardown best-effort */ }
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp dir best-effort */ }
  }
})

test('w14 relay: a legitimate LWW loser still verdicts ok (no-op cursor advance is correct for DECIDED rows)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w14-relay-lww-'))
  db.init(dir)
  try {
    const now = Date.now()
    // Local row strictly NEWER than the inbound peer edit: a decided LWW no-op.
    db.call('upsertMany', [{ taskId: 'w14-row-lww', taskContent: 'local newer edit', userId: 1, createdAt: now, updateTime: now + 60000, sort: 0 }])
    const { applyPulledEnvelopes } = require('../../../src/main/relay-sync-apply.js')
    const r = applyPulledEnvelopes([{
      envelope: {
        revisionId: 'rt-w14-lww-1',
        entity: 'todo',
        entityId: 'w14-row-lww',
        authorDeviceId: 'devPeer',
        parents: [],
        payloadHash: 'w14-test-payloadhash-lww',
        hlc: { physical: now, logical: 0, nodeId: 'devPeer' },
        payload: { id: 'w14-row-lww', userId: 1, content: 'stale peer edit', deleted: 0, createdAt: now, updatedAt: now, sort: 0 },
      },
      status: 'applied',
    }], null, 'devSelf')
    assert.equal(r.verdicts.get('rt-w14-lww-1'), 'ok', 'a decided no-op must advance the cursor')
    assert.equal(r.businessSkipped, 1)
    const row = db.queryTodos({ deleted: 0 }).find(t => (t.taskId || t.id) === 'w14-row-lww')
    assert.equal(row.taskContent, 'local newer edit', 'local newer content stands')
  } finally {
    try { db.close() } catch { /* temp db teardown best-effort */ }
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp dir best-effort */ }
  }
})
