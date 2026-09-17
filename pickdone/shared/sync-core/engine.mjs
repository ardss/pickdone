/**
 * PickDone sync-core: transport-agnostic sync engine (design doc §4.1–§4.2).
 *
 * Wires ./merge.mjs (conflict rules) and ./segment.mjs (codec) into the three
 * sync primitives a transport (P3a LAN / P3b cloud) needs:
 *   - push:    buildSegments() + markPushed(toSeq)  — cursor crash semantics
 *   - pull:    ingestSegment(body)                  — validate, apply in seq order
 *   - bootstrap: buildSnapshot() / applySnapshot()   — fresh-device path
 *
 * LOCAL STORE ADAPTER CONTRACT (implemented by the app over its real DB):
 *   getRowsSince(seq) -> rows [{seq, entity?, entityId?, ts?, ...}] from oplog
 *   applyRow(row)     -> boolean; runs merge rules, true when state changed
 *   getCursor() / setCursor(pushedSeq)  — persisted push cursor
 *   allRows()         -> current live rows (incl. tombstones)
 *   replaceAll(rows)  -> fresh-device reset (used by applySnapshot only)
 *
 * Crash semantics (§4.1): the push cursor advances ONLY after the transport
 * confirms delivery (markPushed). A crash mid-push leaves the cursor where it
 * was, so the next buildSegments() re-packs from the same seq — re-pushed rows
 * are idempotent under the merge rules. Whole-segment re-push, never partial.
 *
 * Purity: no I/O, no timers, no Date.now()/Math.random — time comes from the
 * injected `clock`; the default is a monotonic counter. Zero Node imports
 * (pairing.mjs is the deliberate platform-boundary exception, see its header).
 */

import { SYNC_SCHEMA_VERSION } from './merge.mjs'
import { pack, unpack, MAX_SEGMENT_BYTES } from './segment.mjs'

const MAX_SEGMENT_LEN = MAX_SEGMENT_BYTES // local alias for readability

/** Default injected clock: deterministic monotonic counter (tests). */
function monotonicClock() {
  let t = 0
  return () => ++t
}

/** Canonical JSON: object keys sorted recursively — byte-deterministic output. */
export function canonicalStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalStringify).join(',')}]`
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(value[k])}`).join(',')}}`
}

/**
 * @param {{ localStore: object, deviceId: string, clock?: () => number }} opts
 */
export function createEngine({ localStore, deviceId, clock = monotonicClock() }) {
  if (!localStore) throw new Error('createEngine: localStore adapter is required')
  if (!deviceId) throw new Error('createEngine: deviceId is required')

  /**
   * PUSH — pack all oplog rows since the persisted cursor into segments. An explicit fromSeq
   * (per-peer push watermark, see lan-sync) overrides the global cursor: dead/stale peers must not
   * gate what a reachable peer receives, and a global cursor would skip rows a lagging peer needs.
   * Greedy size-bounded packing: rows accumulate until the next row would
   * overflow the 256KB cap, then the segment is flushed. Does NOT advance the
   * cursor; the transport calls markPushed(toSeq) after confirmed delivery.
   * @returns {{ segments: Array<{body, fromSeq, toSeq}>, toSeq: number }}
   *   toSeq = highest included seq (0 when nothing to push).
   */
  function buildSegments() {
    const cursor = localStore.getCursor() ?? 0
    const rows = localStore.getRowsSince(cursor)
    const segments = []
    // Pack budget: leave headroom for the segment header + JSON overhead;
    // pack() still enforces the hard cap and throws SegmentTooLarge if a
    // SINGLE row cannot fit (a caller bug, not something to split).
    const budget = MAX_SEGMENT_LEN - 512
    let batch = []
    let batchBytes = 0
    let fromSeq = 0
    let toSeq = 0
    const flush = () => {
      if (!batch.length) return
      segments.push({ body: pack(batch, { fromSeq, toSeq, deviceId }), fromSeq, toSeq })
      batch = []
      batchBytes = 0
    }
    for (const row of rows) {
      const s = row.seq
      const rowBytes = canonicalStringify(row).length
      if (batch.length && batchBytes + rowBytes > budget) flush()
      if (!batch.length) fromSeq = s
      batch.push(row)
      batchBytes += rowBytes
      toSeq = s
    }
    flush()
    return { segments, toSeq }
  }

  /** PUSH — advance the cursor after the transport confirmed delivery. */
  function markPushed(toSeq) {
    if (!Number.isInteger(toSeq) || toSeq < 0) {
      throw new Error(`markPushed: invalid seq ${toSeq}`)
    }
    if (toSeq > (localStore.getCursor() ?? 0)) localStore.setCursor(toSeq)
  }

  /**
   * PULL — validate and apply a received segment body. Rows are applied in
   * segment order (the codec guarantees strictly increasing seq). Segments
   * originated by this device are ignored wholesale (loopback echo).
   * @returns {{ applied: number, rejected: number }}
   */
  function ingestSegment(input) {
    // Accept either the packed body string or the {body} envelope as delivered by a transport
    // (transports carry the envelope object; the 2026-09-17 live drill caught the mismatch).
    const envelope = unpack(input && typeof input === 'object' && typeof input.body === 'string' ? input.body : input)
    if (envelope.deviceId === deviceId) return { applied: 0, rejected: 0 }
    let applied = 0
    let rejected = 0
    for (const row of envelope.rows) {
      if (localStore.applyRow(row)) applied++
      else rejected++
    }
    return { applied, rejected }
  }

  /**
   * SNAPSHOT — full state as one canonical (byte-deterministic) JSON string.
   * Includes the origin's max seq so a peer can resume increments cleanly.
   */
  function buildSnapshot() {
    const rows = [...localStore.allRows()].sort((a, b) =>
      String(a.id).localeCompare(String(b.id))
    )
    const maxSeq = rows.reduce((m, r) => Math.max(m, r.seq ?? 0), 0)
    return canonicalStringify({
      schemaVersion: SYNC_SCHEMA_VERSION,
      deviceId,
      createdAt: clock(),
      maxSeq,
      rows,
    })
  }

  /**
   * SNAPSHOT — fresh-device path: validate, atomically replace local state,
   * reset the push cursor (nothing of ours has been pushed yet). Idempotent:
   * applying the same snapshot twice converges to the same state.
   */
  function applySnapshot(body) {
    let snap
    try {
      snap = JSON.parse(body)
    } catch {
      throw new Error('applySnapshot: body is not valid JSON')
    }
    if (snap.schemaVersion !== SYNC_SCHEMA_VERSION) {
      throw new Error(`applySnapshot: schemaVersion ${snap.schemaVersion} != ${SYNC_SCHEMA_VERSION}`)
    }
    if (!Array.isArray(snap.rows)) throw new Error('applySnapshot: rows must be an array')
    localStore.replaceAll(snap.rows)
    localStore.setCursor(0)
    return { rows: snap.rows.length, deviceId: snap.deviceId, maxSeq: snap.maxSeq ?? 0 }
  }

  return { deviceId, buildSegments, markPushed, ingestSegment, buildSnapshot, applySnapshot }
}
