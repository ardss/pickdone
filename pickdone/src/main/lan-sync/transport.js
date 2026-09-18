'use strict'

/**
 * LAN sync transport: TCP JSON-line framing (node:net), one JSON object per
 * `\n`-delimited line, hard-capped at 512KB per line. Peers must authenticate
 * with a pairing-derived authCode (`hello` / `hello-ack`) before `segments`
 * or `snapshot` messages are accepted; anything else is rejected and the
 * socket destroyed.
 *
 * Message types:
 *   hello        {deviceId, protoVer, authCode}
 *   hello-ack    {ok, protoVer, error?}
 *   segments     {segments:[...]}   sync-core packed segment envelopes
 *   snapshot     {snapshot}
 *   ack          {applied, rejected}
 *   ping / pong  {}
 *   pair-request {deviceId, code?}          pre-auth: with code = manual 6-digit mode,
 *                                           without code = two-way confirmed pairing
 *   pair-accept  {secret}                   pairing succeeded (either mode)
 *   pair-reject  {error}                    two-way mode: rejected / pair-throttled
 *   pair-ack     {ok}                       manual mode: ok=false on bad code
 *
 * Pure Node (node:net + node:crypto), no Electron imports. CommonJS.
 */

const { EventEmitter } = require('node:events')
const net = require('node:net')
const { verifyAuthCode } = require('./pairing')

const PROTO_VER = 1
const DEFAULT_PORT = 58471
// A round carries the sender's whole pending backlog as ONE 'segments' JSON line, so the cap must
// cover a first sync between real devices (tens of MB of rows), not just a heartbeat. Pre-auth
// abuse is bounded by the hello/pair gate below — only peers holding the pairing secret can push
// large lines, and a 16MB buffer spike from a LAN peer is acceptable for the beta.
const MAX_LINE_BYTES = 16 * 1024 * 1024
// Pre-auth lines (before hello-ack / pair-accept) are bounded to 4KB: hello and pair-request are
// heartbeat-sized, so an unauthenticated peer has no reason to stream megabytes into our buffers.
// After auth the cap is raised to MAX_LINE_BYTES (a round carries a whole first-sync backlog).
const PRE_AUTH_LINE_BYTES = 4 * 1024
// Two-way confirmed pairing: an unanswered pair-request is auto-rejected after this window
// (the pending decision dialog must not stay open forever). Injectable per server for tests.
const PAIR_CONFIRM_TIMEOUT_MS = 60 * 1000

class ProtocolError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProtocolError'
  }
}

/** Line-framing reader: buffers socket data, emits parsed JSON objects.
 *  The line cap is dynamic (setLimit): 4KB until the peer authenticates, 16MB after. Buffer size
 *  is tracked by byte ACCUMULATION (chunk bytes in, consumed line bytes out) instead of a full
 *  Buffer.byteLength rescan per chunk, so a slow-loris drip of small chunks stays O(n) total. */
class LineReader {
  constructor(socket, onMessage, onError, limit = PRE_AUTH_LINE_BYTES) {
    this.buffer = ''
    this.bufferBytes = 0
    this.limit = limit
    this.socket = socket
    this.onMessage = onMessage
    this.onError = onError
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => this.#feed(chunk))
  }

  setLimit(limit) {
    this.limit = limit
    if (this.bufferBytes > limit) this.#overLimit()
  }

  #overLimit() {
    this.onError(new ProtocolError(`line exceeds ${this.limit} byte cap`))
    this.socket.destroy()
  }

  #feed(chunk) {
    const chunkBytes = Buffer.byteLength(chunk, 'utf8')
    this.bufferBytes += chunkBytes
    this.buffer += chunk
    let idx
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      this.bufferBytes -= Buffer.byteLength(line, 'utf8') + 1 // + the consumed '\n'
      if (Buffer.byteLength(line, 'utf8') > this.limit) {
        this.#overLimit()
        return
      }
      if (line.length === 0) continue
      try {
        this.onMessage(JSON.parse(line))
      } catch (err) {
        this.onError(new ProtocolError(`bad JSON line: ${err.message}`))
        this.socket.destroy()
        return
      }
    }
    if (this.bufferBytes > this.limit) this.#overLimit()
  }
}

