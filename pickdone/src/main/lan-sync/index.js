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
const os = require('node:os')
const { createDiscovery, PROTO_VER, isDialableHost } = require('./discovery')
const { createLanServer, DEFAULT_PORT } = require('./transport')
const { deriveAuthCode } = require('./pairing')
const { createServerRoleHandler } = require('./server-role')
const { createAttachmentServer } = require('./att-transfer')
const { createPairingClient } = require('./pairing-client')
const { createClientRound } = require('./client-round')

const BACKOFF_BASE_MS = 5000
const BACKOFF_MAX_MS = 60 * 1000
// P1-3 (2026-09-19 data-safety round): dial budget. After DIAL_FAILURE_BUDGET consecutive failed
// rounds a peer enters long-hibernate: retries drop to HIBERNATE_BACKOFF_MS (10min) instead of
// the <=60s exponential cap, and the per-failure error fan-out (round-error event -> renderer
// broadcast) collapses to ONE emission per hibernate window (streak > budget suppresses the
// event; the recent ring still records every attempt). Any confirmed round resets the streak.
// Both injectable via opts for tests.
const DIAL_FAILURE_BUDGET_DEFAULT = 10
const HIBERNATE_BACKOFF_MS_DEFAULT = 10 * 60 * 1000
// Snapshot transfer ceiling (round-3 review): a snapshot answering with more than this many
// chunk messages is refused with snapshot-error {reason:'too-large'} instead of streaming
// unboundedly (512 chunks x ~1MB ≈ a 500MB ceiling — generous for a todo library).
const MAX_SNAPSHOT_CHUNKS = 512
// Peer-bookkeeping ceiling (round-3 review): mDNS/UDP floods must not grow the peer table,
// lastSeen map, or Device Center state without limit. LRU-expelled beyond this.
const MAX_PEERS = 64
// Device Center: a peer counts as "online" while mDNS saw it (or its last round succeeded)
// within this window; a 30s sweep flips stale peers offline and emits peer-offline.
const ONLINE_WINDOW_MS = 90 * 1000
const SWEEP_INTERVAL_MS = 30 * 1000
// In-memory rings surfaced by getStatus(): recent sync activity (last 50) and security
// events (pair throttling / auth rejections, last 20).
const RECENT_CAP = 50
const SECURITY_CAP = 20

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
  // Backoff schedule, injectable for tests (busy-collision re-dial timing etc.). Production
  // defaults: 5s base, exponential to a 60s cap.
  const backoffBaseMs = Number(opts.backoffBaseMs) || BACKOFF_BASE_MS
  const backoffMaxMs = Number(opts.backoffMaxMs) || BACKOFF_MAX_MS
  // P1-3 hibernate budget (see the constants block above); injectable for tests.
  const DIAL_FAILURE_BUDGET = Number(opts.dialFailureBudget) || DIAL_FAILURE_BUDGET_DEFAULT
  // Layer-2 (stalled-push finding): consecutive flush-failed rounds before the Device Center
  // flips peerState to 'flush-stalled' (injectable for tests).
  const FLUSH_STALL_BUDGET = Number(opts.flushStallBudget) || 3
  const HIBERNATE_BACKOFF_MS = Number(opts.hibernateBackoffMs) || HIBERNATE_BACKOFF_MS_DEFAULT
  // Per-snapshot transfer ceiling (injectable for tests; see MAX_SNAPSHOT_CHUNKS above).
  const maxSnapshotChunks = Number(opts.maxSnapshotChunks) || MAX_SNAPSHOT_CHUNKS
  const backoffMs = new Map() // deviceId -> current backoff delay
  const retryTimers = new Map() // deviceId -> timer
  // P1-3: per-peer dial bookkeeping. failStreakBy counts consecutive failed rounds; dialNotBefore
  // is the earliest ms epoch the periodic startSyncRound may dial the peer (retry timers bypass
  // it — they ARE the scheduled dial). unpairedBy holds TERMINAL auth-rejected peers: no dialing
  // at all until the user re-pairs/unpairs/restarts (a re-announced/re-added peer clears it).
  const failStreakBy = new Map() // deviceId -> consecutive failed rounds
  // Layer-2 (stalled-push finding): consecutive flush-failed rounds per peer. Past
  // FLUSH_STALL_BUDGET the Device Center surfaces peerState 'flush-stalled' — the recovery
  // loop (force-armed snapshot on both ends) is NOT converging and needs user attention.
  const flushStallBy = new Map() // deviceId -> consecutive flush-failed rounds
  const dialNotBefore = new Map() // deviceId -> ms epoch
  const unpairedBy = new Set() // deviceId set (terminal peer-unauthorized)
  // Round-2 P1 (2026-09-21): re-fix budget. A DEAD peer whose discovery record keeps flapping
  // addresses used to reset the dial-failure streak on every wrong-address "re-fix" (fresh addr
  // → immediate retry → fail → new addr …) = infinite round-error spam, hibernate unreachable.
  // Re-fixes now count toward REFIX_BUDGET per REFIX_WINDOW_MS; past the budget the re-fix is
  // skipped and hibernate applies normally. The streak itself is only ever cleared by a
  // SUCCESSFUL round (resetBackoff on the success path).
  const refixTimesBy = new Map() // deviceId -> array of re-fix ms epochs (hour-bounded)
  // Wave-B P2-4: peers whose backlog contains a SINGLE segment over the wire cap. Terminal for the
  // retry loop (re-pushing can never succeed); cleared by forgetPeer / a fresh rememberPeer so a
  // peer that fixes its data (row edited/deleted) syncs again without a restart.
  const oversizedSegmentBy = new Set()
  const REFIX_BUDGET = 6
  const REFIX_WINDOW_MS = 60 * 60 * 1000
  // P1-4: live AUTHENTICATED server sockets per peer (last message wins) so an unpair can
  // best-effort notify the peer with an `unpaired` control message before the node stops.
  const liveServerSockets = new Map() // deviceId -> socket
  // Fix-round (2026-09-22, lan-sync-4): client connections of IN-FLIGHT rounds. stop() used to
  // destroy only the server-side sockets — a round's client socket kept the event loop alive
  // until its unref'd 120s round deadline (or the peer's FIN), so a graceful exit could hang
  // for up to two minutes. stop() closes every in-flight client explicitly.
  const activeClients = new Set() // client emitters with an unsettled round
  const authCode = deriveAuthCode(pairingSecret, deviceId)
  // Own-address set (self-dial guard, 2026-09-18 real-machine incident): a peer entry whose host
  // routes back to THIS node (second NIC IP, stale DHCP manual entry) makes us dial ourselves.
  // Non-loopback only: CI two-node tests legitimately share 127.0.0.1. Injectable for tests.
  const ownHosts = new Set(Array.isArray(opts.ownHosts) ? opts.ownHosts : (() => {
    const out = []
    try { for (const l of Object.values(os.networkInterfaces())) for (const ni of l || []) if (ni && ni.address && !ni.internal) out.push(ni.address) } catch { /* best effort */ }
    return out
  })())
  // Per-peer push watermarks: deviceId -> highest seq that peer has acked. Injected (a live Map) by
  // the bootstrap, which owns persistence; dead peers holding stale entries can no longer gate
  // other peers' rounds, and each round only ships a peer's unconfirmed delta.
  const peerProgress = opts.peerProgress || new Map()
  // Server-role per-peer pull progress (round-3 review): deviceId -> highest seq (OUR seq
  // space) the peer has acked across our pushed rows. The server role's pull response used to
  // call buildSegments() with no cursor every round, re-sending the full oplog window forever
  // (markPushed is deliberately not wired — per-peer watermarks replaced the global cursor).
  // Acked seqs arrive via the 'ack' messages the peer sends for OUR push; the next round's
  // pull response starts past them. Unknown peer -> full window (the old behavior).
  const serverPullAck = new Map()

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
  // Wave-B P1: FORCE-armed snapshot triggers. A flush-failed segment (receiver dropped rows it
  // could not flush) is a poison state increments can never fix: even when the NEXT round applies
  // other rows (roundApplied > 0), the snapshot request must still fire or the failed rows are
  // re-pushed and re-dropped forever. Flags here survive evaluateSnapshotTrigger's progress clear
  // (which only manages `needSnapshot`) and are consumed once the snapshot-request actually goes out.
  const needSnapshotForce = new Set()
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
  // Round-1 P0 (2026-09-21): discovery re-resolution hook — on a failed round the node asks the
  // discovery layer for a FRESH address for the peer before scheduling the retry (mDNS/UDP keep
  // announcing while the peer is reachable). Injectable for tests.
  const resolvePeerFn = typeof opts.resolvePeer === 'function'
    ? opts.resolvePeer
    : (id) => {
      try {
        for (const p of discovery.getPeers() || []) {
          if (p && p.deviceId === id && isDialableHost(p.host)) return p
        }
      } catch { /* best effort */ }
      return null
    }
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
  /** Drop every per-peer trace of `id` (LRU eviction + self-dial peer removal share this). */
  function forgetPeer(id) {
    peers.delete(id); lastSeenBy.delete(id); lastRoundBy.delete(id); errorBy.delete(id)
    const t = retryTimers.get(id)
    if (t) { clearTimeout(t); retryTimers.delete(id) }
    backoffMs.delete(id); onlineNow.delete(id); needSnapshot.delete(id); needSnapshotForce.delete(id)
    clientSnapshotBusy.delete(id); serverSnapshotBusy.delete(id)
    snapshotFatalCount.delete(id); snapshotErrorCooldown.delete(id)
    pullWatermarkBy.delete(id); serverPullAck.delete(id)
    peerProgress.delete(id) // Wave-B P3: a forgotten peer's push watermark must not linger
    failStreakBy.delete(id); dialNotBefore.delete(id); unpairedBy.delete(id); liveServerSockets.delete(id)
    flushStallBy.delete(id) // Layer-2: a forgotten peer's flush-stall counter must not linger
    refixTimesBy.delete(id); oversizedSegmentBy.delete(id)
    // Fix-round (2026-09-22, lan-sync-8): attachment bookkeeping is per-peer too — the pull
    // session's request budget and the server role's served-request counter must not outlive
    // the peer (they leaked until node stop).
    attSession.requests.delete(id)
    attServer.forget(id)
  }
  const pushRecent = (entry) => pushRing(recent, RECENT_CAP, entry)
  // security ring: seeded from the persisted log (opts.securityLog, owned by the bootstrap —
  // the ephemeral process used to lose pair-throttle/auth-reject history on every restart).
  // Shape-checked at the trust boundary: the seed comes off settings_rows/disk, so a malformed
  // persisted entry must not poison the security ring (rendered verbatim in Device Center).
  const isshapelySecurityEntry = (e) => e && typeof e === 'object' &&
    Number.isFinite(Number(e.at)) && typeof e.ip === 'string' && typeof e.reason === 'string'
  if (Array.isArray(opts.securityLog)) {
    for (const e of opts.securityLog.filter(isshapelySecurityEntry).slice(-SECURITY_CAP)) pushRing(security, SECURITY_CAP, e)
  }
  const pushSecurity = (entry) => { pushRing(security, SECURITY_CAP, entry); em.emit('security-entry', entry) }

  // Client-side pairing flows (pairWith/requestPair) are extracted to pairing-client.js
  // (line ratchet). Pure orchestration over transport.connect; the factory is pure wiring.
  const { pairWith, requestPair } = createPairingClient({ peers, deviceId, name, em })

  // Server-role message handling (segments-chunk push receive + ack bookkeeping + snapshot-request
  // serving) is extracted to server-role.js (line ratchet). The handler is pure orchestration over
  // the node's own state/callbacks.
  // Fix-round (2026-09-22, lan-sync-8): keep the att-server INSTANCE so forgetPeer can reclaim
  // its per-peer request counters (only .serve used to be retained).
  const attServer = createAttachmentServer(opts.attachmentServerDeps)
  const handleServerMessage = createServerRoleHandler({
    ingestSegment, buildSegments, buildSnapshot, buildSnapshotRows,
    getMaxSeq: getMaxSeq ? currentMaxSeq : null,
    getOldestSeq: getOldestSeq ? currentOldestSeq : null,
    serverSnapshotBusy, serverPullAck,
    maxSnapshotChunks, snapshotSchemaVersion: opts.snapshotSchemaVersion,
    pushRecent,
    serveAttachments: attServer.serve, // per-node att-req server (rate caps inside)
    // Layer-2 (stalled-push finding): a flush-failed ingest of a peer's push arms OUR
    // snapshot recovery toward that peer as well (needSnapshotForce survives roundApplied > 0),
    // not just the sender's own force-arm via the flushFailed ack flag.
    onIngestFlushFailed: (peer) => {
      const id = peer && peer.deviceId
      if (!id) return
      needSnapshot.add(id)
      needSnapshotForce.add(id)
    },
    onSnapshotError: (info) => em.emit('snapshot-error', info),
    onSnapshotSync: (info) => em.emit('snapshot-sync', info),
    onServerError: (err) => em.emit('server-error', err),
    // P1-4: an authenticated peer told us it removed our pairing (unpaired control message).
    onUnpaired: (peer) => {
      const id = peer && peer.deviceId
      if (!id) return
      unpairedBy.add(id)
      errorBy.set(id, 'unpaired: the peer removed this pairing, please re-pair')
      const t = retryTimers.get(id)
      if (t) { clearTimeout(t); retryTimers.delete(id) }
      pushRecent({ at: Date.now(), kind: 'error', peer: id, detail: { error: 'peer removed this pairing (unpaired)' } })
      refreshOnline(id)
      em.emit('peer-unpaired-remote', { peer: id })
    },
  })
  // Attachment pull session state: failed-set (P2-e: TIMESTAMPED entries, expire after 24h so a
  // transient failure is retried the next day) + request budgets live across rounds (no retry loops).
  const attSession = { failed: new Map(), requests: new Map() }

  // Client-role round handling (push/pull/ack/snapshot-request + deadline) is extracted to
  // client-round.js (line ratchet). The node's mutable scalars cross the boundary as
  // accessors — a bare reference would only snapshot the current value.
  const setLastError = (msg) => { lastError = msg }
  const setLastRoundAt = (t) => { lastRoundAt = t; return t }
  const { syncWithPeer } = createClientRound({
    opts, deviceId, authCode, pairingSecret, em,
    peers, retryTimers, lastRoundBy, failStreakBy, oversizedSegmentBy, unpairedBy, activeClients,
    needSnapshot, needSnapshotForce, clientSnapshotBusy, pullWatermarkBy,
    snapshotFatalCount, snapshotErrorCooldown, flushStallBy, errorBy,
    attSession, peerProgress, DIAL_FAILURE_BUDGET, maxSnapshotChunks,
    buildSegments, ingestSegment, ingestSnapshot, ingestSnapshotChunk,
    getMaxSeq, currentMaxSeq,
    getStopped: () => stopped,
    bumpRounds: (d) => { roundsRunning += d },
    setLastRoundAt, setLastError,
    pushRecent, refreshOnline, scheduleRetry, resetBackoff, tryRefixAddress, forgetPeer,
    sendVia,
  })

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
    // Self-dial guard: never admit a peer whose host is one of our own addresses (see ownHosts).
    if (peer.host && ownHosts.has(peer.host)) return
    // Bounded bookkeeping (round-3 review): a mDNS/UDP flood of random deviceIds must not grow
    // the peer/lastSeen maps without limit. Beyond MAX_PEERS, expel the LEAST-recently-seen
    // peer (never the incoming one) from every per-peer map.
    if (!peers.has(peer.deviceId) && peers.size >= MAX_PEERS) {
      let oldestId = null
      let oldestAt = Infinity
      for (const [id, seen] of lastSeenBy) {
        if (seen < oldestAt) { oldestAt = seen; oldestId = id }
      }
      if (oldestId) forgetPeer(oldestId)
    }
    const prev = peers.get(peer.deviceId)
    // Round-1 P0 (2026-09-21): sanitize the incoming host — a scope-less link-local IPv6, an IPv4
    // link-local, or a virtual-adapter range (192.168.111.* VMware NAT) is never dialable; keep
    // the previous host when the fresh one is junk instead of overwriting a working address.
    const freshHostDialable = isDialableHost(peer.host)
    if (peer.host && !freshHostDialable && prev && isDialableHost(prev.host)) peer = { ...peer, host: prev.host }
    peers.set(peer.deviceId, {
      deviceId: peer.deviceId,
      name: peer.name || (prev && prev.name) || peer.deviceId,
      host: (freshHostDialable ? peer.host : undefined) || (prev && isDialableHost(prev.host) ? prev.host : undefined),
      port: Number.isInteger(peer.port) ? peer.port : prev && prev.port,
      protoVer: peer.protoVer || (prev && prev.protoVer) || PROTO_VER,
    })
    lastSeenBy.set(peer.deviceId, Date.now())
    // P1-3: a re-announced/re-added peer is dialable again — clear the terminal unpaired state
    // AND its error stamp (the user re-paired; the stale auth-rejection must not linger in
    // the Device Center card).
    if (unpairedBy.delete(peer.deviceId)) errorBy.delete(peer.deviceId)
    // Wave-B P2-4: a re-announced / re-added peer gets a fresh chance — the offending row may have
    // been trimmed or deleted on either side since the terminal error.
    if (oversizedSegmentBy.delete(peer.deviceId)) errorBy.delete(peer.deviceId)
    refreshOnline(peer.deviceId)
    em.emit('peer', peers.get(peer.deviceId))
  }

  /** Clear pending retry and reset backoff after success. */
  function resetBackoff(peerId) {
    const t = retryTimers.get(peerId)
    if (t) { clearTimeout(t); retryTimers.delete(peerId) }
    backoffMs.set(peerId, backoffBaseMs)
    failStreakBy.delete(peerId) // P1-3: a confirmed round resets the dial-failure budget
    dialNotBefore.delete(peerId)
  }

  function scheduleRetry(peerId) {
    if (stopped || retryTimers.has(peerId)) return
    // P1-3 hibernate: after DIAL_FAILURE_BUDGET consecutive failures the retry cadence drops to
    // HIBERNATE_BACKOFF_MS (long-hibernate) instead of the <=60s exponential cap.
    const hibernating = (failStreakBy.get(peerId) || 0) >= DIAL_FAILURE_BUDGET
    const delay = hibernating ? HIBERNATE_BACKOFF_MS : Math.min(backoffMs.get(peerId) || backoffBaseMs, backoffMaxMs)
    backoffMs.set(peerId, hibernating ? backoffMaxMs : Math.min(delay * 2, backoffMaxMs))
    dialNotBefore.set(peerId, Date.now() + delay) // startSyncRound respects this between retries
    const t = setTimeout(() => {
      retryTimers.delete(peerId)
      const p = peers.get(peerId)
      if (p && !stopped) syncWithPeer(p)
    }, delay)
    t.unref?.()
    retryTimers.set(peerId, t)
  }

  /** Fix-round (2026-09-22, lan-sync-7): shared discovery re-resolution (extracted from finish's
   *  error path so the invalid host/port EARLY-EXIT dial path gets the same self-healing). A
   *  fresh, DIFFERENT, dialable discovery record replaces the stored one, budgeted per
   *  REFIX_WINDOW_MS so a flapping dead peer still reaches hibernate. On success the retry timer
   *  is rearmed at base backoff (fast retry) WITHOUT touching the failure streak — only a
   *  SUCCESSFUL round on the new address resets the budget. Returns true when a re-fix happened. */
  function tryRefixAddress (peerId) {
    try {
      const again = typeof resolvePeerFn === 'function' ? resolvePeerFn(peerId) : null
      const newHost = again && again.host
      const newPort = Number(again && again.port)
      if (!newHost || !isDialableHost(newHost)) return false
      if (!Number.isInteger(newPort) || newPort < 1 || newPort > 65535) return false
      const stored = peers.get(peerId)
      if (newHost === (stored && stored.host) && newPort === (stored && stored.port)) return false
      const nowMs = Date.now()
      const times = (refixTimesBy.get(peerId) || []).filter(t => nowMs - t < REFIX_WINDOW_MS)
      if (times.length >= REFIX_BUDGET) {
        refixTimesBy.set(peerId, times) // budget exhausted: hibernate applies normally
        return false
      }
      times.push(nowMs)
      refixTimesBy.set(peerId, times)
      rememberPeer({ ...again, deviceId: peerId, port: newPort })
      const t = retryTimers.get(peerId)
      if (t) { clearTimeout(t); retryTimers.delete(peerId) }
      backoffMs.set(peerId, backoffBaseMs)
      dialNotBefore.delete(peerId)
      pushRecent({ at: nowMs, kind: 'error', peer: peerId, detail: { error: `stored address failed; discovery re-resolved ${newHost}:${newPort}` } })
      return true
    } catch { return false }
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
      // Server-role message handling lives in server-role.js (createServerRoleHandler, wired
      // above): segments-chunk push receive + ack, per-peer pull cursor, snapshot-request
      // serving with the busy invariant and the transfer ceiling.
      // P1-4: remember the live authenticated socket per peer so an unpair can best-effort
      // notify the peer before the node stops. Cleared on node stop / forgetPeer.
      getHandler: (peer) => (msg, socket) => {
        try { if (peer && peer.deviceId && socket) liveServerSockets.set(peer.deviceId, socket) } catch { /* best effort */ }
        handleServerMessage(peer, msg, socket, sendVia)
      },
      onPeer: (peer, socket) => {
        // P1-4 + fix-round (2026-09-22, lan-sync-3): remember the live authenticated socket AND
        // drop it again when the socket dies — the entry used to linger forever holding a
        // destroyed socket, so notifyUnpaired "succeeded" against a dead peer.
        try {
          if (peer && peer.deviceId && socket) {
            liveServerSockets.set(peer.deviceId, socket)
            socket.once('close', () => {
              if (liveServerSockets.get(peer.deviceId) === socket) liveServerSockets.delete(peer.deviceId)
            })
          }
        } catch { /* best effort */ }
        em.emit('peer-connected', peer)
      },
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

    /** P1-4: drop every per-peer trace (manual-peer removal / unpair bookkeeping). */
    removePeer(peerId) {
      if (peerId) forgetPeer(String(peerId))
    },

    /** P1-3: manual retry-now (Device Center "sync now"): clear the dial window and cancel the
     *  pending retry timer so the next startSyncRound dials immediately. The failure streak is
     *  KEPT — a manual dial that fails again must not silently reset the hibernate budget. */
    forceDial(peerId) {
      const id = String(peerId || '')
      dialNotBefore.delete(id)
      const t = retryTimers.get(id)
      if (t) { clearTimeout(t); retryTimers.delete(id) }
    },

    /** P1-4: best-effort notify a connected peer that we removed the pairing. Returns true when
     *  an authenticated socket was live AND the control message actually went to the wire —
     *  fix-round (2026-09-22, lan-sync-3): send()'s false (destroyed/not-writable socket) used
     *  to be swallowed, so the caller believed a dead peer had been told. */
    notifyUnpaired(peerId) {
      const socket = liveServerSockets.get(String(peerId || ''))
      if (!socket) return false
      try { return sendVia(socket, { type: 'unpaired' }) !== false } catch { return false }
    },

    /** Run one sync round against every known peer (sequentially). P1-3: the periodic round
     *  respects per-peer dial budgets — peers in terminal unpaired state are never dialed, and
     *  peers inside their backoff/hibernate window are skipped (the retry timer dials them). */
    async startSyncRound() {
      const now = Date.now()
      const targets = Array.from(peers.values()).filter(p => {
        if (unpairedBy.has(p.deviceId)) return false
        if ((dialNotBefore.get(p.deviceId) || 0) > now) {
          // Backoff/hibernate window still open: the retry timer dials the peer when it opens.
          // Re-arm a timer when none is pending (e.g. timers were cleared) so the peer is not
          // stranded until the next periodic round.
          if (!retryTimers.has(p.deviceId) && !stopped) scheduleRetry(p.deviceId)
          return false
        }
        return !stopped
      })
      // Parallel: a dead peer's 5s connect timeout must never delay a live peer's round
      // (observed live: one stale entry serialized ~5-20s in front of every healthy exchange).
      const results = await Promise.all(targets.map(async peer => (stopped ? false : syncWithPeer(peer))))
      let confirmed = 0
      for (const ok of results) if (ok) confirmed += 1
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
          // P1-3: structured per-peer state for the Device Center. 'unpaired' = TERMINAL auth
          // rejection (the peer removed our pairing — renderer copy: "已被对方解除配对,请重新配对");
          // 'oversized-segment' = TERMINAL wire-cap violation (Wave-B P2-4); 'flush-stalled' =
          // FLUSH_STALL_BUDGET consecutive flush-failed rounds (the peer keeps dropping our
          // push and the snapshot recovery is not converging); 'hibernating' = past
          // the dial-failure budget (10min retries); 'error' = recent failure.
          const peerState = unpairedBy.has(p.deviceId) ? 'unpaired'
            : oversizedSegmentBy.has(p.deviceId) ? 'oversized-segment'
              : (flushStallBy.get(p.deviceId) || 0) >= FLUSH_STALL_BUDGET ? 'flush-stalled'
                : (failStreakBy.get(p.deviceId) || 0) >= DIAL_FAILURE_BUDGET ? 'hibernating'
                  : errorBy.has(p.deviceId) ? 'error' : 'ok'
          return {
            ...p,
            // Round-2 P1: the renderer reads p.deviceName — the raw peer record only carries
            // `name`, so Device Center showed raw UUIDs. Carry both.
            deviceName: p.name,
            online: (!!seen && now - seen < ONLINE_WINDOW_MS) || (!!lr && now - lr < ONLINE_WINDOW_MS),
            lastRoundAt: lr || null,
            lastError: errorBy.get(p.deviceId) || null,
            peerState,
            // P1-3: earliest ms epoch this peer will be dialed again (backoff/hibernate window);
            // null = dialable now. Device Center can render "retrying in Xs" from it.
            nextDialAt: dialNotBefore.get(p.deviceId) || null,
            // Push-side watermark (deviceId -> highest seq this peer acked). NOTE: the
            // stalled-push finding report cited this line as 1142 — line numbers drift;
            // reference getStatus().peers[].watermark by name instead.
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
      // Fix-round (2026-09-22, lan-sync-4): close the CLIENT sockets of in-flight rounds too —
      // they held the event loop open until the unref'd 120s round deadline (or peer FIN),
      // stalling a graceful exit by up to two minutes. close() triggers each round's
      // connection-close handler, so the rounds settle as failures through the normal path.
      for (const c of activeClients) { try { c.close() } catch { /* best effort */ } }
      activeClients.clear()
      liveServerSockets.clear()
      for (const t of retryTimers.values()) clearTimeout(t)
      retryTimers.clear()
      try { discovery.stop() } catch { /* noop */ }
      if (server) await server.close()
      em.emit('stopped')
    },
  }
}

module.exports = { createLanSyncNode, BACKOFF_BASE_MS, BACKOFF_MAX_MS, DIAL_FAILURE_BUDGET_DEFAULT, HIBERNATE_BACKOFF_MS_DEFAULT }
