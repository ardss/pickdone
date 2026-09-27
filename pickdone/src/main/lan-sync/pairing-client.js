'use strict'

/**
 * Client-side pairing flows, extracted from index.js (line ratchet): pure moves of
 * pairWith/requestPair. Both are pure orchestration over transport.connect — they read the
 * node's peer table and re-emit the pairing events, nothing else.
 *
 * Pure Node, no Electron imports. CommonJS.
 */

const { connect, DEFAULT_PORT } = require('./transport')
const { PROTO_VER } = require('./discovery')

// Client-side deadline for an outbound two-way pair request: the peer's own confirm window is
// 60s, so we outlast it slightly before declaring a timeout ourselves.
const PAIR_CONFIRM_TIMEOUT_CLIENT_MS = 63 * 1000

/**
 * @param {object} deps
 *   peers (Map deviceId -> {deviceId, name, host, port}),
 *   deviceId, name, em (node EventEmitter)
 */
function createPairingClient({ peers, deviceId, name, em }) {
  /** Manual pairing with a known peer: exchange our 6-digit code for the peer's persisted pairing secret.
   *  Resolves {secret, peer}; rejects on reject/error/timeout. */
  function pairWith(peerDeviceId, code) {
    // M-2: exact match only — no random-peer fallback; structured PEER_NOT_FOUND failure.
    if (!peers.has(peerDeviceId)) { const e = new Error('pairWith: peer not discovered: ' + peerDeviceId); e.code = 'PEER_NOT_FOUND'; e.deviceId = peerDeviceId; return Promise.reject(e) }
    const peer = peers.get(peerDeviceId)
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

  return { pairWith, requestPair }
}

module.exports = { createPairingClient, PAIR_CONFIRM_TIMEOUT_CLIENT_MS }
