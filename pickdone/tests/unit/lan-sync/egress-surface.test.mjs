/**
 * Unit tests for the LAN sync egress/ingest surface factory
 * (src/main/lan-sync-egress.js), driven through a minimal fake ctx:
 *   - getState() returns a swappable fake state { db, engine, applyCache, pendingToSeq,
 *     egressHydrationFailures }
 *   - syncApply is a stub exposing createHydrationCache / hydrateRow / applyRowSafe /
 *     isMachineLocalSettingKey / metaSnapshotRows
 *
 * Contracts pinned here:
 *   S2 egress truncation: a hydrateRow THROW truncates the delta — incompleteAtSeq is the
 *   minimum failed seq, failed rows and rows past the truncation point are never pushed,
 *   failures are reported on state.egressHydrationFailures, and the failure event is emitted.
 *   A clean run returns a plain array (no marker).
 *   d12 schemaVersion gate: a NEWER peer snapshot throws on both assembled and chunked
 *   receive paths; equal/older/absent versions pass.
 *   P0-1 flush honesty: a finalizeIngest failure on ingestSnapshotAssembled/Chunked throws
 *   (the pull watermark never advances over dropped rows) and applyCache is cleared in the
 *   finally block either way.
 *   buildSegmentsWrapped: stamps state.pendingToSeq from the engine result's toSeq and
 *   returns only the segments.
 *   withPeerDeviceId: stamps body.deviceId onto each row only when the body carries both
 *   a deviceId and a rows array.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createEgressSurface } = require('../../../src/main/lan-sync-egress.js')

const SCHEMA_VERSION = 3

/** Build a fake ctx. Individual tests swap behavior on the returned handles. */
function makeCtx () {
  const state = {
    db: null, // set per-test
    engine: null,
    applyCache: 'NOT-CLEARED',
    pendingToSeq: 'NOT-STAMPED',
    egressHydrationFailures: null,
  }
  const log = { warn () {}, info () {}, error () {} }
  const events = []
  // The factory destructures the function-valued ctx fields ONCE, so tests configure
  // behavior through these mutable handlers (the ctx fields delegate to them).
  const handlers = { finalizeIngest: () => {}, busWrite: () => {}, flushPendingWrites: () => ({ ok: true }) }
  const syncApply = {
    createHydrationCache: () => ({ cache: 'fresh' }),
    // Default: every pointer hydrates fine. The factory wraps hydrateRow(ptr, cache) and
    // applyRowSafe(row) over (state, ...args), so the stub receives state as arg 0.
    hydrateRow: (st, ptr) => ({ entity: ptr.entity, id: ptr.entityId, seq: ptr.seq, updatedAt: 1, deleted: false, deletedAt: 0, data: { v: ptr.seq } }),
    applyRowSafe: () => true,
    isMachineLocalSettingKey: () => false,
    metaSnapshotRows: () => [],
  }
  const ctx = {
    state, events, handlers,
    getState: () => state,
    log,
    emitSyncEvent: (name, payload) => events.push({ name, payload }),
    syncApply,
    busWrite: (...a) => handlers.busWrite(...a),
    flushPendingWrites: (...a) => handlers.flushPendingWrites(...a),
    finalizeIngest: (...a) => handlers.finalizeIngest(...a),
    oplogKeepLimit: keep => keep,
    SYNC_OPLOG_KEEP: 5000,
    CURSOR_META_KEY: 'lanSync.pullCursor',
    SYNC_SCHEMA_VERSION: SCHEMA_VERSION,
  }
  const surface = createEgressSurface(ctx)
  return { ctx, state, surface, events, syncApply, handlers }
}

function ptrs (...seqs) {
  return seqs.map(seq => ({ entity: 'todo', entityId: 't' + seq, seq }))
}

test('S2: a hydrateRow throw truncates the delta — incompleteAtSeq is the MINIMUM failed seq, failed rows never pushed', () => {
  const { state, surface, syncApply, events } = makeCtx()
  state.db = { call: op => op === 'syncOplogSince' ? ptrs(1, 2, 3, 4, 5) : null }
  const realHydrate = syncApply.hydrateRow
  syncApply.hydrateRow = (st, ptr) => {
    if (ptr.seq === 2 || ptr.seq === 4) {
      const e = new Error('db read failed for ' + ptr.entityId)
      throw e
    }
    return realHydrate(st, ptr)
  }

  const result = surface.createLocalStoreAdapter().getRowsSince(0)

  assert.ok(!Array.isArray(result), 'a truncated delta returns the marker object, not a plain array')
  assert.equal(result.incompleteAtSeq, 2, 'the delta stops at the FIRST failed seq')
  assert.deepEqual(result.rows.map(r => r.seq), [1], 'rows at/past the truncation point are never pushed')
  assert.equal(state.egressHydrationFailures.length, 2, 'both failures are counted for visibility')
  assert.deepEqual(state.egressHydrationFailures.map(f => f.seq).sort(), [2, 4])
  assert.equal(state.egressHydrationFailures[0].entity, 'todo')
  assert.match(state.egressHydrationFailures[0].error, /db read failed/)
  assert.equal(events[0].name, 'egress-hydration-failed')
  assert.equal(events[0].payload.incompleteAtSeq, 2)
  assert.equal(events[0].payload.count, 2)
})

