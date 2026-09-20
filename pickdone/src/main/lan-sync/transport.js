'use strict'

/**
 * LAN sync transport: TCP JSON-line framing (node:net), one JSON object per
 * `\n`-delimited line, hard-capped at 512KB per line. Peers must authenticate
 * with a pairing-derived authCode (`hello` / `hello-ack`) before `segments-chunk`
 * or `snapshot-*` messages are accepted; anything else is rejected and the
 * socket destroyed.
 *
 * Message types:
 *   hello          {deviceId, protoVer, authCode, enc:1, salt}   salt = 16B b64 session-key salt
 *   hello-ack      {ok, protoVer, enc?, error?}                  enc:1 echoes encryption support
 *   segments-chunk {segments:[...], final}   sync-core packed segment envelopes, bounded chunk of
 *                                            a round's push (final:true on the last chunk) -- ENCRYPTED
 *   snapshot       {snapshot}                                          -- ENCRYPTED (removed: unused)
 *   ack            {applied, rejected}                                 -- ENCRYPTED
 *   ping / pong    {}
 *   pair-request   {deviceId, code?, nonce, pub}  pre-auth: with code = manual 6-digit mode,
 *                                             without code = two-way confirmed pairing;
 *                                             pub = client ephemeral ECDH P-256 key (b64)
 *   pair-challenge {challenge, pub}            server's 16B random + server ephemeral ECDH key;
 *                                             the pair-accept is encrypted under the v2
 *                                             ECDH-based handshake key (see cipher.js)
 *   pair-accept    {secret}                   pairing succeeded (either mode); ENCRYPTED under
 *                                             the ephemeral pair handshake key (see cipher.js)
 *   pair-reject    {error}                    two-way mode: rejected / pair-throttled (plaintext)
 *   pair-ack       {ok}                       manual mode: ok=false on bad code (plaintext)
 *
 * Encryption (cipher.js): after a successful hello/hello-ack BOTH sides derive the session key
 * HKDF-SHA256(pairingSecret, salt) and every further message in EITHER direction is framed as
 * `{"enc":1,"iv","tag","data"}` (AES-256-GCM). Encrypted frames before a session key exists, or
 * plaintext data messages after auth, sever the connection. Both sides ship together in this
 * repo, so a peer that does not advertise `enc:1` is REFUSED (hello-ack ok:false
 * 'encryption required') rather than falling back to plaintext — PROTO_VER bumped 1 -> 2.
 *
 * Pure Node (node:net + node:crypto), no Electron imports. CommonJS.
 */

const { EventEmitter } = require('node:events')
const net = require('node:net')
const { verifyAuthCode } = require('./pairing')
const cipher = require('./cipher')

const PROTO_VER = 2
const DEFAULT_PORT = 58471
// A round's push travels as bounded `segments-chunk` lines (~1MB payload each, see
// segments-chunk.js) since 2026-09-18: one whole-backlog line used to exceed this cap once
// AES-GCM base64 framing inflated it, destroying first-sync rounds permanently. The cap stays
// as abuse/oversize protection, not as the transfer mechanism. Pre-auth abuse is bounded by
// the hello/pair gate below — only peers holding the pairing secret can push large lines.
const MAX_LINE_BYTES = 32 * 1024 * 1024
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

/** Sanitize a wire-supplied deviceName (round-3 review): strip control characters (terminal
 *  escape / log-forging injection) and clamp to 40 chars — mirrors the bootstrap's syncSetName
 *  rules. Anything non-string collapses to ''. */
function cleanDeviceName(value) {
  if (typeof value !== 'string') return ''
  // eslint-disable-next-line no-control-regex -- control characters are exactly what we strip
  return value.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 40)
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

