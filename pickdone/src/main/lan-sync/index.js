'use strict'

/**
 * LAN sync node (P3a): glue wiring discovery + server + client into a single
 * sync-round state machine.
 *
 * Round protocol (both directions, over transport.js after auth):
 *   A -> B: segments-chunk* {segments, final}    push my pending segments (bounded chunks;
 *                                                the last chunk carries final:true and the
 *                                                receiver acks ONCE at final)
 *   B -> A: segments-chunk* {segments, final}    B's own segments (pull, same chunking)
 *   B -> A: ack {applied, rejected, appliedToSeq?, oldestSeq?}
 *   A -> B: ack {applied, rejected, appliedToSeq?}   acks B's response chunks
 *   A -> B: snapshot-request {requesterMaxSeq?} when B pruned past A's watermark
 *   B -> A: snapshot-chunk* {index, totalChunks, rows} + snapshot-end {totalChunks, totalRows, cursor}
 *           (snapshot-end with totalChunks:0/totalRows:0 is a VALID terminal: empty live state)
 *   B -> A: snapshot-busy {}    server role is already serving this peer's snapshot — retry later
 *   B -> A: snapshot-error {reason}  the snapshot could not be built (e.g. a single row exceeds
 *           the chunk budget) — a clean terminal for the requesting round, never re-armed this
 *           session unless the peer's increments start applying again
 *
 * Merge semantics are NOT implemented here — ingestSegment/ingestSnapshot are
 * caller callbacks that feed shared/sync-core (merge.mjs / segment.mjs), per
 * the transport-adapter boundary in shared/sync-core/merge.mjs.
 *
 * Reconnect/backoff: a failed peer is retried after 5s, then exponential
 * (5s * 2^n) capped at 60s; a successful round resets backoff.
 *
 * Pure Node, no Electron imports. CommonJS. `discoverFn` is injectable for
 * tests (fake peer lists instead of real mDNS).
 */

const { EventEmitter } = require('node:events')
const { createDiscovery, PROTO_VER } = require('./discovery')
const { createLanServer, connect, DEFAULT_PORT } = require('./transport')
const { deriveAuthCode } = require('./pairing')
const { chunkSnapshot, rowChunks, finalizeSnapshot } = require('./snapshot')
const { packSegmentChunks } = require('./segments-chunk')

const BACKOFF_BASE_MS = 5000
const BACKOFF_MAX_MS = 60 * 1000
// Round deadline: 120s of TOTAL silence fails the round; every PROGRESS event (a chunk
// received, an ack, a snapshot trailer) re-arms the timer at PROGRESS_MS instead, so a slow
// but moving snapshot transfer (first sync of a large library) is never killed mid-flight.
const ROUND_DEADLINE_MS = 120 * 1000
const ROUND_PROGRESS_MS = 45 * 1000
// snapshot-error retry budget: a transient snapshot failure no longer blocks recovery for the
// whole session. The peer gets SNAPSHOT_FATAL_BUDGET attempts per session (a retry re-arms
// only after SNAPSHOT_ERROR_COOLDOWN stalled rounds so errors do not spam round after round);
// the budget resets to 0 on any round where the peer's increments applied again.
const SNAPSHOT_FATAL_BUDGET = 3
const SNAPSHOT_ERROR_COOLDOWN_ROUNDS = 2
// Device Center: a peer counts as "online" while mDNS saw it (or its last round succeeded)
// within this window; a 30s sweep flips stale peers offline and emits peer-offline.
const ONLINE_WINDOW_MS = 90 * 1000
const SWEEP_INTERVAL_MS = 30 * 1000
// In-memory rings surfaced by getStatus(): recent sync activity (last 50) and security
// events (pair throttling / auth rejections, last 20).
const RECENT_CAP = 50
const SECURITY_CAP = 20
// Client-side deadline for an outbound two-way pair request: the peer's own confirm window is
// 60s, so we outlast it slightly before declaring a timeout ourselves.
const PAIR_CONFIRM_TIMEOUT_CLIENT_MS = 63 * 1000

/**
 * @param {object} opts
 *   deviceId, name, pairingSecret, port?, host?,
 *   ingestSegment(segment), ingestSnapshot(snapshot),
 *   buildSegments() -> Array<segment>, buildSnapshot() -> snapshot,
 *   discoverFn? (optional injected discovery: {startAdvertising, discover, stop, getPeers})
 */
