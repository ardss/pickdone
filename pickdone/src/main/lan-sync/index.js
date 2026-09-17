'use strict'

/**
 * LAN sync node (P3a): glue wiring discovery + server + client into a single
 * sync-round state machine.
 *
 * Round protocol (both directions, over transport.js after auth):
 *   A -> B: segments {segments: buildSegments()}   push my pending segments
 *   B -> A: ack {applied, rejected} + B's own segments (pull)
 *   B -> A: snapshot {snapshot} when the peer requests a full state
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

const BACKOFF_BASE_MS = 5000
const BACKOFF_MAX_MS = 60 * 1000

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

  const peers = new Map() // deviceId -> {deviceId, name, host, port}
  const backoffMs = new Map() // deviceId -> current backoff delay
  const retryTimers = new Map() // deviceId -> timer
  const authCode = deriveAuthCode(pairingSecret, deviceId)
  // Per-peer push watermarks: deviceId -> highest seq that peer has acked. Injected (a live Map) by
  // the bootstrap, which owns persistence; dead peers holding stale entries can no longer gate
  // other peers' rounds, and each round only ships a peer's unconfirmed delta.
  const peerProgress = opts.peerProgress || new Map()

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
        roundsRunning -= 1
        client.close()
        if (err) {
          lastError = `${peer.deviceId}: ${err.message}`
          em.emit('round-error', { peer: peer.deviceId, error: err })
          scheduleRetry(peer.deviceId)
          resolve(false)
        } else {
          lastRoundAt = Date.now()
          lastError = null
          resetBackoff(peer.deviceId)
          em.emit('round-done', { peer: peer.deviceId })
          resolve(true)
        }
      }
      client.on('error', (err) => finish(err))
      client.on('rejected', () => finish(new Error('auth rejected by peer')))
      client.on('ready', () => {
        // push only what this peer has not confirmed yet (per-peer watermark; 0 = first contact)
        const mine = buildSegments ? buildSegments(peerProgress.get(peer.deviceId) || 0) : []
        client.send({ type: 'segments', segments: mine })
      })
      client.on('message', (msg) => {
        try {
          if (msg.type === 'segments' && Array.isArray(msg.segments)) {
            for (const seg of msg.segments) ingestSegment(seg)
            client.send({ type: 'ack', applied: msg.segments.length, rejected: 0 })
          } else if (msg.type === 'snapshot' && msg.snapshot) {
            ingestSnapshot(msg.snapshot)
            client.send({ type: 'ack', applied: 1, rejected: 0 })
          } else if (msg.type === 'ack') {
            // Peer's ack is the round's success criterion: it confirms our push AND proves the
            // peer finished building its own response. Timing the round out as "success" here
            // would advance the push cursor over undelivered segments (2026-09-17 live drill).
            const seq = Number(msg.appliedToSeq) || 0
            if (seq > (peerProgress.get(peer.deviceId) || 0)) peerProgress.set(peer.deviceId, seq)
            finish(null)
          }
        } catch (err) {
          finish(err)
        }
      })
      // No ack before the deadline = the round failed (push cursor stays put; next round re-pushes).
      // The budget covers a FIRST sync between two real devices: tens of thousands of oplog rows
      // ingested on both sides before either ack can be produced (2026-09-17 drill measured >30s).
      const done = setTimeout(() => finish(new Error('round timed out waiting for peer ack')), 120000)
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
      onPaired: (info) => em.emit('paired-inbound', info),
      getHandler: () => (msg, socket) => {
        try {
          if (msg.type === 'segments' && Array.isArray(msg.segments)) {
            for (const seg of msg.segments) ingestSegment(seg)
            const mine = buildSegments ? buildSegments() : []
            sendVia(socket, { type: 'segments', segments: mine })
            sendVia(socket, { type: 'ack', applied: msg.segments.length, rejected: 0 })
          } else if (msg.type === 'snapshot-request') {
            sendVia(socket, { type: 'snapshot', snapshot: buildSnapshot ? buildSnapshot() : null })
          }
        } catch (err) {
          try { require('electron-log').warn('[LanSync] server handler failed:', err && err.message) } catch { /* noop */ }
          em.emit('server-error', err)
        }
      },
      onPeer: (peer) => em.emit('peer-connected', peer),
      onUnauthorized: (info) => em.emit('peer-unauthorized', info),
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
      const done = (fn, v) => { try { client.close() } catch { /* noop */ } fn(v) }
      client.on('paired', (r) => { em.emit('paired-outbound', { peer: peer.deviceId }); done(resolve, { secret: r.secret, peer }) })
      client.on('rejected', () => done(reject, new Error('pairing code rejected by peer')))
      client.on('error', (err) => done(reject, err))
      setTimeout(() => done(reject, new Error('pairing timeout')), 6000)
    })
  }

  return {
    pairWith,
    on: em.on.bind(em),

    /** Start advertising, discovery, and the TCP server. */
    start() {
      stopped = false
      startServer()
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
      return {
        deviceId,
        listening: !!(server && server.port),
        port: server ? server.port : null,
        peers: Array.from(peers.values()),
        lastRoundAt,
        lastError,
        roundsRunning,
      }
    },

    async stop() {
      stopped = true
      for (const t of retryTimers.values()) clearTimeout(t)
      retryTimers.clear()
      try { discovery.stop() } catch { /* noop */ }
      if (server) await server.close()
      em.emit('stopped')
    },
  }
}

module.exports = { createLanSyncNode, BACKOFF_BASE_MS, BACKOFF_MAX_MS }
