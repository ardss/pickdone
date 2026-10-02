/**
 * Regression tests, 2026-10-02 fix round (domain-D):
 *   1. sync-snapshot-schemaversion-never-validated (P2): the snapshot RECEIVE path
 *      (ingestSnapshot / ingestSnapshotChunk) never read body.schemaVersion — a NEWER peer's
 *      snapshot applied rows silently. Both receivers must now throw on
 *      schemaVersion > SYNC_SCHEMA_VERSION (older versions stay accepted, `|| 1` coercion) and
 *      apply ZERO rows when they throw.
 *   2. perf-att-missing-keys-full-scan-per-round (P3):
 *      (a) the missing-attachment key collection is memoized on max oplog seq — two consecutive
 *          rounds with no DB change read the live table (getAll) exactly once;
 *      (b) an advanced oplog seq invalidates the cache — getAll runs again;
 *      (c) noteMissing dedupes overlapping keys in O(1) — no duplicates enqueued.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { __test } = require('../../../src/main/lan-sync-bootstrap.js')
const { SYNC_SCHEMA_VERSION } = require('../../../shared/sync-core/merge.mjs')
const createPeerExtras = require('../../../src/main/lan-sync/peer-extras')
const { createAttachmentPuller } = require('../../../src/main/lan-sync/att-transfer')

const EMPTY_TABLES = {
  getAll: () => [],
  settingsRowsAll: () => [],
  tomatoAll: () => [],
  categoriesAllRows: () => [], planTombstones: () => [], filterTombstones: () => [],
  planAll: () => [],
  filterList: () => [],
}

function mockState (tables = {}) {
  const calls = []
  const pendingWrites = { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] }
  const db = {
    calls,
    call (op, params) {
      calls.push({ op, params })
      if (tables[op]) return tables[op](params)
      return null
    },
  }
  const state = {
    db,
    pendingWrites,
    applyCache: null,
    engine: null,
    node: null,
    timers: [],
    peerWatermarks: new Map(),
    pendingToSeq: 0,
    getWindowSenders: () => [],
  }
  return { state, calls, pendingWrites }
}

function fresh (tables) {
  const m = mockState(tables)
  __test.setState(m.state)
  return m
}

// A valid remote tombstone row: when applied against a local LIVE row it materializes the
// delete-winner + conflict copy in pendingWrites.todos (same shape as bootstrap-apply tests).
const remoteTombstone = { entity: 'todo', id: 't1', seq: 7, ts: 100, deleted: true, deletedAt: 99, data: null }
const LOCAL_LIVE = { ...EMPTY_TABLES, getAll: () => [{ taskId: 't1', updateTime: 50, delete: false, deletedAt: 0, taskContent: 'local edit' }] }

test('schema gate: ingestSnapshot throws on schemaVersion newer than supported and applies ZERO rows', () => {
  const m = fresh(LOCAL_LIVE)
  assert.throws(
    () => __test.ingestSnapshotAssembled({ schemaVersion: SYNC_SCHEMA_VERSION + 1, deviceId: 'peerA', rows: [remoteTombstone] }),
    /newer than supported/,
    'a newer-peer snapshot must be rejected, not applied silently'
  )
  assert.equal(m.pendingWrites.todos.length, 0, 'rejected snapshot must apply no rows')
  assert.equal(m.calls.find(c => c.op === 'upsertMany'), undefined, 'no busWrite may fire for a rejected snapshot')
})

test('schema gate: ingestSnapshot accepts the current schemaVersion and applies rows', () => {
  const m = fresh(LOCAL_LIVE)
  const r = __test.ingestSnapshotAssembled({ schemaVersion: SYNC_SCHEMA_VERSION, deviceId: 'peerA', rows: [remoteTombstone] })
  assert.deepEqual(r, { rows: 1 })
  // finalizeIngest flushes the buffered writes through the db ops, so assert on the FLUSHED
  // op, not on the (now drained) pendingWrites buffers.
  const up = m.calls.find(c => c.op === 'upsertMany')
  assert.ok(up, 'delete-winner + conflict copy must be flushed at the current version')
  assert.equal(up.params.length, 2)
  assert.match(String(up.params[0].taskId), /^t1-conflict-/, 'conflict copy first (suffixed id)')
  assert.equal(up.params[1].taskId, 't1')
})

test('schema gate: ingestSnapshot tolerates an OLDER/absent schemaVersion (|| 1 coercion, not fatal)', () => {
  for (const schemaVersion of [undefined, null, 1]) {
    const m = fresh(LOCAL_LIVE)
    const r = __test.ingestSnapshotAssembled({ schemaVersion, deviceId: 'peerA', rows: [remoteTombstone] })
    assert.deepEqual(r, { rows: 1 }, 'version ' + String(schemaVersion) + ' must not be fatal')
    assert.ok(m.calls.find(c => c.op === 'upsertMany'), 'rows applied at version ' + String(schemaVersion))
  }
})

test('schema gate: ingestSnapshotChunk throws on newer schemaVersion and applies ZERO rows', () => {
  const m = fresh(LOCAL_LIVE)
  assert.throws(
    () => __test.ingestSnapshotChunked({ schemaVersion: SYNC_SCHEMA_VERSION + 1, deviceId: 'peerA', rows: [remoteTombstone] }),
    /newer than supported/
  )
  assert.equal(m.pendingWrites.todos.length, 0, 'rejected chunk must apply no rows (watermark stays put at snapshot-end)')
})

/* ---------- perf: missing-attachment key collection memoized on oplog seq ---------- */

