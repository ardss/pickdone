'use strict'

/**
 * Server-role message handler (extracted from lan-sync/index.js, round-3 review line ratchet).
 *
 * Handles the messages a CONNECTED PEER sends to OUR server role after auth:
 *   segments-chunk*  the peer's push: ingest per chunk, ack once at final (with appliedToSeq in
 *                    the SENDER's seq space + oldestSeq advertisement), then stream our own
 *                    response pull — starting past what the peer already acked (serverPullAck),
 *                    full window for unknown peers
 *   ack              the peer acking OUR push: record appliedToSeq (OUR seq space) so the NEXT
 *                    round's pull response is incremental
 *   snapshot-request stream the live state as bounded snapshot-chunks + snapshot-end trailer,
 *                    with a per-peer busy invariant (snapshot-busy) and a transfer ceiling
 *                    (snapshot-error 'too-large')
 *
 * Pure orchestration over injected callbacks — no Electron imports (electron-log is optional and
 * guarded). CommonJS.
 */

const { chunkSnapshot, rowChunks } = require('./snapshot')
const { packSegmentChunks } = require('./segments-chunk')

// Row-count ceiling for a served snapshot (round-3 review): beyond this the requester gets a
// clean snapshot-error {reason:'too-large'} instead of an unbounded stream.
const MAX_SNAPSHOT_ROWS = 1000000

/**
 * @param {object} deps
 *   deviceId, ingestSegment(segment), buildSegments(fromSeq?), buildSnapshot?, buildSnapshotRows?,
 *   getMaxSeq?(), getOldestSeq?(), serverSnapshotBusy (Set), serverPullAck (Map),
   *   maxSnapshotChunks (number), snapshotSchemaVersion (number),
   *   pushRecent(entry), onSnapshotError(info), onSnapshotSync(info), onServerError(err)
   * @returns {(peer, msg, socket, sendVia) => void}
   */