function send(socket, msg) {
  if (!socket.destroyed && socket.writable) socket.write(JSON.stringify(msg) + '\n')
}

/** Shared server-side connection state machine (auth gate + dispatch).
 *  pairGate(remoteAddress) -> boolean: server-level sliding-window rate limiter for pair-request
 *  attempts (see createLanServer); when absent, no IP-level limiting is applied. */
function wireConnection(socket, { deviceId, pairingSecret, getHandler, onPeer, onUnauthorized, verifyPairingCode, onPaired, pairGate, onPairRequest, onPairThrottled, pairConfirmTimeoutMs }) {
  const state = { peer: null, authorized: false }
  const finish = () => {
    if (state.peer) socket.emit('peer-closed', state.peer)
  }
  socket.on('close', finish)
  socket.on('error', finish)

  const reader = new LineReader(
    socket,
    (msg) => {
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'ping') { send(socket, { type: 'pong' }); return }
      if (!state.authorized) {
        // Manual pairing: the peer proves knowledge of our currently displayed 6-digit code and
        // receives the persisted pairing secret (same threat model as WPS push-button: the LAN +
        // the short-lived code are the gate). Rate-limited to blunt online guessing.
        if (msg.type === 'pair-request') {
          // Rate limit is SERVER-level per remoteAddress (sliding 10-minute window), not
          // per-connection: a per-connection counter resets on every reconnect, making online
          // code guessing trivially cheap. Applies to BOTH pairing modes (6-digit manual and
          // two-way confirmed) — a throttled attempt answers pair-reject/pair-ack and is
          // surfaced via onPairThrottled so the Device Center security ring can show it.
          const code = typeof msg.code === 'string' && msg.code ? msg.code : null
          if (pairGate && !pairGate(socket.remoteAddress)) {
            if (onPairThrottled) onPairThrottled({ ip: socket.remoteAddress, reason: 'pair-throttled' })
            if (code !== null) send(socket, { type: 'pair-ack', ok: false })
            else send(socket, { type: 'pair-reject', error: 'pair-throttled' })
            socket.destroy()
            return
          }
          if (code !== null) {
            // Manual pairing: the peer proves knowledge of our currently displayed 6-digit code
            // and receives the persisted pairing secret (same threat model as WPS push-button:
            // the LAN + the short-lived code are the gate).
            if (!verifyPairingCode || !verifyPairingCode(code)) {
              send(socket, { type: 'pair-ack', ok: false })
              socket.destroy()
              return
            }
            send(socket, { type: 'pair-accept', secret: pairingSecret })
            if (onPaired) onPaired({ deviceId: typeof msg.deviceId === 'string' ? msg.deviceId : '', host: socket.remoteAddress })
            socket.destroy()
            return
          }
          // Two-way confirmed pairing: an unpaired client asks {type:'pair-request', deviceName,
          // deviceId} BEFORE auth; a human decides via respond(accept) within the confirm window
          // (auto-reject + close on timeout, timer unref'd so it never holds the process open).
          // Accept hands out the persisted pairing secret, exactly like the manual code path —
          // the client derives its authCode from it and the next round authenticates normally.
          let settled = false
          const finish = (accept) => {
            if (settled) return
            settled = true
            clearTimeout(confirmTimer)
            if (accept) {
              send(socket, { type: 'pair-accept', secret: pairingSecret })
              if (onPaired) onPaired({
                deviceId: typeof msg.deviceId === 'string' ? msg.deviceId : '',
                deviceName: typeof msg.deviceName === 'string' ? msg.deviceName : '',
                host: socket.remoteAddress,
                confirmed: true,
              })
            } else {
              send(socket, { type: 'pair-reject', error: 'rejected' })
            }
            socket.destroy()
          }
          const confirmTimer = setTimeout(() => finish(false), pairConfirmTimeoutMs || PAIR_CONFIRM_TIMEOUT_MS)
          confirmTimer.unref?.()
          if (!onPairRequest) { finish(false); return }
          onPairRequest({
            deviceId: typeof msg.deviceId === 'string' ? msg.deviceId : '',
            deviceName: typeof msg.deviceName === 'string' ? msg.deviceName : '',
            host: socket.remoteAddress,
            respond: finish,
          })
          return
        }
        if (msg.type !== 'hello') {
          send(socket, { type: 'hello-ack', ok: false, protoVer: PROTO_VER, error: 'hello required' })
          socket.destroy()
          return
        }
        const claimed = typeof msg.deviceId === 'string' ? msg.deviceId : ''
        if (claimed === deviceId || !verifyAuthCode(pairingSecret, claimed, msg.authCode)) {
          if (onUnauthorized) onUnauthorized({ deviceId: claimed, host: socket.remoteAddress })
          send(socket, { type: 'hello-ack', ok: false, protoVer: PROTO_VER, error: 'auth failed' })
          socket.destroy()
          return
        }
        state.peer = { deviceId: claimed, host: socket.remoteAddress, protoVer: msg.protoVer || PROTO_VER }
        state.authorized = true
        // Authenticated peers may stream full sync rounds: raise the line cap from 4KB to 16MB.
        reader.setLimit(MAX_LINE_BYTES)
        send(socket, { type: 'hello-ack', ok: true, protoVer: PROTO_VER })
        if (onPeer) onPeer(state.peer, socket)
        return
      }
      const handler = getHandler ? getHandler(state.peer) : null
      if (handler) handler(msg, socket)
    },
    () => { /* framing/JSON errors: socket already destroyed in LineReader */ }
  )
  return { state, reader }
}

