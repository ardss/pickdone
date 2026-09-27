'use strict'

/**
 * Client-role sync round, extracted from index.js (line ratchet): pure move of syncWithPeer —
 * push my pending segments, pull the peer's, ack, snapshot-request/chunk/end handling and the
 * round deadline. The handler closes over the node's per-peer bookkeeping, which the caller
 * (index.js) passes as a `ctx` bag; the node's mutable scalars (stopped / roundsRunning /
 * lastError / lastRoundAt) cross the boundary as accessors — references would be snapshots.
 *
 * Pure Node, no Electron imports. CommonJS.
 */

const { connect } = require('./transport')
const { PROTO_VER, isDialableHost } = require('./discovery')
const { packSegmentChunks } = require('./segments-chunk')
const { finalizeSnapshot } = require('./snapshot')
const { createAttachmentPuller } = require('./att-transfer')

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

/**
 * @param {object} ctx — the node's shared state + callbacks (see createLanSyncNode):
 *   opts, deviceId, authCode, pairingSecret, em,
 *   peers, retryTimers, lastRoundBy, failStreakBy, oversizedSegmentBy, unpairedBy, activeClients,
 *   needSnapshot, needSnapshotForce, clientSnapshotBusy, pullWatermarkBy,
 *   snapshotFatalCount, snapshotErrorCooldown, flushStallBy, errorBy,
 *   attSession, peerProgress, DIAL_FAILURE_BUDGET, maxSnapshotChunks,
 *   buildSegments, ingestSegment, ingestSnapshot, ingestSnapshotChunk,
 *   getMaxSeq, currentMaxSeq,
 *   getStopped(), bumpRounds(delta), setLastRoundAt(t) -> t, setLastError(msg),
 *   pushRecent, refreshOnline, scheduleRetry, resetBackoff, tryRefixAddress, forgetPeer
 */