function createServerRoleHandler(deps) {
  const {
    ingestSegment, buildSegments, buildSnapshot, buildSnapshotRows,
    getMaxSeq, getOldestSeq, serverSnapshotBusy, serverPullAck,
    maxSnapshotChunks, snapshotSchemaVersion, pushRecent, onSnapshotError, onServerError,
  } = deps
  const maxSnapshotRows = Number(deps.maxSnapshotRows) || MAX_SNAPSHOT_ROWS
  const currentMaxSeq = () => { try { return Number(getMaxSeq()) || 0 } catch { return 0 } }
  const currentOldestSeq = () => { try { return Number(getOldestSeq()) || 0 } catch { return 0 } }

  return function handleServerMessage(peer, msg, socket, sendVia) {
    try {
      if (msg.type === 'segments-chunk' && Array.isArray(msg.segments)) {
        // Push receiver: ingest per chunk (idempotent under the merge rules) and ack ONCE at
        // the final chunk. appliedToSeq is expressed in the SENDER's seq space: the max seq
        // among the rows the sender pushed across ALL chunks of this connection (segment rows
        // carry the sender's oplog seq — engine buildSegments contract). The sender feeds it
        // into buildSegments(fromSeq) against ITS OWN oplog, so reporting OUR local max seq
        // here (the old behavior) overshot the sender's cursor whenever our oplog ran ahead
        // of theirs — their fresh rows were then skipped every round (permanent hole with
        // >=3 devices, watermark persisted). Empty push -> omit the field: the sender keeps
        // its cursor (monotonic guard). oldestSeq advertises the oldest oplog seq we still
        // RETAIN (our space): a peer whose pull watermark is below it knows its increments
        // are pruned here and must request a snapshot (see the client trigger).
        if (!socket._segPush) socket._segPush = { maxSeq: 0, segments: 0 }
        const acc = socket._segPush
        for (const seg of msg.segments) {
          ingestSegment(seg)
          acc.segments += 1
          // Wire envelopes are {body, fromSeq, toSeq}: the rows live INSIDE the packed body and
          // seg.rows NEVER exists. The old per-row loop iterated nothing, so acc.maxSeq stayed 0
          // and every ack omitted appliedToSeq — the sender's push watermark never advanced and
          // the full retained oplog window was re-pushed EVERY round (the 2026-09-19 live 7-18s
          // rounds). toSeq is the codec's highest-included seq for this segment (enforced by
          // SegmentRange validation at pack time) — exactly the max row seq the loop meant to
          // collect, in the SENDER's seq space.
          const to = Number(seg && seg.toSeq)
          if (Number.isFinite(to) && to > acc.maxSeq) acc.maxSeq = to
        }
        if (msg.final) {
          // The response pull travels through the SAME bounded chunking: the server's own
          // first-sync backlog is just as large as the client's. Round-3 review: the pull
          // used to call buildSegments() with no cursor EVERY round, re-sending the full
          // oplog window forever. The peer acks our pushed rows with appliedToSeq in OUR
          // seq space (recorded below on 'ack'); the next round's pull starts past it.
          // Unknown peer (or no ack yet) falls back to the full window.
          const acked = serverPullAck.get(peer.deviceId)
          const pullFrom = Number.isFinite(acked) && acked > 0
            ? Math.min(acked, currentMaxSeq()) // defensive clamp: a lying peer must not skip our fresh rows
            : undefined
          const mine = buildSegments ? buildSegments(pullFrom) : []
          for (const chunk of packSegmentChunks(mine)) {
            sendVia(socket, { type: 'segments-chunk', segments: chunk.segments, final: chunk.final })
          }
          sendVia(socket, {
            type: 'ack', applied: acc.segments, rejected: 0,
            ...(acc.maxSeq > 0 ? { appliedToSeq: acc.maxSeq } : {}),
            oldestSeq: getOldestSeq ? currentOldestSeq() : undefined,
          })
          socket._segPush = null // the acked push round is complete; a new push re-accumulates
        }
      } else if (msg.type === 'ack') {
        // The peer is acking OUR push (client role's pull response): appliedToSeq is the max
        // seq among our rows the peer applied — OUR seq space (see the segments-chunk branch
        // above). Recorded per peer so the NEXT round's pull response starts past what the
        // peer already has instead of re-sending the whole oplog window every round.
        const seq = Number(msg.appliedToSeq) || 0
        if (seq > (serverPullAck.get(peer.deviceId) || 0)) serverPullAck.set(peer.deviceId, seq)
      } else if (msg.type === 'snapshot-request') {
        // Snapshot-request protocol: stream the live state as bounded snapshot-chunk messages
        // + a snapshot-end trailer carrying OUR current cursor, so the peer records it as its
        // pull watermark and the next round is incremental. One transfer per peer at a time
        // (serverSnapshotBusy — the SERVER role's flag, independent of the client role's);
        // sends are synchronous, so the busy flag is a documented invariant guard. A request
        // while busy is answered with snapshot-busy (NOT silently dropped): a silent drop made
        // a mutual snapshot exchange deadlock until both rounds hit the 120s deadline.
        if (!buildSnapshot && !buildSnapshotRows) return
        if (serverSnapshotBusy.has(peer.deviceId)) {
          sendVia(socket, { type: 'snapshot-busy' })
          return
        }
        serverSnapshotBusy.add(peer.deviceId)
        try {
          const cursor = currentMaxSeq()
          let totalRows = 0
          let schemaVersion = Number(snapshotSchemaVersion) || 1
          let sent = 0
          if (buildSnapshotRows) {
            // Memory-bounded sender path (2026-09-18): chunk DIRECTLY from the rows array —
            // the old buildSnapshot() string -> JSON.parse -> re-stringify round-trip held
            // ~3x the whole dataset in the main process during a snapshot send.
            const rows = buildSnapshotRows()
            rows.sort((a, b) => String(a.id).localeCompare(String(b.id)))
            totalRows = rows.length
            // Row-count ceiling: refuse the transfer before streaming anything.
            if (totalRows > maxSnapshotRows) {
              sendVia(socket, { type: 'snapshot-error', reason: 'too-large' })
              pushRecent({ at: Date.now(), kind: 'error', peer: peer.deviceId, detail: { error: `snapshot too large: ${totalRows} rows` } })
              onSnapshotError({ peer: peer.deviceId, reason: 'too-large' })
              return
            }
            for (const c of rowChunks(rows)) {
              // Transfer ceiling (round-3 review): refuse unboundedly large snapshots with a
              // clean snapshot-error terminal instead of streaming forever.
              if (sent >= maxSnapshotChunks) {
                sendVia(socket, { type: 'snapshot-error', reason: 'too-large' })
                pushRecent({ at: Date.now(), kind: 'error', peer: peer.deviceId, detail: { error: `snapshot too large: more than ${maxSnapshotChunks} chunks` } })
                onSnapshotError({ peer: peer.deviceId, reason: 'too-large' })
                return
              }
              sendVia(socket, { type: 'snapshot-chunk', index: sent, totalChunks: 0, schemaVersion, rows: c.rows })
              sent += 1
            }
            } else {
              const built = chunkSnapshot(buildSnapshot(), { cursor })
              totalRows = built.totalRows
              schemaVersion = built.schemaVersion
              if (built.chunks.length > maxSnapshotChunks) {
                sendVia(socket, { type: 'snapshot-error', reason: 'too-large' })
                pushRecent({ at: Date.now(), kind: 'error', peer: peer.deviceId, detail: { error: `snapshot too large: more than ${maxSnapshotChunks} chunks` } })
                onSnapshotError({ peer: peer.deviceId, reason: 'too-large' })
                return
              }
              for (const c of built.chunks) {
              sendVia(socket, { type: 'snapshot-chunk', index: c.index, totalChunks: built.chunks.length, schemaVersion, rows: c.rows })
              sent += 1
            }
          }
          sendVia(socket, { type: 'snapshot-end', totalChunks: sent, totalRows, cursor, schemaVersion })
          pushRecent({
            at: Date.now(), kind: 'snapshot', peer: peer.deviceId,
            // Locale-neutral detail (round-3 review): the raw detail is rendered verbatim by
            // the Device Center feed — no CJK strings from main-process code.
            detail: `snapshot: ${totalRows} rows`,
          })
          deps.onSnapshotSync({ peer: peer.deviceId, direction: 'sent', rows: totalRows, cursor })
        } catch (err) {
          // A build failure (e.g. chunkSnapshot: single row exceeds chunk budget) must NOT
          // burn the requester's 120s round deadline: answer snapshot-error so the peer's
          // round ends cleanly and it stops re-arming the trigger for this session.
          try { sendVia(socket, { type: 'snapshot-error', reason: String((err && err.message) || 'snapshot failed') }) } catch { /* socket gone */ }
          throw err
        } finally {
          serverSnapshotBusy.delete(peer.deviceId)
        }
      }
    } catch (err) {
      try { require('electron-log').warn('[LanSync] server handler failed:', err && err.message) } catch { /* noop */ }
      onServerError(err)
    }
  }
}

module.exports = { createServerRoleHandler }