/**
 * Create a LAN sync TCP server.
 * @param {object} opts
 *   port (default 58471), host (bind address, e.g. '127.0.0.1' or '0.0.0.0'),
 *   deviceId, pairingSecret, getHandler(peer) -> handler(msg, socket),
 *   onPeer(peer, socket), onUnauthorized({deviceId, host})
 * @returns EventEmitter with .port (after 'listening'), .close()
 */
function createLanServer(opts) {
  const { deviceId, pairingSecret, getHandler, onPeer, onUnauthorized, verifyPairingCode, onPaired, host, onPairRequest, onPairThrottled, pairConfirmTimeoutMs } = opts
  const port = Number.isInteger(opts.port) ? opts.port : DEFAULT_PORT
  const em = new EventEmitter()
  const sockets = new Set()
  // Server-level pair-attempt rate limiter: Map<remoteAddress, timestamp[]> of pair-request
  // attempts inside the sliding window. >5 attempts per IP per 10 minutes = refuse + destroy.
  // Lives at server scope so reconnecting cannot reset the counter (the old per-connection
  // counter made online code guessing free: one attempt per TCP connect).
  const pairAttemptsByIp = new Map()
  const PAIR_WINDOW_MS = 10 * 60 * 1000
  const PAIR_MAX_ATTEMPTS = 5
  const pairGate = (ip) => {
    const now = Date.now()
    const key = String(ip || 'unknown')
    const recent = (pairAttemptsByIp.get(key) || []).filter((t) => now - t < PAIR_WINDOW_MS)
    if (recent.length >= PAIR_MAX_ATTEMPTS) {
      pairAttemptsByIp.set(key, recent)
      return false
    }
    recent.push(now)
    pairAttemptsByIp.set(key, recent)
    return true
  }

  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    wireConnection(socket, { deviceId, pairingSecret, getHandler, onPeer, onUnauthorized, verifyPairingCode, onPaired, pairGate, onPairRequest, onPairThrottled, pairConfirmTimeoutMs })
  })
  server.on('error', (err) => {
    // Fixed port taken (second instance on the same machine, or a stale process): degrade to an
    // ephemeral port instead of dying — discovery advertises the RESOLVED port, so peers still
    // find us. The fixed port is only a rendezvous convenience, never a correctness requirement.
    if (err && err.code === 'EADDRINUSE' && em.port === null && port !== 0) {
      em.port = -1 // guard: only retry once
      server.listen(0, host, () => {
        em.port = server.address().port
        em.emit('listening', em.port)
      })
      return
    }
    em.emit('error', err)
  })
  server.listen(port, host, () => {
    em.port = server.address().port
    em.emit('listening', em.port)
  })

  em.port = null
  em.close = () => new Promise((resolve) => {
    for (const s of sockets) s.destroy()
    server.close(() => resolve())
  })
  em.on = em.on.bind(em)
  em._server = server
  return em
}