function createLanSyncNode(opts) {
  const {
    deviceId, name, pairingSecret,
    ingestSegment, ingestSnapshot, ingestSnapshotChunk, buildSegments, buildSnapshot, buildSnapshotRows,
  } = opts
  const port = Number.isInteger(opts.port) ? opts.port : DEFAULT_PORT
  const host = opts.host
  const em = new EventEmitter()

  // Optional injector: local max oplog seq. Used ONLY as a sanity clamp on the peer's acked
  // appliedToSeq (never as the ack value itself — see the server handler: the ack is expressed in
  // the SENDER's seq space, which is the only space buildSegments(fromSeq) can consume).
  const getMaxSeq = typeof opts.getMaxSeq === 'function' ? opts.getMaxSeq : null
  const currentMaxSeq = () => {
    try { return Number(getMaxSeq()) || 0 } catch { return 0 }
  }
  // Optional injector: oldest oplog seq still RETAINED locally (the ring buffer prunes from the
  // front). Advertised in the server role's ack; a peer whose watermark is below oldestSeq-1 can
  // never converge from increments (the rows it needs are gone) and must request a snapshot.
  const getOldestSeq = typeof opts.getOldestSeq === 'function' ? opts.getOldestSeq : null
  const currentOldestSeq = () => {
    try { return Number(getOldestSeq()) || 0 } catch { return 0 }
  }

  const peers = new Map() // deviceId -> {deviceId, name, host, port}
  const backoffMs = new Map() // deviceId -> current backoff delay
  const retryTimers = new Map() // deviceId -> timer
  const authCode = deriveAuthCode(pairingSecret, deviceId)
  // Per-peer push watermarks: deviceId -> highest seq that peer has acked. Injected (a live Map) by
  // the bootstrap, which owns persistence; dead peers holding stale entries can no longer gate
  // other peers' rounds, and each round only ships a peer's unconfirmed delta.
  const peerProgress = opts.peerProgress || new Map()

  // Snapshot-request bookkeeping (all in-memory, per peer):
  //   pullWatermarkBy — highest seq I have definitively received from that peer (advanced to the
  //     sender's cursor only after a COMPLETE snapshot; increments carry it via trigger checks).
  //   needSnapshot — the trigger fired (peer pruned past my watermark and my state is not
  //     progressing): the NEXT round opens with a snapshot-request instead of failing silently.
  //   clientSnapshotBusy / serverSnapshotBusy — one snapshot transfer in flight per peer PER
  //     ROLE (never overlap within a role). Deliberately separate sets: a single shared set made
  //     the client's finish() cancel the server role's invariant, and made a same-pair mutual
  //     snapshot exchange deadlock until the 120s round deadline.
  //   snapshotFatal — the peer answered snapshot-error (e.g. oversized row): do NOT re-arm the
  //     trigger this session unless the peer's increments start applying again (state changed).
  const pullWatermarkBy = new Map() // deviceId -> seq
  const needSnapshot = new Set()
  const clientSnapshotBusy = new Set()
  const serverSnapshotBusy = new Set()
  const snapshotFatalCount = new Map() // deviceId -> snapshot-error attempts this session (budget-capped, see constants)
  const snapshotErrorCooldown = new Map() // deviceId -> stalled rounds since the last snapshot-error

  // Resolved once the TCP server is listening. Callers may await this at any
  // time (even after the event already fired) — unlike the 'listening' event,
  // which can be missed if both peers bind in the same poll cycle.
  let listeningResolve = null
  const whenListening = new Promise((resolve) => { listeningResolve = resolve })

  const discovery = opts.discoverFn || createDiscovery()
  let server = null
  let stopped = false
  let lastRoundAt = null
  let lastError = null
  let roundsRunning = 0
  // Device Center bookkeeping (all in-memory, per peer):
  const lastSeenBy = new Map() // deviceId -> last mDNS/discovery sighting (ms epoch)
  const lastRoundBy = new Map() // deviceId -> last confirmed round (ms epoch)
  const errorBy = new Map() // deviceId -> last round error message
  const onlineNow = new Set() // deviceId set tracking online transitions for peer-online/offline events
  let sweepTimer = null
  const recent = [] // ring of {at, kind:'push'|'pull'|'error'|'pair', peer, detail}
  const security = [] // ring of {at, ip, reason:'pair-throttled'|'auth-rejected'}

  function pushRing(arr, cap, entry) {
    arr.push(entry)
    if (arr.length > cap) arr.splice(0, arr.length - cap)
  }
  const pushRecent = (entry) => pushRing(recent, RECENT_CAP, entry)
  const pushSecurity = (entry) => pushRing(security, SECURITY_CAP, entry)

  function computeOnline(id) {
    const now = Date.now()
    const seen = lastSeenBy.get(id)
    const lastRound = lastRoundBy.get(id)
    return (!!seen && now - seen < ONLINE_WINDOW_MS) || (!!lastRound && now - lastRound < ONLINE_WINDOW_MS)
  }

  /** Emit peer-online / peer-offline on offline<->online transitions (sweep + discovery driven). */
  function refreshOnline(id) {
    const nowOnline = computeOnline(id)
    const was = onlineNow.has(id)
    if (nowOnline && !was) {
      onlineNow.add(id)
      const p = peers.get(id)
      if (p) em.emit('peer-online', p)
    } else if (!nowOnline && was) {
      onlineNow.delete(id)
      const p = peers.get(id)
      if (p) em.emit('peer-offline', p)
    }
  }

  function startSweep() {
    if (sweepTimer) return
    sweepTimer = setInterval(() => { for (const id of peers.keys()) refreshOnline(id) }, SWEEP_INTERVAL_MS)
    sweepTimer.unref?.()
  }

  function rememberPeer(peer) {
    if (!peer || !peer.deviceId || peer.deviceId === deviceId) return
    const prev = peers.get(peer.deviceId)
    peers.set(peer.deviceId, {
      deviceId: peer.deviceId,
      name: peer.name || (prev && prev.name) || peer.deviceId,
      host: peer.host || (prev && prev.host),
      port: Number.isInteger(peer.port) ? peer.port : prev && prev.port,
      protoVer: peer.protoVer || (prev && prev.protoVer) || PROTO_VER,
    })
    lastSeenBy.set(peer.deviceId, Date.now())
    refreshOnline(peer.deviceId)
    em.emit('peer', peers.get(peer.deviceId))
  }

  /** Clear pending retry and reset backoff after success. */
  function resetBackoff(peerId) {
    const t = retryTimers.get(peerId)
    if (t) { clearTimeout(t); retryTimers.delete(peerId) }
    backoffMs.set(peerId, BACKOFF_BASE_MS)
  }

  function scheduleRetry(peerId) {
    if (stopped || retryTimers.has(peerId)) return
    const delay = Math.min(backoffMs.get(peerId) || BACKOFF_BASE_MS, BACKOFF_MAX_MS)
    backoffMs.set(peerId, Math.min(delay * 2, BACKOFF_MAX_MS))
    const t = setTimeout(() => {
      retryTimers.delete(peerId)
      const p = peers.get(peerId)
      if (p && !stopped) syncWithPeer(p)
    }, delay)
    t.unref?.()
    retryTimers.set(peerId, t)
  }

  /** Run one exchange with a peer: push my segments, pull theirs, ack. Resolves true only when
 *  the peer acked — the caller must not advance the push cursor over an unconfirmed round. */
  function syncWithPeer(peer) {
    if (stopped) return Promise.resolve(false)
    roundsRunning += 1
    return new Promise((resolve) => {
      let settled = false
      let ackApplied = null // segments the peer acked (surfaces into the recent ring)
      let ackSeq = 0 // peer-reported appliedToSeq: max seq among OUR rows the peer applied (OUR seq space)
      let ackOldestSeq = null // peer's advertised oldest RETAINED seq (undefined for old peers)
      let peerMaxSeqSeen = 0 // max seq observed in the PEER's segments this round (PEER's seq space)
      let roundApplied = 0 // rows the peer's segments changed locally this round (0 = no pull progress)
      let awaitingSnapshot = false // snapshot-request sent; the round ends at snapshot-end, not ack
      const chunkBuf = new Map() // snapshot-chunk index -> rows (assembled at snapshot-end, fallback mode)
      const chunkRowCounts = new Map() // streaming mode: index -> applied row count (rows are NEVER buffered)
      const streamingSnapshot = typeof ingestSnapshotChunk === 'function'
      let chunkTotal = 0 // chunk count as advertised by the chunk messages
      // Round deadline: PROGRESS-based, not fixed (2026-09-18). A silent peer still fails at
      // ROUND_DEADLINE_MS (120s); every data-carrying message re-arms the timer at
      // ROUND_PROGRESS_MS, so a slow-but-moving first-sync snapshot is never killed mid-flight.
      let done = null
      const roundTimeoutMs = Number(opts.roundTimeoutMs) || ROUND_DEADLINE_MS
      const roundProgressMs = Number(opts.roundProgressMs) || ROUND_PROGRESS_MS
      const armDeadline = (ms) => {
        if (settled) return
        if (done) clearTimeout(done)
        done = setTimeout(() => finish(new Error('round timed out waiting for peer ack')), ms)
        done.unref?.()
      }
      const progressDeadline = () => { if (!settled) armDeadline(roundProgressMs) }
      const client = connect(peer.host, peer.port, {
        deviceId,
        authCode,
        // Session key material: the round transport is AES-256-GCM encrypted, key derived
        // from the pairing secret + per-connection salt (transport.js/cipher.js).
        pairingSecret,
        protoVer: PROTO_VER,
        // socket inactivity timeout: a peer answering a fresh-cursor round must build and stream a
        // full-oplog segment batch, which takes far longer than a heartbeat-sized exchange
        timeoutMs: 120000,
        onUnauthorized: (info) => em.emit('peer-unauthorized', info),
      })
      const finish = (err) => {
        if (settled) return
        settled = true
        if (done) clearTimeout(done)
        roundsRunning -= 1
        clientSnapshotBusy.delete(peer.deviceId) // client-role flag ONLY: the server role's
        // serverSnapshotBusy must survive a client round end (separate sets, see above).
        client.close()
        if (err) {
          // A round that died MID-snapshot re-arms the trigger deterministically: the pull
          // watermark did not advance, so the next round must re-request (an RST can also
          // discard the ack that would otherwise have re-armed it).
          if (awaitingSnapshot) needSnapshot.add(peer.deviceId)
          lastError = `${peer.deviceId}: ${err.message}`
          errorBy.set(peer.deviceId, lastError)
          pushRecent({ at: Date.now(), kind: 'error', peer: peer.deviceId, detail: { error: err.message } })
          refreshOnline(peer.deviceId)
          em.emit('round-error', { peer: peer.deviceId, error: err })
          scheduleRetry(peer.deviceId)
          resolve(false)
        } else {
          lastRoundAt = Date.now()
          lastError = null
          lastRoundBy.set(peer.deviceId, lastRoundAt)
          errorBy.delete(peer.deviceId)
          pushRecent({
            at: lastRoundAt, kind: 'push', peer: peer.deviceId,
            detail: { applied: ackApplied, appliedToSeq: peerProgress.get(peer.deviceId) ?? null },
          })
          refreshOnline(peer.deviceId)
          resetBackoff(peer.deviceId)
          em.emit('round-done', { peer: peer.deviceId, applied: ackApplied })
          resolve(true)
        }
      }

      /** Snapshot trigger, evaluated on every successful round end: the peer pruned its oplog
       *  PAST my pull watermark (oldestSeq > wm + 1) AND this round gave me nothing new — the
       *  increments I need are gone forever, so the next round must open with a snapshot-request
       *  instead of silently never converging. A progressing round (roundApplied > 0) always
       *  clears the flag: never snapshot a peer whose watermark is moving. */
      function evaluateSnapshotTrigger() {
        const wm = pullWatermarkBy.get(peer.deviceId) || 0
        if (roundApplied > 0) {
          needSnapshot.delete(peer.deviceId)
          snapshotFatalCount.delete(peer.deviceId) // state is changing again: full budget restored
          snapshotErrorCooldown.delete(peer.deviceId)
          return
        }
        const oldest = Number(ackOldestSeq)
        if (!Number.isFinite(oldest) || oldest <= 0) return // peer did not advertise; nothing to act on
        // Fully caught up pulling (peer has nothing past our watermark)? Peer-space comparison
        // only: peerMaxSeqSeen comes from the peer's own segment seqs — NEVER mix it with the
        // sender-space appliedToSeq (the 2026-09-18 watermark-overshoot bug was exactly that).
        if (peerMaxSeqSeen > 0 && peerMaxSeqSeen <= wm) return
        // snapshot-error retry budget: a transient failure gets up to SNAPSHOT_FATAL_BUDGET
        // attempts per session (each retry after a cooldown so errors do not spam), and the
        // budget resets as soon as the peer's increments apply again (see roundApplied above).
        const attempts = snapshotFatalCount.get(peer.deviceId) || 0
        if (attempts >= SNAPSHOT_FATAL_BUDGET) return // budget exhausted for this session
        if (attempts > 0) {
          const stalled = (snapshotErrorCooldown.get(peer.deviceId) || 0) + 1
          if (stalled <= SNAPSHOT_ERROR_COOLDOWN_ROUNDS) { snapshotErrorCooldown.set(peer.deviceId, stalled); return }
          snapshotErrorCooldown.set(peer.deviceId, 0)
        }
        if (oldest > wm + 1 && !clientSnapshotBusy.has(peer.deviceId)) needSnapshot.add(peer.deviceId)
      }
      client.on('error', (err) => finish(err))
      client.on('rejected', () => finish(new Error('auth rejected by peer')))
      // A socket death MID-snapshot must fail the round promptly (pull watermark stays put, the
      // next round re-requests) instead of idling to the 120s deadline. Post-finish closes are
      // no-ops (settled guard).
      client.on('close', () => { if (awaitingSnapshot && !settled) finish(new Error('connection closed during snapshot transfer')) })
      client.on('ready', () => {
        try {
          // push only what this peer has not confirmed yet (per-peer watermark; 0 = first contact).
          // The backlog travels as bounded segments-chunk messages: one huge `segments` line blew
          // past the 32MB wire cap on first sync and the round retried forever (segments-chunk.js).
          const mine = buildSegments ? buildSegments(peerProgress.get(peer.deviceId) || 0) : []
          for (const chunk of packSegmentChunks(mine)) {
            client.send({ type: 'segments-chunk', segments: chunk.segments, final: chunk.final })
          }
          // Deterministic trigger from the previous round: my increments are gone on the peer —
          // request a full snapshot INSTEAD of another futile incremental round. One transfer per
          // peer at a time (clientSnapshotBusy); the round now ends at snapshot-end, not at the ack.
          if (needSnapshot.has(peer.deviceId) && !clientSnapshotBusy.has(peer.deviceId)) {
            needSnapshot.delete(peer.deviceId)
            clientSnapshotBusy.add(peer.deviceId)
            awaitingSnapshot = true
            chunkBuf.clear()
            client.send({ type: 'snapshot-request' })
          }
        } catch (err) {
          // A throw inside 'ready' used to propagate into the transport's line reader and leave
          // the round hanging until the deadline with no diagnostic — fail the round loudly.
          finish(err)
        }
      })
      client.on('message', (msg) => {
        try {
          // Progress-based deadline: any data-carrying message proves the peer is alive and
          // moving — re-arm at the shorter progress budget (a stalled peer still dies at the
          // initial 120s full deadline).
          if (msg.type === 'segments-chunk' || msg.type === 'snapshot-chunk' || msg.type === 'snapshot-end' || msg.type === 'ack') progressDeadline()
          if (msg.type === 'segments-chunk' && Array.isArray(msg.segments)) {
            let pullAckSeq = 0 // max seq among the rows the peer just pushed to us (PEER's seq space)
            for (const seg of msg.segments) {
              const r = ingestSegment(seg)
              roundApplied += (r && Number(r.applied)) || 0
              // Pull watermark advances CONTIGUOUSLY only: a segment starting past wm+1 means a
              // pruned hole we did NOT receive — marking it received would starve the snapshot
              // trigger (the oldest > wm+1 check could never fire again). The hole itself is what
              // must arm the trigger (see evaluateSnapshotTrigger).
              const from = Number(seg && seg.fromSeq)
              const to = Number(seg && seg.toSeq)
              if (Number.isFinite(from) && Number.isFinite(to)) {
                const wm = pullWatermarkBy.get(peer.deviceId) || 0
                if (from <= wm + 1 && to > wm) pullWatermarkBy.set(peer.deviceId, to)
                if (to > peerMaxSeqSeen) peerMaxSeqSeen = to
              }
              for (const row of (seg && seg.rows) || []) {
                const s = Number(row && row.seq)
                if (Number.isFinite(s) && s > pullAckSeq) pullAckSeq = s
              }
            }
            // The ack is sent ONCE, at the final chunk (segments-chunk.js contract). appliedToSeq
            // is in the PEER's seq space (the rows' own seq): the peer feeds it into
            // buildSegments(fromSeq) against ITS oplog. Reporting our own local max here (the old
            // behavior) overshot the peer's cursor whenever our oplog ran ahead and silently
            // skipped its fresh rows every round.
            if (msg.final) {
              client.send({ type: 'ack', applied: msg.segments.length, rejected: 0, ...(pullAckSeq > 0 ? { appliedToSeq: pullAckSeq } : {}) })
            }
          } else if (msg.type === 'snapshot-chunk' && Array.isArray(msg.rows)) {
            if (!awaitingSnapshot) throw new Error('unsolicited snapshot-chunk')
            chunkTotal = Number(msg.totalChunks) || chunkTotal
            const idx = Number(msg.index) || 0
            if (streamingSnapshot) {
              // Streaming receiver (2026-09-18): apply + flush THIS chunk immediately through the
              // caller's ingestSnapshotChunk — the full snapshot never materializes in memory.
              // Crash semantics are unchanged: the pull watermark still advances ONLY at
              // snapshot-end, and chunk-merge-apply is idempotent.
              ingestSnapshotChunk({ schemaVersion: Number(msg.schemaVersion) || 1, deviceId: peer.deviceId, rows: msg.rows })
              chunkRowCounts.set(idx, msg.rows.length)
            } else {
              chunkBuf.set(idx, msg.rows)
            }
          } else if (msg.type === 'snapshot-busy') {
            // The peer's server role is busy (mutual snapshot collision): end the round as a
            // clean retry-later — re-arm the trigger and let the normal backoff dial again.
            // NOT an error: both sides are healthy, they just tried to snapshot each other.
            if (!awaitingSnapshot) throw new Error('unsolicited snapshot-busy')
            awaitingSnapshot = false
            chunkBuf.clear()
            chunkRowCounts.clear()
            clientSnapshotBusy.delete(peer.deviceId)
            needSnapshot.add(peer.deviceId)
            scheduleRetry(peer.deviceId)
            finish(null)
          } else if (msg.type === 'snapshot-error') {
            // Clean terminal: the peer could not serve a snapshot right now (e.g. an oversized
            // row). Log to the recent ring; do NOT re-arm immediately — the retry budget
            // (SNAPSHOT_FATAL_BUDGET per session, cooldown-spaced, reset on progress) lets a
            // TRANSIENT failure recover without restart while a hard failure stops spamming.
            if (!awaitingSnapshot) throw new Error('unsolicited snapshot-error')
            const reason = String((msg && msg.reason) || 'snapshot failed')
            awaitingSnapshot = false
            chunkBuf.clear()
            chunkRowCounts.clear()
            snapshotErrorCooldown.delete(peer.deviceId)
            snapshotFatalCount.set(peer.deviceId, (snapshotFatalCount.get(peer.deviceId) || 0) + 1)
            clientSnapshotBusy.delete(peer.deviceId)
            pushRecent({ at: Date.now(), kind: 'error', peer: peer.deviceId, detail: { error: `snapshot-error: ${reason}` } })
            em.emit('snapshot-error', { peer: peer.deviceId, reason })
            finish(null)
          } else if (msg.type === 'snapshot-end') {
            // All-or-nothing finalization. ONLY process snapshot-end when a snapshot was actually
            // requested on this connection (awaitingSnapshot) — anything else is a protocol
            // violation and fails the round. The chunks must tile exactly [0..n) and sum to
            // totalRows — ONLY then does the pull watermark advance to the sender's cursor (in
            // streaming mode the rows were ALREADY applied+flushed per chunk; in fallback mode
            // they are assembled here and handed to ingestSnapshot once). A partial/failed
            // snapshot fails the round, leaves the DB at the per-chunk committed state
            // (merge-apply is idempotent), and the next round re-requests (the trigger re-fires
            // because the watermark did not advance).
            if (!awaitingSnapshot) throw new Error('unsolicited snapshot-end')
            const totalRows = Number(msg.totalRows) || 0
            const fin = finalizeSnapshot({ declaredChunks: Number(msg.totalChunks), chunkTotal, totalRows, chunkBuf, chunkRowCounts })
            if (!fin.ok) throw new Error(fin.reason)
            if (!streamingSnapshot && fin.rows) {
              ingestSnapshot({ schemaVersion: Number(msg.schemaVersion) || 1, deviceId: peer.deviceId, rows: fin.rows })
            }
            chunkBuf.clear()
            chunkRowCounts.clear()
            // Monotonic guard: a cursor of 0/absent must never REGRESS the watermark.
            const cursor = Math.max(pullWatermarkBy.get(peer.deviceId) || 0, Number(msg.cursor) || 0)
            pullWatermarkBy.set(peer.deviceId, cursor) // watermark advances ONLY here
            clientSnapshotBusy.delete(peer.deviceId)
            pushRecent({
              at: Date.now(), kind: 'snapshot', peer: peer.deviceId,
              detail: { direction: 'received', rows: totalRows, cursor },
            })
            em.emit('snapshot-sync', { peer: peer.deviceId, direction: 'received', rows: totalRows, cursor })
            awaitingSnapshot = false
            finish(null)
          } else if (msg.type === 'ack') {
            // Peer's ack is the round's success criterion: it confirms our push AND proves the
            // peer finished building its own response. Timing the round out as "success" here
            // would advance the push cursor over undelivered segments (2026-09-17 live drill).
            ackApplied = Number(msg.applied) || 0
            ackSeq = Number(msg.appliedToSeq) || 0
            ackOldestSeq = msg.oldestSeq
            // ackSeq is in OUR seq space (max seq among our rows the peer applied). Defensive
            // clamp to our own max oplog seq: a misbehaving/legacy peer (reporting its own local
            // seq space — the pre-2026-09-18 bug) must never push our cursor past our own oplog,
            // which would permanently skip our fresh rows.
            let seq = ackSeq
            if (getMaxSeq) seq = Math.min(seq, currentMaxSeq())
            if (seq > (peerProgress.get(peer.deviceId) || 0)) peerProgress.set(peer.deviceId, seq)
            evaluateSnapshotTrigger()
            // With a snapshot-request in flight the round's finish waits for snapshot-end (the
            // ack only proves the peer got MY push, not that the snapshot stream completed).
            if (!awaitingSnapshot) finish(null)
          }
        } catch (err) {
          finish(err)
        }
      })
      // No ack before the deadline = the round failed (push cursor stays put; next round re-pushes).
      // The initial budget covers a FIRST sync between two real devices of silence; actual data
      // transfer keeps extending it via progressDeadline() (see the message handler below).
      armDeadline(roundTimeoutMs)
    })
  }

  function startServer() {
    server = createLanServer({
      port,
      host,
      deviceId,
      pairingSecret,
      verifyPairingCode: opts.verifyPairingCode,
      onPairRequest: (info) => em.emit('pair-request', info),
      onPairThrottled: (info) => {
        pushSecurity({ at: Date.now(), ip: info && info.ip, reason: 'pair-throttled' })
        em.emit('pair-throttled', info)
      },
      pairConfirmTimeoutMs: opts.pairConfirmTimeoutMs,
      onPaired: (info) => {
        pushRecent({ at: Date.now(), kind: 'pair', peer: info && info.deviceId || (info && info.host) || '', detail: { host: info && info.host, inbound: true, confirmed: !!(info && info.confirmed) } })
        em.emit('paired-inbound', info)
      },
      getHandler: (peer) => (msg, socket) => {
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
              for (const row of (seg && seg.rows) || []) {
                const s = Number(row && row.seq)
                if (Number.isFinite(s) && s > acc.maxSeq) acc.maxSeq = s
              }
            }
            if (msg.final) {
              // The response pull travels through the SAME bounded chunking: the server's own
              // first-sync backlog is just as large as the client's.
              const mine = buildSegments ? buildSegments() : []
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
              let schemaVersion = Number(opts.snapshotSchemaVersion) || 1
              let sent = 0
              if (buildSnapshotRows) {
                // Memory-bounded sender path (2026-09-18): chunk DIRECTLY from the rows array —
                // the old buildSnapshot() string -> JSON.parse -> re-stringify round-trip held
                // ~3x the whole dataset in the main process during a snapshot send.
                const rows = buildSnapshotRows()
                rows.sort((a, b) => String(a.id).localeCompare(String(b.id)))
                totalRows = rows.length
                for (const c of rowChunks(rows)) {
                  sendVia(socket, { type: 'snapshot-chunk', index: sent, totalChunks: 0, schemaVersion, rows: c.rows })
                  sent += 1
                }
              } else {
                const built = chunkSnapshot(buildSnapshot(), { cursor })
                totalRows = built.totalRows
                schemaVersion = built.schemaVersion
                for (const c of built.chunks) {
                  sendVia(socket, { type: 'snapshot-chunk', index: c.index, totalChunks: built.chunks.length, schemaVersion, rows: c.rows })
                  sent += 1
                }
              }
              sendVia(socket, { type: 'snapshot-end', totalChunks: sent, totalRows, cursor, schemaVersion })
              pushRecent({
                at: Date.now(), kind: 'snapshot', peer: peer.deviceId,
                detail: { direction: 'sent', rows: totalRows, cursor, label: `对端请求全量快照 / 已发送 ${totalRows} 行` },
              })
              em.emit('snapshot-sync', { peer: peer.deviceId, direction: 'sent', rows: totalRows, cursor })
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
          em.emit('server-error', err)
        }
      },
      onPeer: (peer) => em.emit('peer-connected', peer),
      onUnauthorized: (info) => {
        pushSecurity({ at: Date.now(), ip: info && info.host, reason: 'auth-rejected' })
        em.emit('peer-unauthorized', info)
      },
    })
    server.on('error', (err) => { lastError = err.message; em.emit('server-error', err) })
    server.on('listening', (p) => {
      listeningResolve(p)
      discovery.startAdvertising({ deviceId, name, port: p })
      discovery.discover(rememberPeer)
      em.emit('listening', p)
    })
  }

  function sendVia(socket, msg) {
    // Fail closed: transport.js attaches _lanSend (AES-256-GCM framed once the session key is
    // up) to every authenticated socket. A post-auth socket WITHOUT it would mean plaintext
    // fallback — the old raw-write fallback silently downgraded; now we throw instead.
    if (typeof (socket && socket._lanSend) !== 'function') {
      throw new Error('sendVia: socket has no encrypted send path (post-auth plaintext fallback removed)')
    }
    socket._lanSend(msg)
  }

  /**
   * Manual pairing with a known peer: exchange our 6-digit code for the peer's persisted
   * pairing secret. Resolves {secret, peer}; rejects on reject/error/timeout.
   */
  function pairWith(peerDeviceId, code) {
    const peer = peers.get(peerDeviceId) || [...peers.values()][0]
    if (!peer || !peer.host || !peer.port) return Promise.reject(new Error('pairWith: no discovered peer'))
    return new Promise((resolve, reject) => {
      const client = connect(peer.host, peer.port, { deviceId, pairCode: String(code), protoVer: PROTO_VER, timeoutMs: 5000 })
      // 6s fallback deadline: cleared+unref'd so a settled pair neither leaks the timer
      // nor keeps the process alive for it.
      const deadline = setTimeout(() => done(reject, new Error('pairing timeout')), 6000)
      deadline.unref?.()
      const done = (fn, v) => {
        clearTimeout(deadline)
        try { client.close() } catch { /* noop */ }
        fn(v)
      }
      client.on('paired', (r) => { em.emit('paired-outbound', { peer: peer.deviceId }); done(resolve, { secret: r.secret, peer }) })
      client.on('rejected', () => done(reject, new Error('pairing code rejected by peer')))
      client.on('error', (err) => done(reject, err))
    })
  }

  /**
   * Two-way confirmed outbound pairing: connect to host:port, send a code-less pair-request,
   * and wait for the human on the other side. Resolves {secret, host} on pair-accept (the
   * caller adopts the secret, exactly like pairWith); rejects on pair-reject/error/timeout
   * and emits 'pair-rejected' so the renderer can surface the refusal.
   */
  function requestPair(host, port) {
    if (!host) return Promise.reject(new Error('requestPair: host is required'))
    const targetPort = Number.isInteger(port) ? port : DEFAULT_PORT
    return new Promise((resolve, reject) => {
      const client = connect(host, targetPort, {
        deviceId, pairOpen: true, deviceName: name, protoVer: PROTO_VER,
        // The peer holds the request open for its own 60s confirm window; outlast it slightly.
        timeoutMs: PAIR_CONFIRM_TIMEOUT_CLIENT_MS,
      })
      const deadline = setTimeout(() => done(reject, new Error('pairing request timed out')), PAIR_CONFIRM_TIMEOUT_CLIENT_MS)
      deadline.unref?.()
      const done = (fn, v) => {
        clearTimeout(deadline)
        try { client.close() } catch { /* noop */ }
        fn(v)
      }
      client.on('paired', (r) => {
        em.emit('pair-accepted', { host, port: targetPort })
        done(resolve, { secret: r.secret, host, port: targetPort })
      })
      client.on('rejected', (msg) => {
        const reason = (msg && msg.error) || 'rejected'
        em.emit('pair-rejected', { host, port: targetPort, reason })
        const err = new Error('pairing rejected by peer: ' + reason)
        err.reason = reason
        done(reject, err)
      })
      client.on('error', (err) => done(reject, err))
    })
  }

  return {
    pairWith,
    requestPair,
    on: em.on.bind(em),

    /** Start advertising, discovery, and the TCP server. */
    start() {
      stopped = false
      startServer()
      startSweep()
    },

    /** Resolves with the bound port once the TCP server is listening. */
    whenListening: () => whenListening,

    /** Inject a peer directly (tests / manual entry / mDNS-free networks).
     *  Returns the stored entry and resets backoff so the next round dials it immediately. */
    addPeer(peer) {
      rememberPeer(peer)
      const id = peer && peer.deviceId
      if (id) resetBackoff(id)
      return peers.get(id)
    },

    /** Run one sync round against every known peer (sequentially). */
    async startSyncRound() {
      const targets = Array.from(peers.values())
      let confirmed = 0
      for (const peer of targets) {
        if (stopped) break
        if (await syncWithPeer(peer)) confirmed += 1
      }
      // confirmed === targets.length is the only safe condition for the caller to markPushed:
      // advancing the cursor because SOME peer answered used to drop the backlog of the peers
      // that had not confirmed yet (silent data loss, 2026-09-17 drill)
      return { peers: targets.length, confirmed, allConfirmed: confirmed === targets.length, lastRoundAt }
    },

    getStatus() {
      const now = Date.now()
      return {
        deviceId,
        name,
        listening: !!(server && server.port),
        port: server ? server.port : null,
        self: { deviceId, deviceName: name, port: server ? server.port : null },
        peers: Array.from(peers.values()).map((p) => {
          const wm = peerProgress.has(p.deviceId) ? peerProgress.get(p.deviceId) : null
          const seen = lastSeenBy.get(p.deviceId)
          const lr = lastRoundBy.get(p.deviceId)
          return {
            ...p,
            online: (!!seen && now - seen < ONLINE_WINDOW_MS) || (!!lr && now - lr < ONLINE_WINDOW_MS),
            lastRoundAt: lr || null,
            lastError: errorBy.get(p.deviceId) || null,
            watermark: wm,
            // Pull-side watermark: the sender cursor I recorded after my last COMPLETE snapshot
            // from this peer (increments carry it forward between snapshots via the trigger).
            pullWatermark: pullWatermarkBy.get(p.deviceId) ?? null,
            // How many of my oplog rows this peer has NOT confirmed yet (null when unknown:
            // no getMaxSeq injector means no honest local max seq to diff against).
            pendingCount: getMaxSeq && wm != null ? Math.max(0, currentMaxSeq() - wm) : null,
          }
        }),
        recent: recent.slice(),
        security: security.slice(),
        lastRoundAt,
        lastError,
        roundsRunning,
      }
    },

    async stop() {
      stopped = true
      if (sweepTimer) { clearInterval(sweepTimer); sweepTimer = null }
      onlineNow.clear()
      for (const t of retryTimers.values()) clearTimeout(t)
      retryTimers.clear()
      try { discovery.stop() } catch { /* noop */ }
      if (server) await server.close()
      em.emit('stopped')
    },
  }
}

module.exports = { createLanSyncNode, BACKOFF_BASE_MS, BACKOFF_MAX_MS }
