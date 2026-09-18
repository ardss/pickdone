'use strict'

/**
 * Segment-push chunking (2026-09-18): a first-sync backlog used to travel as ONE
 * `segments` JSON line — tens of MB of plaintext, ~4/3 larger once AES-GCM base64
 * framing is applied, so the wire line blew past the transport's 32MB cap, the
 * receiver destroyed the socket, and the round retried forever (permanent sync
 * failure exactly when the backlog is largest).
 *
 * The push now travels as N bounded `segments-chunk` messages + a `final` flag:
 *
 *   segments-chunk {segments:[...envelopes...], final:false}   sender -> receiver
 *   segments-chunk {segments:[...], final:true}                last chunk (possibly empty)
 *   ack {applied, rejected, appliedToSeq?, oldestSeq?}         receiver -> sender, ONCE, at final
 *
 * The receiver ingests per chunk (idempotent under the merge rules) and acks once
 * when `final` arrives, reporting appliedToSeq in the SENDER's seq space across
 * ALL ingested chunks. Always at least one chunk is emitted — an empty backlog is
 * a single `{segments:[], final:true}` so the round still terminates with an ack.
 *
 * Pure functions over plain objects; no I/O, no Electron. CommonJS.
 */

// Per-message payload budget (~1MB of JSON). Conservative headroom under the
// transport's post-auth 32MB wire cap even after base64 inflation of the
// encrypted frame (~4/3) — mirrors the snapshot chunker's budgeting.
const SEGMENT_CHUNK_BYTES = 1024 * 1024

/**
 * Split a buildSegments() result into transport-safe chunk messages.
 * @param {Array<{body, fromSeq, toSeq}>} segments segment envelopes
 * @param {{ maxChunkBytes?: number }} opts
 * @returns {Array<{segments: Array, final: boolean}>} at least one entry; the last has final:true
 */
function packSegmentChunks (segments, opts = {}) {
  if (segments != null && !Array.isArray(segments)) throw new Error('packSegmentChunks: segments must be an array')
  const maxChunkBytes = opts.maxChunkBytes || SEGMENT_CHUNK_BYTES
  const list = segments || []
  const chunks = []
  let batch = []
  let batchBytes = 0
  const flush = (final) => {
    chunks.push({ segments: batch, final })
    batch = []
    batchBytes = 0
  }
  for (const seg of list) {
    // Measure the packed body when present (engine envelopes); fall back to the whole envelope
    // (rows-carrying shape used by tests / non-packed producers).
    const bytes = Buffer.byteLength(JSON.stringify(seg && seg.body != null ? seg.body : seg), 'utf8')
    if (batch.length && batchBytes + bytes > maxChunkBytes) flush(false)
    batch.push(seg)
    batchBytes += bytes
  }
  flush(true) // always emit the terminal chunk (empty backlog = one empty final chunk)
  return chunks
}

module.exports = { packSegmentChunks, SEGMENT_CHUNK_BYTES }
