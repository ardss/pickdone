'use strict'

/**
 * Snapshot chunking for the LAN sync snapshot-request protocol (2026-09-18).
 *
 * A full snapshot of the live state can far exceed a single transport line, so
 * it travels as N bounded `snapshot-chunk` messages + one `snapshot-end`
 * trailer — the same oversize-shedding philosophy as engine.buildSegments
 * (no single JSON line ever approaches the transport's 16MB cap):
 *
 *   snapshot-request {}                          receiver -> sender
 *   snapshot-chunk {id, index, of, schemaVersion, rows:[...]}   sender -> receiver
 *   snapshot-end   {id, totalRows, cursor, schemaVersion}       sender -> receiver
 *
 * `cursor` is the sender's current max oplog seq at build time: the receiver
 * records it as its pull watermark for that peer ONLY after snapshot-end
 * (all chunks applied) — a partial snapshot never advances the watermark.
 *
 * Pure functions over plain objects/JSON strings; no I/O, no Electron. CommonJS.
 */

// Per-message row budget (~1MB of serialized rows). Conservative headroom under
// the transport's post-auth 16MB line cap; mirrors the segment packer's budgeting.
const SNAPSHOT_CHUNK_BYTES = 1024 * 1024

/**
 * Split a built snapshot into transport-safe chunks.
 * @param {string|object} body engine.buildSnapshot() output (canonical JSON string or parsed object)
 *   — must carry `rows` (array of merge rows) and may carry `schemaVersion`.
 * @param {{ maxChunkBytes?: number, cursor?: number }} opts
 *   cursor = sender's current max oplog seq, echoed back in snapshot-end by the caller.
 * @returns {{ chunks: Array<{index, of, rows}>, totalRows: number, schemaVersion: number, cursor: number }}
 */
function chunkSnapshot (body, opts = {}) {
  const maxChunkBytes = opts.maxChunkBytes || SNAPSHOT_CHUNK_BYTES
  const cursor = Number(opts.cursor) || 0
  let snap = body
  if (typeof body === 'string') snap = JSON.parse(body)
  if (!snap || !Array.isArray(snap.rows)) throw new Error('chunkSnapshot: snapshot body has no rows array')
  const schemaVersion = Number(snap.schemaVersion) || 1
  const chunks = []
  let batch = []
  let batchBytes = 0
  const flush = () => {
    if (!batch.length) return
    chunks.push({ index: chunks.length, of: 0, rows: batch })
    batch = []
    batchBytes = 0
  }
  for (const row of snap.rows) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8')
    if (rowBytes > maxChunkBytes) throw new Error('chunkSnapshot: single row exceeds chunk budget')
    if (batch.length && batchBytes + rowBytes > maxChunkBytes) flush()
    batch.push(row)
    batchBytes += rowBytes
  }
  flush()
  for (const c of chunks) c.of = chunks.length
  return { chunks, totalRows: snap.rows.length, schemaVersion, cursor }
}

module.exports = { chunkSnapshot, SNAPSHOT_CHUNK_BYTES }
