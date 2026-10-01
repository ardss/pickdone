/* D13 fix-wave regression tests (domain-1: main sync/db recovery), fixes 1/3/4/5/6/8/9:
 *   fix 1  tomatoMigrateFromMeta: the COUNT(*)>0 short-circuit is rejection-aware — a PARTIAL
 *          migration (marker set) keeps the blob on the next boot instead of deleting the
 *          rejected rows' only copy; full acceptance clears the marker and the blob.
 *   fix 3  flushPendingWrites: per-row rejections surfaced by the bulk ops
 *          (settingsRowPutMany / planAddMany attach `rejected` non-enumerably; tomatoAppendMany
 *          returns {accepted, rejected}) are quarantined + reported instead of silently acked.
 *   fix 4  tombstoneAbsentRows stamps blob-mirror deletions with the doc's gateTs (causal
 *          watermark), not local wall-clock now.
 *   fix 5  metaSnapshotRows enumerates recently-deleted meta keys as tombstone rows (retained
 *          pointers) so a lagged peer cannot LWW-resurrect a deleted key via snapshot.
 *   fix 6  appendOplogPointers honors a per-row ts — the seed no longer stamps every legacy
 *          pointer newest-here (meta age IS the pointer ts).
 *   fix 8  hydrateRow category branch carries the row's honest deletedAt (0 for legacy 0-stamp
 *          tombstones) instead of fabricating ptr.ts.
 *   fix 9  deleteMeta is result-aware — deleting an absent key mints no phantom oplog delta.
 * Real better-sqlite3 via db.init on fresh temp dirs (d11-tombstone-stamps pattern — never the
 * real %APPDATA% profile). Run: node --test tests/unit/main/d13-sync-db-fixes.test.mjs
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
const tomatoOps = require_('../../../src/main/db-tomato-ops.js')
const syncSchemaFactory = require_('../../../src/main/db-sync-schema.js')
const hydrate = require_('../../../src/main/sync-apply-hydrate.js')
const Database = require_('../../../vendor/better-sqlite3-multiple-ciphers')

function freshDevice (label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd13-fixes-' + label + '-'))
  db.init(dir)
  return {
    dir,
    deviceId: 'devD13',
    localUserId: null,
    applyCache: null,
    applied: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    db: { call: (op, p) => db.call(op, p) },
  }
}

/* ---------------- fix 1: rejection-aware COUNT guard ---------------- */

test('fix 1: a partially-migrated library keeps the blob on the next boot and re-attempts the rejected rows', () => {
  freshDevice('mig-partial')
  const blobRows = [
    { tomatoId: 'd13f1-ok', endTime: Date.now(), focus: 'a', focusDuration: 5 },
    { tomatoId: 'd13f1-bad', endTime: 'not-a-date', focus: 'b', focusDuration: 5 },
  ]
  db.call('setMeta', ['db.tomatoState', JSON.stringify({ tomatoRecordList: blobRows })])
  const origAppend = tomatoOps.tomatoAppendMany
  let calls = 0
  // Run 1 + 2: one row rejects (its only copy is the blob). Run 3: everything accepts.
  const stubbed = (d, list) => {
    calls++
    if (calls <= 2) return { accepted: 1, rejected: [{ index: 1, tomatoId: 'd13f1-bad', reason: 'dateKey derive failed' }] }
    return { accepted: list.length, rejected: [] }
  }
  tomatoOps.tomatoAppendMany = stubbed
  try {
    // run 1: empty table, partial migration → blob kept, marker set
    const n1 = db.call('tomatoMigrateFromMeta', { getMeta: k => db.call('getMeta', k) })
    assert.equal(n1, 1)
    assert.ok(db.call('getMeta', 'db.tomatoState'), 'run 1: blob KEPT (rejected row lives only there)')
    assert.equal(db.call('getMeta', 'sync.tomatoBlobPartialMigration'), '1', 'run 1: partial-migration marker set')
    // run 2: the accepted row has landed, so COUNT(*)>0 — the guard must NOT delete the blob now
    // (unpatch the stub for the seeding insert itself)
    tomatoOps.tomatoAppendMany = origAppend
    db.call('tomatoAppendMany', [{ tomatoId: 'd13f1-ok', endTime: Date.now(), focus: 'a', focusDuration: 5 }])
    tomatoOps.tomatoAppendMany = stubbed
    const n2 = db.call('tomatoMigrateFromMeta', { getMeta: k => db.call('getMeta', k) })
    assert.equal(n2, 1, 'run 2: the migration re-ran (red before the fix: the count guard deleted the blob)')
    assert.equal(calls, 2, 'run 2: tomatoAppendMany re-invoked for the remainder')
    assert.ok(db.call('getMeta', 'db.tomatoState'), 'run 2: blob still KEPT')
    // run 3: fully accepted → blob deleted and the marker cleared (steady state restored).
    // D14 B1: the retry only re-attempts rows NOT already in tomato_records — 'd13f1-ok' was
    // really inserted in run 2, so run 3's stub sees just the remaining row (accepted=1).
    const n3 = db.call('tomatoMigrateFromMeta', { getMeta: k => db.call('getMeta', k) })
    assert.equal(n3, 1, 'run 3: only the remaining row is re-attempted (already-migrated rows are filtered)')
    assert.equal(db.call('getMeta', 'db.tomatoState'), null, 'run 3: lossless migration deletes the blob')
    assert.equal(db.call('getMeta', 'sync.tomatoBlobPartialMigration'), null, 'run 3: marker cleared')
  } finally { tomatoOps.tomatoAppendMany = origAppend }
  db.close()
})

