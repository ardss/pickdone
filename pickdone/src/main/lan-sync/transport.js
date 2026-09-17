'use strict'

/**
 * LAN sync transport: TCP JSON-line framing (node:net), one JSON object per
 * `\n`-delimited line, hard-capped at 512KB per line. Peers must authenticate
 * with a pairing-derived authCode (`hello` / `hello-ack`) before `segments`
 * or `snapshot` messages are accepted; anything else is rejected and the
 * socket destroyed.
 *
 * Message types:
 *   hello      {deviceId, protoVer, authCode}
 *   hello-ack  {ok, protoVer, error?}
 *   segments   {segments:[...]}   sync-core packed segment envelopes
 *   snapshot   {snapshot}
 *   ack        {applied, rejected}
 *   ping / pong {}
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

class ProtocolError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ProtocolError'
  }
}

/** Line-framing reader: buffers socket data, emits parsed JSON objects. */
class LineReader {
  constructor(socket, onMessage, onError) {
    this.buffer = ''
    this.socket = socket
    this.onMessage = onMessage
    this.onError = onError
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => this.#feed(chunk))
  }

  #feed(chunk) {
    this.buffer += chunk
    let idx
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      if (Buffer.byteLength(line, 'utf8') > MAX_LINE_BYTES) {
        this.onError(new ProtocolError(`line exceeds ${MAX_LINE_BYTES} byte cap`))
        this.socket.destroy()
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
    if (Buffer.byteLength(this.buffer, 'utf8') > MAX_LINE_BYTES) {
      this.onError(new ProtocolError(`line exceeds ${MAX_LINE_BYTES} byte cap`))
      this.socket.destroy()
    }
  }
}

function send(socket, msg) {
  if (!socket.destroyed && socket.writable) socket.write(JSON.stringify(msg) + '\n')
}

/** Shared server-side connection state machine (auth gate + dispatch). */
function wireConnection(socket, { deviceId, pairingSecret, getHandler, onPeer, onUnauthorized, verifyPairingCode, onPaired }) {
  const state = { peer: null, authorized: false }
  let pairAttempts = 0
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
          pairAttempts += 1
          const code = typeof msg.code === 'string' ? msg.code : ''
          if (pairAttempts > 5 || !verifyPairingCode || !verifyPairingCode(code)) {
            send(socket, { type: 'pair-ack', ok: false })
            socket.destroy()
            return
          }
          send(socket, { type: 'pair-accept', secret: pairingSecret })
          if (onPaired) onPaired({ deviceId: typeof msg.deviceId === 'string' ? msg.deviceId : '', host: socket.remoteAddress })
          socket.destroy()
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
  const { deviceId, pairingSecret, getHandler, onPeer, onUnauthorized, verifyPairingCode, onPaired, host } = opts
  const port = Number.isInteger(opts.port) ? opts.port : DEFAULT_PORT
  const em = new EventEmitter()
  const sockets = new Set()

  const server = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    wireConnection(socket, { deviceId, pairingSecret, getHandler, onPeer, onUnauthorized, verifyPairingCode, onPaired })
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
  const { deviceId, authCode, onUnauthorized, pairCode } = opts
  const protoVer = opts.protoVer || PROTO_VER
  const timeoutMs = opts.timeoutMs || 5000
  const em = new EventEmitter()
  em.ready = false

  const socket = net.createConnection({ host, port })
  socket.setTimeout(timeoutMs)

  socket.on('connect', () => {
    if (pairCode !== undefined) { send(socket, { type: 'pair-request', deviceId, code: String(pairCode) }); return }
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

  new LineReader(
    socket,
    (msg) => {
      if (!msg || typeof msg !== 'object') return
      if (!em.ready) {
        if (pairCode !== undefined) {
          if (msg.type === 'pair-accept' && typeof msg.secret === 'string' && msg.secret) {
            em.emit('paired', { secret: msg.secret })
          } else {
            em.emit('rejected', msg)
          }
          socket.destroy()
          return
        }
        if (msg.type === 'hello-ack' && msg.ok) {
          em.ready = true
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

module.exports = { createLanServer, connect, ProtocolError, PROTO_VER, DEFAULT_PORT, MAX_LINE_BYTES }