test('S2: a clean hydration run returns a plain rows array with no truncation marker', () => {
  const { state, surface, events } = makeCtx()
  state.db = { call: op => op === 'syncOplogSince' ? ptrs(10, 11, 12) : null }

  const rows = surface.createLocalStoreAdapter().getRowsSince(5)

  assert.ok(Array.isArray(rows), 'no failures -> the legacy plain-array shape')
  assert.deepEqual(rows.map(r => r.seq), [10, 11, 12])
  assert.deepEqual(state.egressHydrationFailures, [], 'the failure report is set to an empty list (visibility field is always current)')
  assert.equal(events.length, 0)
})

test('d12: a NEWER peer snapshot schemaVersion throws on both receive paths; equal/older/absent pass', () => {
  const { state, surface } = makeCtx()
  state.db = { call: () => null }
  state.engine = null

  const newer = { schemaVersion: SCHEMA_VERSION + 1, rows: [] }
  assert.throws(() => surface.ingestSnapshotAssembled(newer), /schemaVersion '?(N|\d)/)
  assert.throws(() => surface.ingestSnapshotChunked(newer), /newer than supported/)
  // The gate fires BEFORE any row is applied.
  const newerWithRows = { schemaVersion: SCHEMA_VERSION + 5, rows: [{ entity: 'todo', id: 'x' }] }
  assert.throws(() => surface.ingestSnapshotAssembled(newerWithRows), /newer than supported/)

  for (const ok of [{ schemaVersion: SCHEMA_VERSION, rows: [] }, { schemaVersion: SCHEMA_VERSION - 1, rows: [] }, { rows: [] }]) {
    assert.equal(surface.ingestSnapshotAssembled(ok).rows, 0)
    assert.equal(surface.ingestSnapshotChunked(ok).rows, 0)
  }
})

test('P0-1: a finalizeIngest failure throws on assembled and chunked paths — applyCache is cleared in the finally', () => {
  const { state, surface, ctx, handlers } = makeCtx()
  state.db = { call: () => null }
  let applied = 0
  ctx.syncApply.applyRowSafe = (st, r) => { applied++; return true }
  handlers.finalizeIngest = () => { throw new Error('flush failed: WAL full') }

  const body = { schemaVersion: SCHEMA_VERSION, deviceId: 'peer-1', rows: [{ entity: 'todo', id: 'a' }, { entity: 'todo', id: 'b' }] }
  assert.throws(() => surface.ingestSnapshotAssembled(body), /flush failed/)
  assert.equal(applied, 2, 'rows were applied before the flush, but the ROUND still fails (no watermark advance)')
  assert.equal(state.applyCache, null, 'the apply cache is reset even on the failure path')
  applied = 0
  assert.throws(() => surface.ingestSnapshotChunked(body), /flush failed/)
  assert.equal(applied, 2)
  assert.equal(state.applyCache, null)
})

test('ingest success: rows are applied with the peer deviceId stamped and the row count is returned', () => {
  const { state, surface, ctx } = makeCtx()
  state.db = { call: () => null }
  const seen = []
  ctx.syncApply.applyRowSafe = (st, r) => { seen.push(r); return true }

  const body = { schemaVersion: SCHEMA_VERSION, deviceId: 'peer-9', rows: [{ entity: 'todo', id: 'a', data: {} }, { entity: 'todo', id: 'b', data: {} }] }
  assert.equal(surface.ingestSnapshotAssembled(body).rows, 2)
  assert.deepEqual(seen.map(r => r.deviceId), ['peer-9', 'peer-9'], 'every ingested row carries the peer deviceId')
  assert.equal(state.applyCache, null, 'the cache is cleared on success too')
})

test('withPeerDeviceId stamps deviceId only for a body with deviceId AND a rows array', () => {
  const { surface } = makeCtx()
  const body = { deviceId: 'd1', rows: [{ entity: 'todo', id: 'a' }, { entity: 'todo', id: 'b', deviceId: 'keep-me' }] }
  const stamped = surface.withPeerDeviceId(body)
  assert.deepEqual(stamped.rows.map(r => r.deviceId), ['d1', 'd1'], 'per-row values are overwritten by the body deviceId')
  assert.notEqual(stamped, body, 'the input body is not mutated')

  assert.deepEqual(surface.withPeerDeviceId({ deviceId: 'd1' }), { deviceId: 'd1' }, 'no rows array -> returned untouched')
  assert.deepEqual(surface.withPeerDeviceId({ rows: [{ id: 'x' }] }), { rows: [{ id: 'x' }] }, 'no deviceId -> returned untouched')
  assert.equal(surface.withPeerDeviceId(null), null)
})

test('buildSegmentsWrapped stamps state.pendingToSeq from the engine result and returns only segments', () => {
  const { state, surface } = makeCtx()
  state.db = { call: () => null }
  const requested = []
  state.engine = {
    buildSegments: sinceSeq => {
      requested.push(sinceSeq)
      return { toSeq: 777, segments: [{ fromSeq: 1, toSeq: 777, rows: ['r1'] }] }
    },
  }

  const segments = surface.buildSegmentsWrapped(1)
  assert.deepEqual(requested, [1], 'the sinceSeq reaches the engine unchanged')
  assert.equal(state.pendingToSeq, 777, 'pendingToSeq is stamped from the engine result (pending-send honesty)')
  assert.deepEqual(segments, [{ fromSeq: 1, toSeq: 777, rows: ['r1'] }], 'only the segments are returned')
})

test('adapter getCursor/setCursor: the cursor is numeric-or-0 and writes go through busWrite', () => {
  const { state, surface, ctx, handlers } = makeCtx()
  const meta = new Map()
  state.db = { call: (op, p) => op === 'getMeta' ? (meta.has(p) ? meta.get(p) : null) : null }
  handlers.busWrite = (op, args) => { if (op === 'setMeta') meta.set(args[0], args[1]) }
  const adapter = surface.createLocalStoreAdapter()

  assert.equal(adapter.getCursor(), 0, 'a missing cursor reads as 0')
  meta.set(ctx.CURSOR_META_KEY, '42')
  assert.equal(adapter.getCursor(), 42)
  meta.set(ctx.CURSOR_META_KEY, 'not-a-number')
  assert.equal(adapter.getCursor(), 0, 'a garbage cursor reads as 0, never NaN')

  adapter.setCursor(99)
  assert.equal(meta.get(ctx.CURSOR_META_KEY), '99')
})

test('adapter replaceAll: a failed flush throws with the flush error surfaced to the engine', () => {
  const { state, surface, ctx, handlers } = makeCtx()
  state.db = { call: () => null }
  const applied = []
  ctx.syncApply.applyRowSafe = (st, r) => { applied.push(r); return true }
  handlers.flushPendingWrites = () => ({ ok: false, error: new Error('bulk write dropped') })

  assert.throws(() => surface.createLocalStoreAdapter().replaceAll([{ entity: 'todo', id: 'a' }]), /replaceAll flush failed.*bulk write dropped/)
  assert.equal(applied.length, 1, 'rows were attempted before the flush failure — the throw is what stops the watermark')

  handlers.flushPendingWrites = () => ({ ok: true })
  assert.doesNotThrow(() => surface.createLocalStoreAdapter().replaceAll([]))
})

test('adapter allRows: machine-local settings rows never leave the device', () => {
  const { state, surface, ctx } = makeCtx()
  state.db = {
    call: op => {
      if (op === 'settingsRowsAll') {
        return [
          { key: 'ui.theme', value: 'dark', updatedAt: 5, deleted: false },
          { key: 'securityLock.hash', value: 'secret', updatedAt: 6, deleted: false }, // machine-local namespace
          { key: 'sync.identity.key', value: 'priv', updatedAt: 7, deleted: false }, // 'sync.' identity namespace
        ]
      }
      if (op === 'tomatoAll') return [{ tomatoId: 'tm1', updatedAt: 9 }]
      if (op === 'tomatoTombstones') return [{ tomatoId: 'tm2', updatedAt: 10, deletedAt: 3 }]
      return null
    },
  }
  ctx.syncApply.isMachineLocalSettingKey = key => key.startsWith('securityLock') || key.startsWith('sync.')

  const rows = surface.createLocalStoreAdapter().allRows()
  const settingIds = rows.filter(r => r.entity === 'setting').map(r => r.id)
  assert.deepEqual(settingIds, ['ui.theme'], 'machine-local settings are excluded from the snapshot surface')
  const tm2 = rows.find(r => r.entity === 'tomato' && r.id === 'tm2')
  assert.equal(tm2.deleted, true, 'tomato tombstones ride along as deleted rows (X1)')
})