function createClientRound(ctx) {
  const {
    opts, deviceId, authCode, pairingSecret, em,
    peers, retryTimers, lastRoundBy, failStreakBy, oversizedSegmentBy, unpairedBy, activeClients,
    needSnapshot, needSnapshotForce, clientSnapshotBusy, pullWatermarkBy,
    snapshotFatalCount, snapshotErrorCooldown, flushStallBy, errorBy,
    attSession, peerProgress, DIAL_FAILURE_BUDGET, maxSnapshotChunks,
    buildSegments, ingestSegment, ingestSnapshot, ingestSnapshotChunk,
    getMaxSeq, currentMaxSeq,
    getStopped, bumpRounds, setLastRoundAt, setLastError,
    pushRecent, refreshOnline, scheduleRetry, resetBackoff, tryRefixAddress, forgetPeer,
    sendVia,
  } = ctx
  function syncWithPeer (peer) {
    if (getStopped()) return Promise.resolve(false)
    // Round-3 P1: a re-entrant startSyncRound for a peer whose round is still in flight used to
    // dial a SECOND concurrent connection (kick + retry timer + discovery all race); round B's
    // finish() then unconditionally deleted round A's clientSnapshotBusy flag, letting a third
    // round start a parallel snapshot transfer mid-A. Skip instead — the in-flight round owns
    // the peer until it settles (the retry/backoff machinery re-dials afterwards).
    if (roundsInFlight.has(peer.deviceId)) return Promise.resolve(false)
    // Round-4 P1 (roundsInFlight permanent leak): a malformed port/host (e.g. a corrupt
    // discovery announce) used to make net.createConnection throw a RangeError SYNCHRONOUSLY
    // inside the round's promise executor — before finish() existed — so the per-peer mutex
    // below was never released and the peer was skipped FOREVER. Validate the dial target
    // before taking the mutex.
    // Round-5 P1: the rejection must go through the SAME failure accounting as a dial failure
    // (finish()'s error path). It previously emitted round-error WITHOUT touching
    // failStreakBy/dialNotBefore/scheduleRetry (the old "leaves the retry machinery in control"
    // comment was wrong), so the startSyncRound trigger re-fired the same doomed round every
    // tick with a fresh round-error fan-out, forever. Count the failure here, suppress the
    // broadcast once hibernating (streak > DIAL_FAILURE_BUDGET), and let scheduleRetry arm
    // dialNotBefore + the retry timer so hibernate applies.
    const badPort = !Number.isInteger(peer.port) || peer.port < 1 || peer.port > 65535
    if (!isDialableHost(peer.host) || badPort) {
      const detail = badPort ? `invalid port (${peer.port})` : `invalid host (${peer.host})`
      // Fix-round (2026-09-22, lan-sync-7): re-resolve through discovery BEFORE counting the
      // failure — a corrupted stored record used to burn dial rounds (streak climbing toward
      // hibernate) against the same bad target until an mDNS re-announce happened to overwrite it.
      const refixed = tryRefixAddress(peer.deviceId)
      const streak = (failStreakBy.get(peer.deviceId) || 0) + 1
      failStreakBy.set(peer.deviceId, streak)
      setLastError(`${peer.deviceId}: ${detail}`)
      errorBy.set(peer.deviceId, `${peer.deviceId}: ${detail}`)
      pushRecent({ at: Date.now(), kind: 'error', peer: peer.deviceId, detail: { error: detail } })
      refreshOnline(peer.deviceId)
      if (streak <= DIAL_FAILURE_BUDGET) em.emit('round-error', { peer: peer.deviceId, error: new Error(detail) })
      scheduleRetry(peer.deviceId)
      if (refixed) em.emit('round-error', { peer: peer.deviceId, error: new Error(detail), recoveredAddress: true })
      return Promise.resolve(false)
    }
    // Wave-B P2-4: terminal oversized-segment state — dialing again is futile until the peer's
    // data changes (a fresh rememberPeer clears the flag). Skip quietly; errorBy already carries
    // the diagnosable message from the round that discovered it.
    if (oversizedSegmentBy.has(peer.deviceId)) return Promise.resolve(false)
    roundsInFlight.add(peer.deviceId)
    bumpRounds(1)
    return new Promise((resolve) => {
      let settled = false
      let ackApplied = null // segments the peer acked (surfaces into the recent ring)
      let ackSeq = 0 // peer-reported appliedToSeq: max seq among OUR rows the peer applied (OUR seq space)
      let ackOldestSeq = null // peer's advertised oldest RETAINED seq (undefined for old peers)
      let peerMaxSeqSeen = 0 // max seq observed in the PEER's segments this round (PEER's seq space)
      let roundApplied = 0 // rows the peer's segments changed locally this round (0 = no pull progress)
      let pullAckSeq = 0 // max seq among the peer's pushed rows across ALL chunks (PEER's seq space)
      let roundFlushFailedFrom = null // Round-3 P1: earliest flush-failed fromSeq this round — caps pullAckSeq at the final ack
      let ownsSnapshotBusy = false // Round-3 P1: THIS round set clientSnapshotBusy (only its owner may clear it)
      let awaitingSnapshot = false // snapshot-request sent; the round ends at snapshot-end, not ack
      let authRejected = false // P1-3: the peer's server refused our hello (terminal, see finish)
      // Fix-round (2026-09-22, lan-sync-6): snapshot-busy is a scheduling collision, not a dial
      // failure — finish's error path must not advance the dial-failure streak toward hibernate.
      let snapshotBusyCollision = false
      // Layer-2 defense in depth (stalled-push finding): a flushFailed ack means the peer
      // DROPPED our pushed rows — the round must end as a FAILURE (visible lastError /
      // round-error, no silent "ok") but this is a peer-side ingest stall, NOT a dial
      // failure, so it must not advance the streak toward the 10-minute hibernate
      // (same exemption shape as snapshotBusyCollision above).
      let flushFailedAck = false
      // Attachment FILE puller (post-ack): sendVia needs the RAW SOCKET (socket._lanSend lives on em._socket, not the EventEmitter — wiring `client` here poisoned every round, 2026-09-19 drill).
      // onArrived (P1-8): host callback per file landed on disk -> 'attachments-arrived' syncEvent so open views refresh live.
      const att = createAttachmentPuller({ send: (m) => sendVia(client._socket, m), session: attSession, peerId: peer.deviceId, getKeys: typeof opts.getMissingAttachmentKeys === 'function' ? opts.getMissingAttachmentKeys : null, deps: opts.attachmentPullerDeps, onArrived: typeof opts.onAttachmentArrived === 'function' ? opts.onAttachmentArrived : null })
      const chunkBuf = new Map() // snapshot-chunk index -> rows (assembled at snapshot-end, fallback mode)
      const chunkRowCounts = new Map() // streaming mode: index -> applied row count (rows are NEVER buffered)
      const streamingSnapshot = typeof ingestSnapshotChunk === 'function'
      let chunkTotal = 0 // chunk count as advertised by the chunk messages
      let chunkCount = 0 // chunks actually received (bounded: MAX_SNAPSHOT_CHUNKS caps the transfer)
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
      const client = (() => {
        // Round-4 P1: any synchronous throw from connect() (range/option errors) must land in
        // finish(), not escape the promise executor and leak the roundsInFlight mutex.
        try {
          return connect(peer.host, peer.port, {
        deviceId,
        authCode,
        // Session key material: the round transport is AES-256-GCM encrypted, key derived
        // from the pairing secret + per-connection salt (transport.js/cipher.js).
        pairingSecret,
        protoVer: PROTO_VER,
        // socket inactivity timeout: a peer answering a fresh-cursor round must build and stream a
        // full-oplog segment batch, which takes far longer than a heartbeat-sized exchange
        timeoutMs: 120000,
        // P1-3: the peer's server REJECTED our authenticated hello — the pairing was revoked on
        // their side. Terminal for this session: no more dialing until the user re-pairs/unpairs
        // or restarts (a re-announced/re-added peer clears the state via rememberPeer).
        onUnauthorized: (info) => { authRejected = true; em.emit('peer-unauthorized', info) },
          })
        } catch (err) {
          finish(err)
          return null
        }
      })()
      if (client) activeClients.add(client) // fix-round lan-sync-4: stop() closes in-flight clients
      // Round-4 P1: `function` declaration (hoisted) so the connect IIFE below can call finish
      // from its catch path even though connect() textually precedes the body — a synchronous
      // throw must reach finish (mutex release) instead of escaping the promise executor.
      function finish (err) {
        if (settled) return
        settled = true
        if (done) clearTimeout(done)
        bumpRounds(-1)
        roundsInFlight.delete(peer.deviceId) // Round-3 P1: release the per-peer round mutex
        activeClients.delete(client) // fix-round lan-sync-4: this round's client is settled
        // Round-3 P1: delete the client snapshot flag ONLY if THIS round set it — a concurrent
        // round (before the per-peer mutex) or a later finish on a stale connection used to
        // clear the flag while another round's snapshot transfer was still in flight.
        if (ownsSnapshotBusy) clientSnapshotBusy.delete(peer.deviceId) // client-role flag ONLY: the server role's
        // serverSnapshotBusy must survive a client round end (separate sets, see above).
        if (client) client.close()
        if (err) {
          // A round that died MID-snapshot re-arms the trigger deterministically: the pull
          // watermark did not advance, so the next round must re-request (an RST can also
          // discard the ack that would otherwise have re-armed it).
          if (awaitingSnapshot) needSnapshot.add(peer.deviceId)
          // P1-3: track the consecutive-failure streak. Past the budget the peer is
          // hibernating (10min retries, see scheduleRetry) and the per-failure fan-out is
          // suppressed — one round-error emission per hibernate window, no renderer broadcast
          // per retry (the recent ring still records every attempt for Device Center).
          // Fix-round (2026-09-22, lan-sync-6): a snapshot-busy collision does NOT count —
          // two healthy peers exchanging mutual first-sync snapshots used to push each other
          // into the 10-minute hibernate purely on same-cadence retries.
          const streak = (failStreakBy.get(peer.deviceId) || 0) + (snapshotBusyCollision || flushFailedAck ? 0 : 1)
          failStreakBy.set(peer.deviceId, streak)
          if (authRejected) {
            // P1-3b TERMINAL: auth rejected = the peer removed our pairing. Stop dialing this
            // peer entirely until user action; expose a DISTINCT state for the Device Center
            // (peers[].peerState === 'unpaired'; lastError carries the same sentinel).
            unpairedBy.add(peer.deviceId)
            const t = retryTimers.get(peer.deviceId)
            if (t) { clearTimeout(t); retryTimers.delete(peer.deviceId) }
            setLastError(`${peer.deviceId}: peer removed this pairing (re-pair required)`)
            errorBy.set(peer.deviceId, 'unpaired: the peer removed this pairing, please re-pair')
            pushRecent({ at: Date.now(), kind: 'error', peer: peer.deviceId, detail: { error: 'auth rejected by peer (unpaired)' } })
            refreshOnline(peer.deviceId)
            em.emit('round-error', { peer: peer.deviceId, error: err, terminal: 'unpaired' })
            resolve(false)
            return
          }
          // Wave-B P2-4 TERMINAL: our own backlog holds a single segment over the 32MB wire cap.
          // Retrying can never succeed (the same line is rebuilt and destroyed every round) —
          // stop the retry loop and surface a clear, diagnosable peer error instead. A later
          // discovery re-announce (rememberPeer) clears the state and gives sync a fresh chance.
          if (err && err.oversizedSegment) {
            oversizedSegmentBy.add(peer.deviceId)
            const t = retryTimers.get(peer.deviceId)
            if (t) { clearTimeout(t); retryTimers.delete(peer.deviceId) }
            setLastError(`${peer.deviceId}: ${err.message}`)
            errorBy.set(peer.deviceId, `${peer.deviceId}: ${err.message}`)
            pushRecent({ at: Date.now(), kind: 'error', peer: peer.deviceId, detail: { error: err.message } })
            refreshOnline(peer.deviceId)
            em.emit('round-error', { peer: peer.deviceId, error: err, terminal: 'oversized-segment' })
            resolve(false)
            return
          }
          setLastError(`${peer.deviceId}: ${err.message}`)
          errorBy.set(peer.deviceId, `${peer.deviceId}: ${err.message}`)
          // Layer-2: count consecutive flush-failed rounds; a clean round or an advancing
          // snapshot cursor (recovery converging) clears the counter (see the resets below).
          if (flushFailedAck) flushStallBy.set(peer.deviceId, (flushStallBy.get(peer.deviceId) || 0) + 1)
          pushRecent({ at: Date.now(), kind: 'error', peer: peer.deviceId, detail: { error: err.message } })
          refreshOnline(peer.deviceId)
          if (streak <= DIAL_FAILURE_BUDGET) {
            em.emit('round-error', { peer: peer.deviceId, error: err })
          }
          // Round-1 P0 (2026-09-21): before letting the peer slide into backoff/hibernate, re-resolve
          // its address through the discovery layer (mDNS/UDP) WITHIN this round — see
          // tryRefixAddress (fix-round 2026-09-22: extracted so the invalid-target early-exit path
          // shares the same budgeted self-healing).
          const refixed = tryRefixAddress(peer.deviceId)
          scheduleRetry(peer.deviceId)
          // Layer-2: the flush-failed peer ANSWERED on the wire — only its ingest stalled.
          // Dial-failure backoff must not delay the recovery loop: re-arm at base cadence so
          // the force-armed snapshot round dials immediately (still streak-exempt, still
          // user-visible via errorBy/round-error).
          if (flushFailedAck) resetBackoff(peer.deviceId)
          if (refixed) em.emit('round-error', { peer: peer.deviceId, error: err, recoveredAddress: true })
          resolve(false)
        } else {
          const lastTs = setLastRoundAt(Date.now())
          setLastError(null)
          lastRoundBy.set(peer.deviceId, lastTs)
          errorBy.delete(peer.deviceId)
          flushStallBy.delete(peer.deviceId) // Layer-2: a clean round means the flush stall cleared
          pushRecent({
            at: lastTs, kind: 'push', peer: peer.deviceId,
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
        // Wave-B P1: a FORCE-armed trigger (flush-failed segment / flush-failed ack) is a poison
        // state that partial progress cannot cure — the failed rows are dropped on the peer and
        // re-pushed identically every round. The flag must survive this evaluation (only the
        // snapshot-request in the next round's 'ready' consumes it), otherwise roundApplied > 0
        // cancelled the escape and the push looped forever.
        if (needSnapshotForce.has(peer.deviceId)) {
          needSnapshot.add(peer.deviceId)
          return
        }
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
        if (peerMaxSeqSeen > 0 && peerMaxSeqSeen <= wm) {
          // Fix-round (2026-09-22, lan-sync-5, increment path): the peer's OWN seqs running
          // strictly BELOW our pull watermark is the oplog-reset signature — force a snapshot
          // so the new epoch's (lower) cursor gets adopted at snapshot-end. The pre-fix plain
          // return judged the peer "already caught up" and it silently never synced again.
          if (peerMaxSeqSeen < wm && !clientSnapshotBusy.has(peer.deviceId)) needSnapshot.add(peer.deviceId)
          return
        }
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
      client.on('rejected', (msg) => {
        // The peer's server answered hello with its DISTINCT self-connection reason: this entry
        // routes back to ourselves (stale manual host). Drop it and its retry timer — retrying
        // would just re-dial ourselves forever (2026-09-18 incident).
        const self = !!(msg && msg.error === 'self-connection')
        if (self) forgetPeer(peer.deviceId)
        finish(new Error(self
          ? 'self-connection: peer entry pointed at this device and was removed'
          : 'auth rejected by peer'))
      })
      // A socket death before the round settled must fail the round PROMPTLY (previously only a
      // close MID-snapshot failed early — a clean FIN after our push left the round hanging for
      // the full 120s deadline). Post-finish closes are no-ops: snapshot transfers legitimately
      // end via snapshot-end -> finish(null) (settled) BEFORE the peer's FIN arrives, so the
      // ordering guard keeps clean terminal paths intact.
      client.on('close', () => { if (!settled) finish(new Error('connection closed before the round completed')) })
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
            // Wave-B P1: the request actually going out is what consumes the force-arm — a round
            // that ends BEFORE the request (auth failure, socket death) must keep it armed.
            needSnapshotForce.delete(peer.deviceId)
            clientSnapshotBusy.add(peer.deviceId)
            ownsSnapshotBusy = true
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
            // pullAckSeq is ROUND-scoped (declared above): it must accumulate across ALL chunks
            // of a multi-chunk push — resetting per chunk acked only the last chunk's max seq
            // and the sender's per-peer watermark undershot (re-pushing already-applied rows).
            for (const seg of msg.segments) {
              const r = ingestSegment(seg)
              roundApplied += (r && Number(r.applied)) || 0
              // P0-1: a flush-failed segment's rows were dropped locally — the pull watermark
              // must NOT advance over it, and the next round force-arms a snapshot (the
              // peer's full state re-applies idempotently, restoring the dropped rows).
              const segFlushFailed = !!(r && r.flushFailed)
              // Pull watermark advances CONTIGUOUSLY only: a segment starting past wm+1 means a
              // pruned hole we did NOT receive — marking it received would starve the snapshot
              // trigger (the oldest > wm+1 check could never fire again). The hole itself is what
              // must arm the trigger (see evaluateSnapshotTrigger). P0-1/P1-2: a flush-failed
              // segment keeps the watermark put as well (never advance over unapplied rows).
              const from = Number(seg && seg.fromSeq)
              const to = Number(seg && seg.toSeq)
              if (Number.isFinite(from) && Number.isFinite(to)) {
                if (!segFlushFailed) {
                  const wm = pullWatermarkBy.get(peer.deviceId) || 0
                  if (from <= wm + 1 && to > wm) pullWatermarkBy.set(peer.deviceId, to)
                  // pullAckSeq must come from the ENVELOPE, not seg.rows: the wire shape is
                  // {body, fromSeq, toSeq} — rows live inside the packed body and seg.rows never
                  // exists (the old per-row loop collected nothing, so our acks never carried
                  // appliedToSeq and the peer's serverPullAck never advanced — its pull response
                  // re-sent the full oplog window every round). toSeq is the segment's highest
                  // included seq in the PEER's seq space — same quantity the loop meant to take.
                  if (to > pullAckSeq) pullAckSeq = to
                } else {
                  // P0-1: a flush-failed segment is NOT acked — cap our appliedToSeq below it
                  // (the peer keeps its push watermark and re-pushes after snapshot recovery)
                  // and force-arm the snapshot trigger: increments alone cannot recover.
                  // Round-3 P1: the cap is remembered ROUND-WIDE (mirrors server-role.js) —
                  // a later segment with a higher toSeq used to re-raise pullAckSeq past the
                  // failure, so the final-chunk ack re-acked the failed segment's rows and the
                  // sender advanced its watermark over rows we actually dropped.
                  const fFrom = Number.isFinite(from) ? from : 0
                  if (roundFlushFailedFrom == null || fFrom < roundFlushFailedFrom) roundFlushFailedFrom = fFrom
                  needSnapshot.add(peer.deviceId)
                  needSnapshotForce.add(peer.deviceId) // survives roundApplied > 0 (Wave-B P1)
                }
                if (to > peerMaxSeqSeen) peerMaxSeqSeen = to
              }
            }
            // The ack is sent ONCE, at the final chunk (segments-chunk.js contract). appliedToSeq
            // is in the PEER's seq space (the rows' own seq): the peer feeds it into
            // buildSegments(fromSeq) against ITS oplog. Reporting our own local max here (the old
            // behavior) overshot the peer's cursor whenever our oplog ran ahead and silently
            // skipped its fresh rows every round.
            if (msg.final) {
              // Round-3 P1: apply the round-wide flush-failure cap HERE, just before the
              // final-chunk ack (server-role.js:92 parity) — mid-loop capping lost to later
              // segments re-raising pullAckSeq.
              if (roundFlushFailedFrom != null && pullAckSeq >= roundFlushFailedFrom) pullAckSeq = Math.max(0, roundFlushFailedFrom - 1)
              client.send({ type: 'ack', applied: msg.segments.length, rejected: 0, ...(pullAckSeq > 0 ? { appliedToSeq: pullAckSeq } : {}) })
              pullAckSeq = 0 // acked through here; a fresh push on this connection re-accumulates
              roundFlushFailedFrom = null
            }
          } else if (msg.type === 'snapshot-chunk' && Array.isArray(msg.rows)) {
            if (!awaitingSnapshot) throw new Error('unsolicited snapshot-chunk')
            chunkTotal = Number(msg.totalChunks) || chunkTotal
            const idx = Number(msg.index) || 0
            // Unbounded-transfer guard (round-3 review): a peer (or an attacker holding the
            // pairing secret) must not stream snapshot chunks forever — past the ceiling the
            // round fails and the trigger re-arms through the normal snapshot-error budget.
            chunkCount += 1
            if (chunkCount > maxSnapshotChunks) throw new Error(`snapshot too large: more than ${maxSnapshotChunks} chunks`)
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
            // retry-later — re-arm the trigger and let the normal backoff dial again. P2-d
            // (2026-09-19): counted as a round FAILURE for lastError/backoff purposes (no
            // resetBackoff) — reporting it as success made Device Center show healthy-while-
            // diverging. Not a hard error: the trigger re-arms and the retry timer is armed by
            // finish's failure path.
            if (!awaitingSnapshot) throw new Error('unsolicited snapshot-busy')
            awaitingSnapshot = false
            chunkBuf.clear()
            chunkRowCounts.clear()
            clientSnapshotBusy.delete(peer.deviceId)
            needSnapshot.add(peer.deviceId)
            snapshotBusyCollision = true // lan-sync-6: exempt from the dial-failure streak
            finish(new Error('snapshot-busy: peer is serving another snapshot, will retry'))
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
            // P2-d (2026-09-19): a snapshot-error terminal is a round FAILURE for lastError /
            // backoff purposes (no resetBackoff) so Device Center does not show healthy-while-
            // diverging; the retry budget above still keeps a transient failure recoverable.
            finish(new Error(`snapshot-error from peer: ${reason}`))
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
            // Monotonic guard + rollback detection (fix-round 2026-09-22, lan-sync-5): a cursor
            // of 0/absent must never REGRESS the watermark, but a cursor BELOW the recorded
            // watermark means the peer RESET its oplog (same deviceId, sequence restarted) —
            // adopt the lower cursor as the new epoch. The old strict max() wedged such a peer
            // forever: new low-seq rows could neither advance the watermark nor fire the
            // snapshot trigger (only deleting the watermarks on BOTH ends recovered).
            const incoming = Number(msg.cursor) || 0
            const prev = pullWatermarkBy.get(peer.deviceId) || 0
            const cursor = incoming > 0 && incoming < prev ? incoming : Math.max(prev, incoming)
            pullWatermarkBy.set(peer.deviceId, cursor) // watermark advances ONLY here
            if (incoming > 0 && incoming < prev) {
              // New epoch: the old session's snapshot-error budget is meaningless now.
              snapshotFatalCount.delete(peer.deviceId)
              snapshotErrorCooldown.delete(peer.deviceId)
            }
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
            // P0-1 (2026-09-19 data-safety round): the peer flagged a flush failure on our push —
            // its ack stays BELOW the failed segment (appliedToSeq already capped receiver-side).
            // Do not advance the watermark past unacked data and force-arm the snapshot trigger:
            // the next round opens with a snapshot-request and the peer re-applies our full
            // state idempotently (recovering whatever its bulk flush dropped).
            if (msg.flushFailed) {
              needSnapshot.add(peer.deviceId)
              needSnapshotForce.add(peer.deviceId) // survives roundApplied > 0 (Wave-B P1)
              // Layer-2: the ack no longer settles the round as success below — end it as a
              // FAILURE (streak-exempt) so the dropped-push stall is user-visible instead of
              // an endless string of silent "ok" rounds.
              flushFailedAck = true
            }
            // ackSeq is in OUR seq space (max seq among our rows the peer applied). Defensive
            // clamp to our own max oplog seq: a misbehaving/legacy peer (reporting its own local
            // seq space — the pre-2026-09-18 bug) must never push our cursor past our own oplog,
            // which would permanently skip our fresh rows.
            let seq = ackSeq
            if (getMaxSeq) seq = Math.min(seq, currentMaxSeq())
            // P0-1: a flush-failed ack means the peer DROPPED our rows — never advance the push
            // watermark past unacked data (the re-push after the snapshot recovery is idempotent).
            if (!msg.flushFailed && seq > (peerProgress.get(peer.deviceId) || 0)) peerProgress.set(peer.deviceId, seq)
            // Layer-2: a flush-failed ack settles the round as a FAILURE (before the normal
            // success path / attachment pull below) — the peer dropped our pushed rows, so
            // this round must not count as a healthy "ok". The needSnapshotForce arm above
            // plus the untouched push-watermark guard make the next round open with a
            // snapshot-request that re-applies our full state idempotently (recovery).
            if (flushFailedAck) { finish(new Error('peer dropped pushed rows (flush failed)')); return }
            evaluateSnapshotTrigger()
            // The round's finish waits for snapshot-end (the ack only proves the peer got MY push); attachment
            // pull likewise keeps it open until att-end. Pull send-failures are isolated inside the puller —
            // an attachment failure must NEVER fail the sync round (2026-09-19 drill).
            if (!awaitingSnapshot && !att.maybeStart(() => finish(null), () => finish(null))) finish(null)
          } else if (msg.type === 'unpaired') {
            // P1-4: the peer told us it removed our pairing — same terminal path as an auth
            // rejection (no more dialing until the user re-pairs; distinct Device Center state).
            authRejected = true
            finish(new Error('peer removed this pairing (unpaired)'))
          } else if (att.handles(msg.type)) { // attachment frames: att-end settles the round
            progressDeadline()
            let attOpen = true; try { attOpen = att.onMessage(msg) } catch (err) { try { require('electron-log').warn('[LanSync] att frame error:', err && err.message) } catch { /* noop */ } } // round isolation: a transfer error ends the round cleanly, never rejects it
            if (!attOpen) finish(null)
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

  // Round-3 P1: per-peer round mutex — one dial per peer at a time (lives with the only
  // code that reads and releases it).
  const roundsInFlight = new Set()

  return { syncWithPeer }
}

module.exports = { createClientRound }