/** Serialize + (optionally) encrypt one message onto the socket. Returns TRUE when the frame
 *  was handed to the socket, FALSE when the socket is dead/not writable (or the kernel write
 *  buffer rejected it). P2 2026-09-20: the send used to drop frames silently — callers (e.g. the
 *  attachment server streaming att-chunks) had no way to notice a dead peer and kept "serving"
 *  into the void until the receiver's 120s round deadline. */
function send(socket, msg) {
  if (!socket || socket.destroyed || !socket.writable) return false
  // Post-auth (and post-pair-challenge where applicable) traffic is encrypted under the
  // connection's key; socket._lanKey is null until a session/handshake key is established.
  // Each encrypted frame carries a per-DIRECTION sequence number (starts at 0 on every
  // connection; the peer enforces strictly-increasing — see unwrapInbound) so a captured
  // frame cannot be replayed into the same connection.
  const key = socket._lanKey
  let line
  if (key) {
    const seq = socket._lanSendSeq || 0
    socket._lanSendSeq = seq + 1
    line = cipher.encryptFrame(key, msg, seq)
  } else {
    line = JSON.stringify(msg)
  }
  try {
    return socket.write(line + '\n') !== false
  } catch {
    return false
  }
}

/** Send one message as an encrypted frame under an explicit key (pair-accept handshake). */
function sendEnc(socket, key, msg) {
  if (!socket.destroyed && socket.writable) socket.write(cipher.encryptFrame(key, msg) + '\n')
}

/** Decrypt an inbound encrypted frame under the connection's key (session key when
 *  established, else the pair handshake key), enforcing: encrypted frames require an
 *  established key (else sever), post-auth plaintext data messages are refused (else
 *  sever), and session frames carry a STRICTLY-INCREASING per-direction seq (replay or
 *  seq regression severs — conn.recvSeq starts at -1 per connection). ping/pong stays
 *  plaintext in both phases. Returns the decrypted message, or null when the connection
 *  was/should be severed. */
function unwrapInbound(socket, conn, raw) {
  if (!raw || typeof raw !== 'object') return raw
  if (cipher.isEncFrame(raw)) {
    const key = conn.sessionKey || conn.hsKey || null
    if (!key) { socket.destroy(); return null } // encrypted before any key was established
    try {
      const msg = cipher.decryptFrame(key, raw)
      if (conn.sessionKey) {
        // Replay protection: session frames must be strictly increasing per direction. A
        // replayed captured frame (or one with a regressed/missing seq) is rejected by the
        // GCM-bound seq field — an attacker cannot re-stamp a frame without breaking the tag.
        const seq = Number(raw.seq)
        if (!Number.isInteger(seq) || seq <= conn.recvSeq) { socket.destroy(); return null }
        conn.recvSeq = seq
      }
      return msg
    } catch {
      socket.destroy() // GCM tag failure = tampering or key mismatch
      return null
    }
  }
  if (conn.authorized && raw.type !== 'ping' && raw.type !== 'pong') {
    socket.destroy() // post-auth traffic must be encrypted
    return null
  }
  return raw
}

/** Shared server-side connection state machine (auth gate + dispatch).
 *  pairGate(remoteAddress) -> boolean: server-level sliding-window rate limiter, applied to
 *  BOTH pair-request attempts and FAILED hello auth attempts (see createLanServer); when
 *  absent, no IP-level limiting is applied.
 *  seenPairNonces: server-level Set of client pair-request nonces — a nonce is single-use
 *  per server, so a captured pair-request cannot be replayed into a fresh accept. */
