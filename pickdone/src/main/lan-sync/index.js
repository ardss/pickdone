'use strict'

/**
 * LAN sync node (P3a): glue wiring discovery + server + client into a single
 * sync-round state machine.
 *
 * Round protocol (both directions, over transport.js after auth):
 *   A -> B: segments {segments: buildSegments()}   push my pending segments
 *   B -> A: ack {applied, rejected} + B's own segments (pull)
 *   A -> B: snapshot-request {requesterMaxSeq?} when B pruned past A's watermark
 *   B -> A: snapshot-chunk* {index, totalChunks, rows} + snapshot-end {totalRows, cursor}
 *   B -> A: snapshot {snapshot} (legacy whole-snapshot reply, kept for compat)
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
const { chunkSnapshot } = require('./snapshot')

const BACKOFF_BASE_MS = 5000
const BACKOFF_MAX_MS = 60 * 1000
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
    ingestSegment, ingestSnapshot, buildSegments, buildSnapshot,
  } = opts
  const port = Number.isInteger(opts.port) ? opts.port : DEFAULT_PORT
  const host = opts.host
  const em = new EventEmitter()

  // Optional injector: local max oplog seq. The server role answers with `appliedToSeq` (its own
  // local max oplog seq after the round's ingest+flush), which the client records as that peer's
  // push watermark so the next round ships only the unconfirmed delta instead of a full re-push.
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
  //   snapshotBusy — one snapshot transfer in flight per peer, both roles (never overlap).
  const pullWatermarkBy = new Map() // deviceId -> seq
  const needSnapshot = new Set()
  const snapshotBusy = new Set()

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
      let ackSeq = 0 // peer's advertised appliedToSeq (its local max oplog seq)
      let ackOldestSeq = null // peer's advertised oldest RETAINED seq (undefined for old peers)
      let roundApplied = 0 // rows the peer's segments changed locally this round (0 = no pull progress)
      let awaitingSnapshot = false // snapshot-request sent; the round ends at snapshot-end, not ack
      const chunkBuf = new Map() // snapshot-chunk index -> rows (assembled at snapshot-end)
      let chunkTotal = 0 // chunk count as advertised by the chunk messages
      // Round deadline timer; cleared in finish() so a fast ack does not leak it past round end.
      let done = null
      const client = connect(peer.host, peer.port, {
        deviceId,
        authCode,
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
        snapshotBusy.delete(peer.deviceId)
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
        if (roundApplied > 0) { needSnapshot.delete(peer.deviceId); return }
        const oldest = Number(ackOldestSeq)
        if (!Number.isFinite(oldest) || oldest <= 0) return // peer did not advertise; nothing to act on
        if (ackSeq <= wm) return // fully caught up with the peer's max seq
        if (oldest > wm + 1 && !snapshotBusy.has(peer.deviceId)) needSnapshot.add(peer.deviceId)
      }
      client.on('error', (err) => finish(err))
      client.on('rejected', () => finish(new Error('auth rejected by peer')))
      // A socket death MID-snapshot must fail the round promptly (pull watermark stays put, the
      // next round re-requests) instead of idling to the 120s deadline. Post-finish closes are
      // no-ops (settled guard).
      client.on('close', () => { if (awaitingSnapshot && !settled) finish(new Error('connection closed during snapshot transfer')) })
      client.on('ready', () => {
        // push only what this peer has not confirmed yet (per-peer watermark; 0 = first contact)
        const mine = buildSegments ? buildSegments(peerProgress.get(peer.deviceId) || 0) : []
        client.send({ type: 'segments', segments: mine })
        // Deterministic trigger from the previous round: my increments are gone on the peer —
        // request a full snapshot INSTEAD of another futile incremental round. One transfer per
        // peer at a time (snapshotBusy); the round now ends at snapshot-end, not at the ack.
        if (needSnapshot.has(peer.deviceId) && !snapshotBusy.has(peer.deviceId)) {
          needSnapshot.delete(peer.deviceId)
          snapshotBusy.add(peer.deviceId)
          awaitingSnapshot = true
          chunkBuf.clear()
          client.send({ type: 'snapshot-request' })
        }
      })
      client.on('message', (msg) => {
        try {
          if (msg.type === 'segments' && Array.isArray(msg.segments)) {
            for (const seg of msg.segments) {
              const r = ingestSegment(seg)
              roundApplied += (r && Number(r.applied)) || 0
              if (seg && Number.isFinite(Number(seg.toSeq))) {
                pullWatermarkBy.set(peer.deviceId, Math.max(pullWatermarkBy.get(peer.deviceId) || 0, Number(seg.toSeq)))
              }
            }
            client.send({ type: 'ack', applied: msg.segments.length, rejected: 0 })
          } else if (msg.type === 'snapshot' && msg.snapshot) {
            ingestSnapshot(msg.snapshot)
            client.send({ type: 'ack', applied: 1, rejected: 0, appliedToSeq: currentMaxSeq() })
          } else if (msg.type === 'snapshot-chunk' && Array.isArray(msg.rows)) {
            chunkTotal = Number(msg.totalChunks) || chunkTotal
            chunkBuf.set(Number(msg.index) || 0, msg.rows)
          } else if (msg.type === 'snapshot-end') {
            // All-or-nothing finalization: the chunks must tile exactly [0..n) and sum to
            // totalRows, and ingestSnapshot must succeed — ONLY then does the pull watermark
            // advance to the sender's cursor. A partial/failed snapshot fails the round, leaves
            // the DB at the per-chunk committed state (merge-apply is idempotent), and the next
            // round re-requests (the trigger re-fires because the watermark did not advance).
            const chunkCount = Number(msg.totalChunks) || chunkTotal // chunk count rides on snapshot-chunk
            const totalRows = Number(msg.totalRows) || 0
            const okShape = Number.isInteger(chunkCount) && chunkCount > 0 && chunkBuf.size === chunkCount &&
              Array.from({ length: chunkCount }, (_, i) => chunkBuf.has(i)).every(Boolean)
            const rows = okShape ? Array.from({ length: chunkCount }, (_, i) => chunkBuf.get(i)).flat() : null
            chunkBuf.clear()
            if (!rows || rows.length !== totalRows) {
              throw new Error(`incomplete snapshot: ${rows ? rows.length : 'bad chunk set'} of ${totalRows} rows`)
            }
            ingestSnapshot({ schemaVersion: Number(msg.schemaVersion) || 1, deviceId: peer.deviceId, rows })
            const cursor = Number(msg.cursor) || 0
            pullWatermarkBy.set(peer.deviceId, cursor) // watermark advances ONLY here
            snapshotBusy.delete(peer.deviceId)
            pushRecent({
              at: Date.now(), kind: 'snapshot', peer: peer.deviceId,
              detail: { direction: 'received', rows: rows.length, cursor },
            })
            em.emit('snapshot-sync', { peer: peer.deviceId, direction: 'received', rows: rows.length, cursor })
            awaitingSnapshot = false
            finish(null)
          } else if (msg.type === 'ack') {
            // Peer's ack is the round's success criterion: it confirms our push AND proves the
            // peer finished building its own response. Timing the round out as "success" here
            // would advance the push cursor over undelivered segments (2026-09-17 live drill).
            ackApplied = Number(msg.applied) || 0
            ackSeq = Number(msg.appliedToSeq) || 0
            ackOldestSeq = msg.oldestSeq
            const seq = ackSeq
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
      // The budget covers a FIRST sync between two real devices: tens of thousands of oplog rows
      // ingested on both sides before either ack can be produced (2026-09-17 drill measured >30s).
      done = setTimeout(() => finish(new Error('round timed out waiting for peer ack')), 120000)
      done.unref?.()
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
          if (msg.type === 'segments' && Array.isArray(msg.segments)) {
            // appliedToSeq = our local max oplog seq after this round's ingest+flush is committed.
            // Without it the client's push watermark never advances and every round re-pushes the
            // full backlog. Read before AND after ingest (rows may re-capture into our oplog) and
            // take the max, so an empty ingest still reports an honest, monotonic high-water value.
            // oldestSeq advertises the oldest oplog seq we still RETAIN: a peer below it sees
            // pruned history and knows it must request a snapshot (see the client trigger).
            const seqBefore = currentMaxSeq()
            for (const seg of msg.segments) ingestSegment(seg)
            const appliedToSeq = Math.max(seqBefore, currentMaxSeq())
            const mine = buildSegments ? buildSegments() : []
            sendVia(socket, { type: 'segments', segments: mine })
            sendVia(socket, { type: 'ack', applied: msg.segments.length, rejected: 0, appliedToSeq, oldestSeq: getOldestSeq ? currentOldestSeq() : undefined })
          } else if (msg.type === 'snapshot-request') {
            // Snapshot-request protocol: stream the live state as bounded snapshot-chunk messages
            // + a snapshot-end trailer carrying OUR current cursor, so the peer records it as its
            // pull watermark and the next round is incremental. One transfer per peer at a time;
            // sends are synchronous, so the busy flag is a documented invariant guard, not a queue.
            if (!buildSnapshot || snapshotBusy.has(peer.deviceId)) return
            snapshotBusy.add(peer.deviceId)
            try {
              const { chunks, totalRows, schemaVersion, cursor } = chunkSnapshot(buildSnapshot(), { cursor: currentMaxSeq() })
              for (const c of chunks) {
                sendVia(socket, { type: 'snapshot-chunk', index: c.index, totalChunks: chunks.length, schemaVersion, rows: c.rows })
              }
              sendVia(socket, { type: 'snapshot-end', totalRows, cursor, schemaVersion })
              pushRecent({
                at: Date.now(), kind: 'snapshot', peer: peer.deviceId,
                detail: { direction: 'sent', rows: totalRows, cursor, label: `对端请求全量快照 / 已发送 ${totalRows} 行` },
              })
              em.emit('snapshot-sync', { peer: peer.deviceId, direction: 'sent', rows: totalRows, cursor })
            } finally {
              snapshotBusy.delete(peer.deviceId)
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
    if (socket && socket.writable) socket.write(JSON.stringify(msg) + '\n')
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