test('fix 1: a fully-accepted FIRST migration still deletes the blob (no marker left behind)', () => {
  freshDevice('mig-clean')
  db.call('setMeta', ['db.tomatoState', JSON.stringify({ tomatoRecordList: [{ tomatoId: 'd13f1c', endTime: Date.now(), focus: 'a', focusDuration: 5 }] })])
  const n = db.call('tomatoMigrateFromMeta', { getMeta: k => db.call('getMeta', k) })
  assert.equal(n, 1)
  assert.equal(db.call('getMeta', 'db.tomatoState'), null)
  assert.equal(db.call('getMeta', 'sync.tomatoBlobPartialMigration'), null, 'no marker after a lossless migration')
  db.close()
})

/* ---------------- fix 3: flush quarantine for per-row rejections ---------------- */

/** Harness mirroring poison-quarantine-20260926: a mock state whose settings flush routes into a
 *  REAL db-sync-schema instance over a raw temp SQLite file; meta is an in-memory map. */
function flushState (settingsSegment) {
  const d = new Database(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'd13-flush-')), 'todos.db'))
  d.exec(`CREATE TABLE IF NOT EXISTS settings_rows (
    key TEXT PRIMARY KEY, value TEXT, updatedAt INTEGER NOT NULL DEFAULT 0,
    deleted INTEGER NOT NULL DEFAULT 0, deletedAt INTEGER NOT NULL DEFAULT 0);`)
  const schema = syncSchemaFactory({ getDb: () => d, log: { warn: () => {}, info: () => {}, error: () => {} } })
  const meta = {}
  const sent = []
  const state = {
    deviceId: 'devD13Flush',
    applyCache: null,
    applied: null,
    pendingWrites: { todos: [], tomatoes: [], categories: [], plans: [], filters: [], settings: settingsSegment },
    db: {
      call: (op, p) => {
        if (op === 'settingsRowPutMany') return schema.rowPutMany(p)
        if (op === 'getMeta') return meta[p] != null ? meta[p] : null
        if (op === 'setMeta') { meta[p[0]] = p[1]; return true }
        return true
      },
    },
    getWindowSenders: () => [{ isDestroyed: () => false, send: (ch, msg) => sent.push({ ch, msg }) }],
  }
  return { state, meta, sent, schema, close: () => d.close() }
}

