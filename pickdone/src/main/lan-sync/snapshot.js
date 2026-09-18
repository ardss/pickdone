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

/**
 * Stream bounded chunks directly from a ROWS ARRAY without ever materializing the full
 * snapshot JSON (2026-09-18): buildSnapshot() string -> JSON.parse -> re-stringify held
 * ~3x the whole dataset in memory on the sender. The LAN-sync sender path uses this
 * generator over the allRows() array (sorted by entity/id like buildSnapshot) — peak
 * memory is one copy of the rows array plus one chunk.
 * @param {Array} rows merge rows (already sorted by the caller, mirroring engine.buildSnapshot)
 * @param {{ maxChunkBytes?: number }} opts
 * @yields {{ rows: Array }} successive bounded batches
 */
function* rowChunks (rows, opts = {}) {
  const maxChunkBytes = opts.maxChunkBytes || SNAPSHOT_CHUNK_BYTES
  if (!Array.isArray(rows)) throw new Error('rowChunks: rows must be an array')
  let batch = []
  let batchBytes = 0
  for (const row of rows) {
    const rowBytes = Buffer.byteLength(JSON.stringify(row), 'utf8')
    if (rowBytes > maxChunkBytes) throw new Error('rowChunks: single row exceeds chunk budget')
    if (batch.length && batchBytes + rowBytes > maxChunkBytes) {
      yield { rows: batch }
      batch = []
      batchBytes = 0
    }
    batch.push(row)
    batchBytes += rowBytes
  }
  if (batch.length) yield { rows: batch }
}

/**
 * Validate + finalize a received snapshot at snapshot-end (client side of the
 * snapshot-request protocol). Two receiver modes:
 *   - streaming (chunkRowCounts populated): chunks were applied on arrival; only the tiling
 *     and totalRows are validated here — `rows` stays null (never re-materialized).
 *   - fallback (chunkBuf populated): the buffered chunks are validated AND assembled into
 *     the full rows array for a single ingestSnapshot call.
 * @returns {{ ok: boolean, chunkCount: number, rows?: Array|null, reason?: string }}
 */
function finalizeSnapshot ({ declaredChunks, chunkTotal, totalRows, chunkBuf, chunkRowCounts }) {
  const chunkCount = Number.isInteger(declaredChunks) && declaredChunks >= 0 ? declaredChunks : chunkTotal
  const streaming = !!(chunkRowCounts && chunkRowCounts.size)
  if (chunkCount === 0) {
    const extra = (chunkBuf && chunkBuf.size) || (chunkRowCounts && chunkRowCounts.size) || 0
    if (totalRows !== 0 || extra) {
      return { ok: false, chunkCount, reason: 'incomplete snapshot: empty trailer but chunks/rows were advertised' }
    }
    return { ok: true, chunkCount, rows: [] }
  }
  const indices = streaming ? chunkRowCounts : chunkBuf
  const okShape = Number.isInteger(chunkCount) && chunkCount > 0 && indices.size === chunkCount &&
    Array.from({ length: chunkCount }, (_, i) => indices.has(i)).every(Boolean)
  const receivedRows = streaming
    ? Array.from(chunkRowCounts.values()).reduce((a, b) => a + b, 0)
    : (okShape ? Array.from({ length: chunkCount }, (_, i) => chunkBuf.get(i)).flat().length : 0)
  if (!okShape || receivedRows !== totalRows) {
    return { ok: false, chunkCount, reason: `incomplete snapshot: ${okShape ? receivedRows : 'bad chunk set'} of ${totalRows} rows` }
  }
  const rows = streaming ? null : Array.from({ length: chunkCount }, (_, i) => chunkBuf.get(i)).flat()
  return { ok: true, chunkCount, rows }
}

module.exports = { chunkSnapshot, rowChunks, finalizeSnapshot, SNAPSHOT_CHUNK_BYTES }