const peerExtras = createPeerExtras({ settingGet: () => null })
const ATTACH_DIR = process.cwd()

function extrasState (seqRef) {
  let getAllCount = 0
  const st = {
    db: {
      getAllCount: () => getAllCount,
      call (op) {
        if (op === 'getAll') { getAllCount += 1; return [{ image: JSON.stringify([{ url: 'local://a.png' }]) }] }
        if (op === 'syncOplogSince') return seqRef.value > 0 ? [{ seq: seqRef.value }] : []
        return null
      },
    },
  }
  const inject = { attachDir: ATTACH_DIR, existsSync: () => false }
  return { st, inject, getAll: () => getAllCount }
}

test('perf: two consecutive getMissingAttachmentKeys with no DB change read getAll exactly once', () => {
  const seqRef = { value: 0 }
  const h = extrasState(seqRef)
  const k1 = peerExtras.missingAttachmentKeys(h.st, h.inject)
  const k2 = peerExtras.missingAttachmentKeys(h.st, h.inject)
  assert.deepEqual(k1, ['a.png'])
  assert.deepEqual(k2, ['a.png'])
  assert.equal(h.getAll(), 1, 'cached on unchanged oplog seq — was 2 (full live-table scan per round)')
})

test('perf: an advanced oplog seq invalidates the cache and getAll runs again', () => {
  // Distinct seq values (the memo is module-level and shared across tests in this file).
  const seqRef = { value: 1000 }
  const h = extrasState(seqRef)
  peerExtras.missingAttachmentKeys(h.st, h.inject)
  seqRef.value = 2000 // a local write / applied row appended to the oplog
  peerExtras.missingAttachmentKeys(h.st, h.inject)
  assert.equal(h.getAll(), 2, 'cache must recompute after the oplog advances')
})

/* ---------- perf: noteMissing O(1) dedupe ---------- */

function freshPuller (opts = {}) {
  const sent = []
  const puller = createAttachmentPuller({
    maxFiles: opts.maxFiles || 20,
    deps: { exists: () => false },
    send: m => { sent.push(m); return true },
    ...opts,
  })
  return { puller, sent }
}

test('perf: noteMissing with 500 overlapping keys enqueues no duplicates', () => {
  const unique = Array.from({ length: 100 }, (_, i) => `key-${i}`)
  const keys = []
  for (let i = 0; i < 5; i++) keys.push(...unique) // 500 entries, 100 distinct
  const { puller, sent } = freshPuller({ maxFiles: 1000 })
  puller.noteMissing(keys)
  const started = puller.maybeStart(() => {})
  assert.equal(started, true)
  const req = sent.find(m => m.type === 'att-req')
  assert.ok(req, 'att-req must go out')
  assert.equal(req.ids.length, 100, 'only distinct keys may be enqueued')
  assert.equal(new Set(req.ids).size, 100)
})