test('fix 3: a key-less settings row is quarantined and surfaced, not silently acked', () => {
  const { state, meta, schema, close } = flushState([
    { key: 'd13good', value: 'one', updatedAt: 1000 },
    { key: '', value: 'poison' }, // key-less row → rowPutMany rejects it per-row
  ])
  const r = syncApply.flushPendingWrites(state)
  assert.equal(r.ok, true, 'the valid rows committed; the round still acks')
  assert.equal(r.quarantined.length, 1, 'the rejected row is reported on the flush result')
  assert.equal(r.quarantined[0].op, 'settingsRowPutMany')
  assert.equal(r.quarantined[0].count, 1)
  const parked = JSON.parse(meta['sync.flushQuarantine.settingsRowPutMany'])
  assert.equal(parked.length, 1)
  assert.deepEqual(parked[0].rows, [{ key: '', value: 'poison', __rejectReason: 'key required' }],
    'the exact dropped row is recoverable from the quarantine')
  const all = schema.rowsAll()
  assert.ok(all.find(x => x.key === 'd13good'), 'the valid sibling landed')
  assert.equal(all.filter(x => !x.key).length, 0)
  close()
})

test('fix 3: planAddMany surfaces skipped chips non-enumerably (array contract intact)', () => {
  freshDevice('plan-reject')
  const ids = db.call('planAddMany', [
    { id: 'pl_d13_ok', taskId: 't1', day: '2026-10-01', mm: '09:00' },
    { taskId: 't2', day: 'garbage', mm: '09:00' },
  ])
  assert.deepEqual([...ids], ['pl_d13_ok'], 'accepted ids unchanged')
  assert.equal(ids.rejected.length, 1, 'the invalid chip is surfaced')
  assert.equal(ids.rejected[0].index, 1)
  const ptrs = (db.call('syncOplogSince', { sinceSeq: 0, limit: 10000 }) || []).filter(r => r.entity === 'plan')
  assert.ok(ptrs.some(r => r.entityId === 'pl_d13_ok'))
  db.close()
})

/* ---------------- fix 4: tombstone stamps use the doc's gateTs ---------------- */

test('fix 4: a blob-mirror deletion is stamped with the snapshot _savedAt, not local now', () => {
  freshDevice('tomb-stamp')
  const T = Date.now() - 60000
  db.call('settingsRowPutMany', [{ key: 'd13field', value: 'x', updatedAt: T - 1000 }])
  // Whole-blob mirror WITHOUT the field (the user removed it), snapshot taken at T
  db.call('setMeta', ['db.settingsState', JSON.stringify({ _savedAt: T, untouched: 'v' })])
  const row = (db.call('settingsRowsAll', {}) || []).find(r => r.key === 'd13field')
  assert.ok(row && row.deleted, 'the removal tombstoned the row')
  assert.equal(row.deletedAt, T, 'deletedAt must equal the causal watermark (was ≈now, falsifying delete order)')
  assert.equal(row.updatedAt, T, 'updatedAt must equal the causal watermark')
  db.close()
})

/* ---------------- fix 5: deleted meta keys ride snapshots as tombstones ---------------- */

test('fix 5: metaSnapshotRows emits a tombstone for a locally deleted key with retained pointers', () => {
  const state = freshDevice('meta-snap')
  db.call('setMeta', ['d13k5', 'value-v1']) // mints a ('meta','d13k5') pointer
  assert.equal(db.call('deleteMeta', 'd13k5'), true, 'the key existed; deletion is real')
  const rows = syncApply.metaSnapshotRows(state)
  const tomb = rows.find(r => r.id === 'd13k5')
  assert.ok(tomb, 'red before the fix: the deleted key was invisible to snapshot pushes')
  assert.equal(tomb.deleted, true)
  assert.equal(tomb.data, null)
  assert.ok(tomb.deletedAt > 0, 'aged by the retained pointer ts')
  // live keys still enumerate as live rows
  db.call('setMeta', ['d13k5live', 'v2'])
  const live = syncApply.metaSnapshotRows(state).find(r => r.id === 'd13k5live')
  assert.ok(live && !live.deleted && live.data.value === 'v2')
  db.close()
})

test('fix 5: machine-local keys never appear as snapshot tombstones', () => {
  const state = freshDevice('meta-snap-local')
  db.call('setMeta', ['sync.somethingLocal', 'x'])
  db.call('deleteMeta', 'sync.somethingLocal')
  const rows = syncApply.metaSnapshotRows(state)
  assert.equal(rows.find(r => r.id === 'sync.somethingLocal'), undefined, "'sync.*' stays machine-local even when deleted")
  db.close()
})