function wireConnection(socket, { deviceId, pairingSecret, getHandler, onPeer, onUnauthorized, verifyPairingCode, onPaired, pairGate, onPairRequest, onPairThrottled, pairConfirmTimeoutMs, seenPairNonces }) {
  const state = { peer: null, authorized: false, sessionKey: null, pairHs: null, recvSeq: -1 }
  socket._lanSend = (msg) => send(socket, msg) // encrypted send for server-side handlers (index.js sendVia)
  const finish = () => {
    // Best-effort zeroization of the derived session key on socket close (GC copies inside
    // node:crypto internals are unreachable — documented in cipher.js).
    cipher.zeroize(state.sessionKey)
    state.sessionKey = null
    if (state.peer) socket.emit('peer-closed', state.peer)
  }
  socket.on('close', finish)
  socket.on('error', finish)

  const reader = new LineReader(
    socket,
    (raw) => {
      const msg = unwrapInbound(socket, state, raw)
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
          // Client half of the pair handshake key material (cipher.js): random 16B from the
          // requester, plus the requester's EPHEMERAL ECDH public key (v2, 2026-09-18) — without
          // it the accept key would be derivable by a passive sniffer from the transcript alone.
          const pairNonce = cipher.isValidToken(msg.nonce, cipher.SALT_BYTES) ? msg.nonce : ''
          const peerPub = typeof msg.pub === 'string' && msg.pub ? msg.pub : null
          // Single-use nonce: a captured pair-request transcript must not be replayable into a
          // fresh pair-accept on a later connection (server-level, survives reconnects).
          if (pairNonce && seenPairNonces) {
            if (seenPairNonces.has(pairNonce)) {
              if (code !== null) send(socket, { type: 'pair-ack', ok: false })
              else send(socket, { type: 'pair-reject', error: 'nonce reuse' })
              socket.destroy()
              return
            }
            // Bounded memory: a flood of pair-requests cannot grow the set without limit.
            if (seenPairNonces.size >= 4096) seenPairNonces.clear()
            seenPairNonces.add(pairNonce)
          }
          if (pairGate && !pairGate(socket.remoteAddress)) {
            if (onPairThrottled) onPairThrottled({ ip: socket.remoteAddress, reason: 'pair-throttled' })
            if (code !== null) send(socket, { type: 'pair-ack', ok: false })
            else send(socket, { type: 'pair-reject', error: 'pair-throttled' })
            socket.destroy()
            return
          }
          if (!peerPub) {
            // v2 handshake (2026-09-18): both sides ship together — a pair-request without an
            // ephemeral ECDH key cannot produce a sniffer-safe accept, so it is refused outright
            // instead of falling back to the transcript-derivable v1 scheme.
            if (code !== null) send(socket, { type: 'pair-ack', ok: false })
            else send(socket, { type: 'pair-reject', error: 'ephemeral key required' })
            socket.destroy()
            return
          }
          if (code !== null) {
            // Manual pairing: the peer proves knowledge of our currently displayed 6-digit code
            // and receives the persisted pairing secret (same threat model as WPS push-button:
            // the LAN + the short-lived code are the gate). The secret reply is ENCRYPTED under
            // the ephemeral handshake key HKDF(code | ECDH(clientPriv,serverPub) | nonce |
            // challenge) — see cipher.js for the honest threat scope (passive-sniffer safe;
            // active MITM remains possible and is documented there).
            if (!verifyPairingCode || !verifyPairingCode(code)) {
              send(socket, { type: 'pair-ack', ok: false })
              socket.destroy()
              return
            }
            const serverEph = cipher.createPairEphemeral()
            const challenge = cipher.randomToken()
            send(socket, { type: 'pair-challenge', challenge, pub: serverEph.pub })
            let hsKey
            try {
              hsKey = cipher.deriveHandshakeKey({ code, ecdh: serverEph.ecdh, peerPub, nonce: pairNonce, challenge })
            } catch {
              // Not a valid curve point: not a handshake peer (also blunts invalid-key probing).
              send(socket, { type: 'pair-ack', ok: false })
              socket.destroy()
              return
            }
            sendEnc(socket, hsKey, { type: 'pair-accept', secret: pairingSecret })
            if (onPaired) onPaired({ deviceId: typeof msg.deviceId === 'string' ? msg.deviceId : '', host: socket.remoteAddress })
            socket.destroy()
            return
          }
          // Two-way confirmed pairing: an unpaired client asks {type:'pair-request', deviceName,
          // deviceId, pub} BEFORE auth; a human decides via respond(accept) within the confirm
          // window (auto-reject + close on timeout, timer unref'd so it never holds the process
          // open). Accept hands out the persisted pairing secret, encrypted under the ephemeral
          // ECDH handshake key HKDF(ECDH | nonce | challenge): the challenge AND our ephemeral
          // pub go out NOW (pre-decision) so both sides can derive the key before the human
          // answers — the secret is never plaintext on the wire (see cipher.js for the honest
          // threat scope).
          const serverEph = cipher.createPairEphemeral()
          const challenge = cipher.randomToken()
          state.pairHs = { ecdh: serverEph.ecdh, peerPub, nonce: pairNonce, challenge }
          send(socket, { type: 'pair-challenge', challenge, pub: serverEph.pub })
          let settled = false
          const finish = (accept) => {
            if (settled) return
            settled = true
            clearTimeout(confirmTimer)
            if (accept) {
              const hs = state.pairHs || { ecdh: serverEph.ecdh, peerPub, nonce: pairNonce, challenge }
              let hsKey
              try {
                hsKey = cipher.deriveHandshakeKey(hs)
              } catch {
                socket.destroy()
                return
              }
              sendEnc(socket, hsKey, { type: 'pair-accept', secret: pairingSecret })
              if (onPaired) onPaired({
                deviceId: typeof msg.deviceId === 'string' ? msg.deviceId : '',
                deviceName: cleanDeviceName(msg.deviceName),
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
            deviceName: cleanDeviceName(msg.deviceName),
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
        // Encryption capability gate (PROTO_VER 2): both sides ship together in this repo, so
        // a peer that does not advertise enc support is refused instead of silently falling
        // back to plaintext sync data. Checked BEFORE auth so old peers get a clear reason.
        if (msg.enc !== 1 || !cipher.isValidToken(msg.salt, cipher.SALT_BYTES)) {
          send(socket, { type: 'hello-ack', ok: false, protoVer: PROTO_VER, error: 'encryption required' })
          socket.destroy()
          return
        }
        const claimed = typeof msg.deviceId === 'string' ? msg.deviceId : ''
        // Self-connection guard: a hello claiming OUR OWN deviceId means the sender is this very
        // node dialing itself (stale manual peer / own-address entry — 2026-09-18 real-machine
        // incident: both machines endlessly rejected "themselves" with a generic auth error).
        // Answer with a DISTINCT reason so the dialing side can drop the bogus peer entry.
        if (claimed === deviceId) {
          if (onUnauthorized) onUnauthorized({ deviceId: claimed, host: socket.remoteAddress, self: true })
          send(socket, { type: 'hello-ack', ok: false, protoVer: PROTO_VER, error: 'self-connection' })
          socket.destroy()
          return
        }
        if (!verifyAuthCode(pairingSecret, claimed, msg.authCode)) {
          if (onUnauthorized) onUnauthorized({ deviceId: claimed, host: socket.remoteAddress })
          // Online-guessing throttle: FAILED hello attempts feed the same server-level
          // per-IP sliding window as pair-requests (count only failures — a successful auth
          // never touches the counter, matching the pairGate "count every allowed attempt"
          // semantics from the failure side). 5 failures per IP per 10 minutes, then refuse.
          if (pairGate && !pairGate(socket.remoteAddress)) {
            if (onPairThrottled) onPairThrottled({ ip: socket.remoteAddress, reason: 'auth-throttled' })
            send(socket, { type: 'hello-ack', ok: false, protoVer: PROTO_VER, error: 'auth throttled' })
            socket.destroy()
            return
          }
          send(socket, { type: 'hello-ack', ok: false, protoVer: PROTO_VER, error: 'auth failed' })
          socket.destroy()
          return
        }
        state.peer = { deviceId: claimed, host: socket.remoteAddress, protoVer: msg.protoVer || PROTO_VER }
        state.authorized = true
        // Session key: HKDF-SHA256(pairingSecret, client salt from this hello). Every further
        // message in BOTH directions is now an encrypted frame (cipher.js).
        state.sessionKey = cipher.deriveSessionKey(pairingSecret, msg.salt)
        // hello-ack itself stays PLAINTEXT (handshake boundary) — the send key is attached
        // only after it, so the ack goes out unencrypted and both sides key up from it.
        send(socket, { type: 'hello-ack', ok: true, protoVer: PROTO_VER, enc: 1 })
        socket._lanKey = state.sessionKey
        // Authenticated peers may stream full sync rounds: raise the line cap from 4KB to 32MB.
        reader.setLimit(MAX_LINE_BYTES)
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
  // Server-level set of client pair-request nonces (single-use per server): a captured
  // pair-request replayed on a fresh connection cannot mint a fresh pair-accept.
  const seenPairNonces = new Set()
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
    wireConnection(socket, { deviceId, pairingSecret, getHandler, onPeer, onUnauthorized, verifyPairingCode, onPaired, pairGate, onPairRequest, onPairThrottled, pairConfirmTimeoutMs, seenPairNonces })
  })
  server.on('error', (err) => {
    // Fixed port taken (round-3 review): FAIL LOUDLY instead of silently degrading to an
    // ephemeral port. An ephemeral bind is undiscoverable via the fixed-port rendezvous (manual
    // peers, firewall rules, existing saved peers all target the fixed port), so a second app
    // instance or a foreign squatter must surface as a visible sync error, not a silent
    // half-working node. Port 0 (explicitly ephemeral config) can never hit EADDRINUSE.
    if (err && err.code === 'EADDRINUSE' && em.port === null && port !== 0) {
      try { require('electron-log').error(`[LanSync] fixed sync port ${port} is in use — sync is NOT discoverable (EADDRINUSE)`) } catch { /* electron-log unavailable in pure-node contexts */ }
    }
    em.emit('error', err)
  })
  // Listen on next tick: on Windows a same-tick EADDRINUSE fires the 'error' event
  // SYNCHRONOUSLY, before the caller can attach an 'error' listener — the unhandled 'error'
  // event would crash the process instead of surfacing through the documented API.
  process.nextTick(() => server.listen(port, host, () => {
    em.port = server.address().port
    em.emit('listening', em.port)
  }))

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
 * @param {object} opts {deviceId, authCode, pairingSecret, protoVer=2, timeoutMs=5000,
 *   onUnauthorized, pairCode?, pairOpen?, deviceName?}
 *   pairingSecret is REQUIRED for authenticated rounds: the session key is derived from it
 *   (HKDF over the salt this client generates and sends in `hello`).
 * @returns EventEmitter with .send(msg), .close(), events:
 *   'ready' (hello-ack ok), 'rejected' (auth failed / peer lacks encryption), 'message',
 *   'paired' {secret} (pair flows; secret decrypted under the pair handshake key),
 *   'error', 'close'
 */
function connect(host, port, opts) {
  const { deviceId, authCode, pairingSecret, onUnauthorized, pairCode, pairOpen, deviceName } = opts
  const protoVer = opts.protoVer || PROTO_VER
  const timeoutMs = opts.timeoutMs || 5000
  const em = new EventEmitter()
  em.ready = false
  // Connection crypto state: session key (post-auth, HKDF over pairingSecret + our salt), the
  // ephemeral pair handshake key (pre-pairing pair-accept decryption only), and the per-direction
  // replay-protection receive counter (strictly-increasing seq; -1 = nothing received yet).
  const conn = { sessionKey: null, hsKey: null, authorized: false, recvSeq: -1 }
  const salt = cipher.randomToken() // client-chosen per-connection session-key salt (in hello)
  const pairNonce = cipher.randomToken() // client half of the pair-accept handshake key
  const pairEph = cipher.createPairEphemeral() // client ephemeral ECDH half (v2 handshake)

  const socket = net.createConnection({ host, port })
  socket.setTimeout(timeoutMs)
  socket._lanSend = (msg) => send(socket, msg)

  socket.on('connect', () => {
    if (pairCode !== undefined) { send(socket, { type: 'pair-request', deviceId, code: String(pairCode), nonce: pairNonce, pub: pairEph.pub }); return }
    // Two-way confirmed pairing (no code): ask the peer; the human there accepts or rejects.
    if (pairOpen) { send(socket, { type: 'pair-request', deviceId, deviceName: deviceName || '', nonce: pairNonce, pub: pairEph.pub }); return }
    send(socket, { type: 'hello', deviceId, protoVer, authCode, enc: cipher.ENC_VER, salt })
  })
  socket.on('timeout', () => {
    const err = new Error(`connect timeout to ${host}:${port}`)
    // A caller without an 'error' listener must not turn the deadline into an uncaught
    // exception — the close signal is the contract every caller already handles.
    if (em.listenerCount('error') > 0) em.emit('error', err)
    else em.emit('close')
    socket.destroy()
  })
  socket.on('error', (err) => em.emit('error', err))
  socket.on('close', () => {
    // Best-effort zeroization of derived keys (see cipher.js for the GC-copy caveat).
    cipher.zeroize(conn.sessionKey)
    cipher.zeroize(conn.hsKey)
    conn.sessionKey = null
    conn.hsKey = null
    em.ready = false
    em.emit('close')
  })

  const reader = new LineReader(
    socket,
    (raw) => {
      const msg = unwrapInbound(socket, conn, raw)
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'ping') { send(socket, { type: 'pong' }); return }
      if (msg.type === 'pair-challenge') {
        // Server half of the pair-accept handshake key: the server's EPHEMERAL ECDH pub (v2)
        // plus its challenge. The encrypted pair-accept follows on the same connection.
        try {
          conn.hsKey = cipher.deriveHandshakeKey({
            code: pairCode !== undefined ? String(pairCode) : '',
            ecdh: pairEph.ecdh,
            peerPub: typeof msg.pub === 'string' ? msg.pub : '',
            nonce: pairNonce,
            challenge: cipher.isValidToken(msg.challenge, cipher.SALT_BYTES) ? msg.challenge : '',
          })
        } catch {
          // Peer sent no/invalid ephemeral key: not a v2 handshake peer — refuse.
          em.emit('rejected', { type: 'pair-challenge', error: 'peer ephemeral key missing or invalid' })
          socket.destroy()
          return
        }
        return
      }
      if (!em.ready) {
        if (pairCode !== undefined || pairOpen) {
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
          // Refuse plaintext peers (option a, both sides ship together): the ack MUST echo
          // enc support, else syncing over an unencrypted link would be silent.
          if (msg.enc !== 1) {
            em.emit('rejected', { type: 'hello-ack', ok: false, error: 'peer does not support encryption' })
            if (onUnauthorized) onUnauthorized({ deviceId, host, error: 'peer does not support encryption' })
            socket.destroy()
            return
          }
          if (typeof pairingSecret !== 'string' || !pairingSecret) {
            em.emit('error', new Error('connect: pairingSecret is required for authenticated rounds'))
            socket.destroy()
            return
          }
          em.ready = true
          conn.authorized = true
          conn.sessionKey = cipher.deriveSessionKey(pairingSecret, salt)
          socket._lanKey = conn.sessionKey
          // Authenticated: raise the pre-auth 4KB line cap to the full 32MB round cap.
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

module.exports = { createLanServer, connect, send, ProtocolError, PROTO_VER, DEFAULT_PORT, MAX_LINE_BYTES, PRE_AUTH_LINE_BYTES, PAIR_CONFIRM_TIMEOUT_MS, cleanDeviceName }