/**
 * Connect to a LAN peer and authenticate.
 * @param {string} host
 * @param {number} port
 * @param {object} opts {deviceId, authCode, protoVer=1, timeoutMs=5000, onUnauthorized}
 * @returns EventEmitter with .send(msg), .close(), events:
 *   'ready' (hello-ack ok), 'rejected' (auth failed), 'message', 'error', 'close'
 */
function connect(host, port, opts) {
  const { deviceId, authCode, onUnauthorized, pairCode, pairOpen, deviceName } = opts
  const protoVer = opts.protoVer || PROTO_VER
  const timeoutMs = opts.timeoutMs || 5000
  const em = new EventEmitter()
  em.ready = false

  const socket = net.createConnection({ host, port })
  socket.setTimeout(timeoutMs)

  socket.on('connect', () => {
    if (pairCode !== undefined) { send(socket, { type: 'pair-request', deviceId, code: String(pairCode) }); return }
    // Two-way confirmed pairing (no code): ask the peer; the human there accepts or rejects.
    if (pairOpen) { send(socket, { type: 'pair-request', deviceId, deviceName: deviceName || '' }); return }
    send(socket, { type: 'hello', deviceId, protoVer, authCode })
  })
  socket.on('timeout', () => {
    em.emit('error', new Error(`connect timeout to ${host}:${port}`))
    socket.destroy()
  })
  socket.on('error', (err) => em.emit('error', err))
  socket.on('close', () => {
    em.ready = false
    em.emit('close')
  })

  const reader = new LineReader(
    socket,
    (msg) => {
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'ping') { send(socket, { type: 'pong' }); return }
      if (!em.ready) {
        if (pairCode !== undefined) {
          if (msg.type === 'pair-accept' && typeof msg.secret === 'string' && msg.secret) {
            reader.setLimit(MAX_LINE_BYTES)
            em.emit('paired', { secret: msg.secret })
          } else {
            em.emit('rejected', msg)
          }
          socket.destroy()
          return
        }
        if (pairOpen) {
          // Two-way confirm outcome: accept carries the peer's pairing secret (the client
          // adopts it and derives its authCode from it, same as the manual code path);
          // reject/timeout surfaces as 'rejected' with the peer's reason.
          if (msg.type === 'pair-accept' && typeof msg.secret === 'string' && msg.secret) {
            reader.setLimit(MAX_LINE_BYTES)
            em.emit('paired', { secret: msg.secret })
          } else {
            em.emit('rejected', msg)
          }
          socket.destroy()
          return
        }
        if (msg.type === 'hello-ack' && msg.ok) {
          em.ready = true
          // Authenticated: raise the pre-auth 4KB line cap to the full 16MB round cap.
          reader.setLimit(MAX_LINE_BYTES)
          em.emit('ready', msg)
        } else {
          if (msg.type === 'hello-ack' && onUnauthorized) {
            onUnauthorized({ deviceId, host, error: msg.error })
          }
          em.emit('rejected', msg)
          socket.destroy()
        }
        return
      }
      if (msg.type === 'ping') { send(socket, { type: 'pong' }); return }
      em.emit('message', msg)
    },
    () => { /* socket destroyed by LineReader */ }
  )

  em.send = (msg) => send(socket, msg)
  em.close = () => new Promise((resolve) => { socket.end(); socket.destroy(); resolve() })
  em.on = em.on.bind(em)
  em._socket = socket
  return em
}

module.exports = { createLanServer, connect, ProtocolError, PROTO_VER, DEFAULT_PORT, MAX_LINE_BYTES, PRE_AUTH_LINE_BYTES, PAIR_CONFIRM_TIMEOUT_MS }