/* ---------------- fix 6: backfill pointers carry the real age ---------------- */

test('fix 6: a meta key seeded at stamp 1 loses LWW to a peer edit with a mid-past updatedAt', () => {
  const state = freshDevice('seed-stamp')
  db.call('appendOplogPointers', [{ entity: 'meta', id: 'd13k6', ts: 1 }])
  const ptr = (db.call('syncOplogSince', { sinceSeq: 0, limit: 10000 }) || []).find(r => r.entityId === 'd13k6')
  assert.equal(ptr.ts, 1, 'appendOplogPointers honors the explicit per-row ts')
  // local value exists but carries only the epoch-oldest seeded age; a peer edit from the
  // mid-past must win LWW (red before the fix: the seeded pointer was Date.now())
  const midPast = Date.now() - 5000
  const ok = syncApply.applyRowSafe(state, {
    entity: 'meta', id: 'd13k6', seq: 2, ts: midPast, updatedAt: midPast,
    deleted: false, deletedAt: 0, data: { key: 'd13k6', value: 'peer-newer' },
  })
  assert.equal(ok, true, 'the peer row wins LWW over the epoch-oldest legacy seed')
  assert.equal(db.call('getMeta', 'd13k6'), 'peer-newer')
  db.close()
})

test('fix 6: a pointer without ts still backfills at now (callers unchanged)', () => {
  freshDevice('seed-now')
  db.call('appendOplogPointers', [{ entity: 'meta', id: 'd13k6b' }])
  const ptr = (db.call('syncOplogSince', { sinceSeq: 0, limit: 10000 }) || []).find(r => r.entityId === 'd13k6b')
  assert.ok(Math.abs(ptr.ts - Date.now()) < 5000, 'no-ts rows keep the now-stamp behavior')
  db.close()
})

/* ---------------- fix 8: honest category tombstone stamps ---------------- */

test('fix 8: a legacy 0-stamp category tombstone hydrates with deletedAt 0, not ptr.ts', () => {
  const T = Date.now() - 30000
  const ptrTs = Date.now() - 100 // the pointer is much younger than the true deletion
  const cache = { category: () => ({ id: 7, deleted: 1, deletedAt: 0, updatedAt: T }) }
  const row = hydrate.hydrateRow({}, { entity: 'category', entityId: '7', seq: 1, ts: ptrTs }, cache)
  assert.equal(row.deleted, true)
  assert.equal(row.deletedAt, 0, 'red before the fix: the fabricated ptr.ts age')
  assert.equal(row.updatedAt, T, 'the row’s honest updatedAt wins over ptr.ts')
  // row-gone case keeps the ptr.ts fallback (no stamp exists anywhere)
  const gone = hydrate.hydrateRow({}, { entity: 'category', entityId: '8', seq: 2, ts: ptrTs }, { category: () => undefined })
  assert.equal(gone.deletedAt, ptrTs)
})

/* ---------------- fix 9: deleteMeta is result-aware ---------------- */

test('fix 9: deleting an ABSENT meta key mints no phantom oplog delta; a present one does', () => {
  freshDevice('delmeta')
  assert.equal(db.call('deleteMeta', 'd13-absent'), false, 'absent key → false (was unconditional true)')
  const phantom = (db.call('syncOplogSince', { sinceSeq: 0, limit: 10000 }) || []).filter(r => r.entity === 'meta' && r.entityId === 'd13-absent')
  assert.equal(phantom.length, 0, 'red before the fix: one phantom tombstone pointer')
  db.call('setMeta', ['d13-present', 'v'])
  assert.equal(db.call('deleteMeta', 'd13-present'), true, 'present key → true')
  const real = (db.call('syncOplogSince', { sinceSeq: 0, limit: 10000 }) || []).filter(r => r.entity === 'meta' && r.entityId === 'd13-present')
  assert.equal(real.length, 2, 'setMeta + deleteMeta pointers both captured')
  db.close()
})
