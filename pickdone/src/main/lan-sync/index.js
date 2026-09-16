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

  /** Run one exchange with a peer: push my segments, pull theirs, ack. */
  function syncWithPeer(peer) {
    if (stopped) return Promise.resolve()
    roundsRunning += 1
    return new Promise((resolve) => {
      let settled = false
      const client = connect(peer.host, peer.port, {
        deviceId,
        authCode,
        protoVer: PROTO_VER,
        timeoutMs: 5000,
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
        } else {
          lastRoundAt = Date.now()
          lastError = null
          resetBackoff(peer.deviceId)
          em.emit('round-done', { peer: peer.deviceId })
        }
        resolve()
      }
      client.on('error', (err) => finish(err))
      client.on('rejected', () => finish(new Error('auth rejected by peer')))
      client.on('ready', () => {
        const mine = buildSegments ? buildSegments() : []
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
            // Peer confirmed our push; nothing further needed this round.
          }
        } catch (err) {
          finish(err)
        }
      })
      // Give the peer a moment to send everything, then close the round.
      const done = setTimeout(() => finish(null), 1500)
      done.unref?.()
    })
  }

  function startServer() {
    server = createLanServer({
      port,
      host,
      deviceId,
      pairingSecret,
      getHandler: () => (msg, socket) => {
        if (msg.type === 'segments' && Array.isArray(msg.segments)) {
          for (const seg of msg.segments) ingestSegment(seg)
          const mine = buildSegments ? buildSegments() : []
          sendVia(socket, { type: 'segments', segments: mine })
          sendVia(socket, { type: 'ack', applied: msg.segments.length, rejected: 0 })
        } else if (msg.type === 'snapshot-request') {
          sendVia(socket, { type: 'snapshot', snapshot: buildSnapshot ? buildSnapshot() : null })
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

  return {
    on: em.on.bind(em),

    /** Start advertising, discovery, and the TCP server. */
    start() {
      stopped = false
      startServer()
    },

    /** Resolves with the bound port once the TCP server is listening. */
    whenListening: () => whenListening,

    /** Inject a peer directly (tests / manual entry). */
    addPeer(peer) {
      rememberPeer(peer)
    },

    /** Run one sync round against every known peer (sequentially). */
    async startSyncRound() {
      const targets = Array.from(peers.values())
      for (const peer of targets) {
        if (!stopped) await syncWithPeer(peer)
      }
      return { peers: targets.length, lastRoundAt }
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
