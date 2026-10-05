// Line-framing primitives shared by the LAN-sync transport (extracted from transport.js to keep
// the wire-state module under the size ratchet; transport.js re-exports everything for compat).

// the hello/pair gate below — only peers holding the pairing secret can push large lines.
const MAX_LINE_BYTES = 32 * 1024 * 1024
// Pre-auth lines (before hello-ack / pair-accept) are bounded to 4KB: hello and pair-request are
// heartbeat-sized, so an unauthenticated peer has no reason to stream megabytes into our buffers.
// After auth the cap is raised to MAX_LINE_BYTES (a round carries a whole first-sync backlog).
const PRE_AUTH_LINE_BYTES = 4 * 1024

// C4 (2026-10-02): per-reader caps bound ONE socket, but 64 concurrent (maxSockets) authenticated
// sockets x the 32MB post-auth cap = a 2GB worst-case aggregate on the main process. This
// per-process budget (shared by every live LineReader) bounds the TOTAL buffered line bytes:
// when a feed pushes the aggregate past the cap, the OFFENDING socket (the one that just grew
// the total) is closed and its bytes released. A single legitimate round (32MB) still fits.
const LINE_BUFFER_BUDGET_BYTES = 64 * 1024 * 1024
// Test seam: the cap is mutable (__setLineBufferBudget) so unit tests can exercise the
// aggregate eviction without pushing gigabytes through a real socket. `total` is the live sum.
const lineBufferState = { cap: LINE_BUFFER_BUDGET_BYTES, total: 0 }
function __setLineBufferBudget (bytes) { lineBufferState.cap = bytes }

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
 *  The line cap is dynamic (setLimit): 4KB until the peer authenticates, 32MB after. Buffer size
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
    // D17 (2026-10-02): `buffer += chunk` was O(n²) across many chunks of one large line
    // (authenticated rounds push ~1MB segments-chunks in many small socket reads — each += rescan
    // copied the whole accumulated string). Chunks now accumulate in an array and are joined ONCE
    // when the arriving chunk contains a newline. `bufferBytes` stays the single byte authority
    // (chunk bytes in, consumed-line bytes out), so the aggregate-budget accounting below is
    // unchanged. `buffer` is the parsed-out remainder cache; it lags the fast path and is
    // reconciled at the next join.
    this._chunks = []
    // C4: join the per-process aggregate buffer budget (see LINE_BUFFER_BUDGET_BYTES).
    // `_accountedBytes` mirrors how much of this reader's buffer is currently counted in the
    // process-wide total, so every early-return path (over-limit destroy mid-feed included)
    // reconciles exactly and the socket-close release subtracts only what is outstanding.
    this._accountedBytes = 0
    socket.on('close', () => {
      lineBufferState.total -= this._accountedBytes
      this._accountedBytes = 0
    })
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => this.#feed(chunk))
  }

  /** Sync the process-wide total with this reader's current buffer size. */
  #account() {
    lineBufferState.total += this.bufferBytes - this._accountedBytes
    this._accountedBytes = this.bufferBytes
  }

  setLimit(limit) {
    this.limit = limit
    if (this.bufferBytes > limit) this.#overLimit()
  }

  /** D21: dispatch (handler) errors are app bugs, not wire faults — log honestly and keep the
   *  socket. electron-log when available (main process), console.error otherwise (pure tests). */
  #logDispatchError(err) {
    const line = `[LanSync] message handler threw (connection kept): ${err && err.stack ? err.stack : err}`
    // D22 (P3): this was the only lan-sync electron-log write site that did NOT pull in
    // ../log-isolation first — under TODO_DB_DIR/TODO_USER_DATA_DIR a handler throw used to
    // land in the REAL user log (%APPDATA%/pickdone/logs/main.log) instead of the isolation
    // dir. Same idempotent redirect every sibling module applies at its log sites.
    try { require('../log-isolation') } catch { /* standalone test context */ }
    try { require('electron-log').error(line) } catch { console.error(line) }
  }

  #overLimit() {
    this.#account()
    this.onError(new ProtocolError(`line exceeds ${this.limit} byte cap`))
    this.socket.destroy()
  }

  /** Post-feed limit gates: per-reader line cap, then the C4 aggregate budget. */
  #enforceLimits() {
    if (this.bufferBytes > this.limit) { this.#account(); this.#overLimit(); return }
    // C4: aggregate-budget gate — when the process-wide buffered total crosses the cap, the
    // offending reader's socket is closed (its bytes are released on the 'close' handler).
    this.#account()
    if (lineBufferState.total > lineBufferState.cap) {
      this.onError(new ProtocolError(`aggregate line-buffer budget exceeded (${lineBufferState.total} > ${lineBufferState.cap} bytes)`))
      this.socket.destroy()
    }
  }

  #feed(chunk) {
    this.bufferBytes += Buffer.byteLength(chunk, 'utf8')
    this._chunks.push(chunk)
    if (!chunk.includes('\n')) {
      // D17 fast path: no new line boundary — keep the chunk and defer the join (O(1) amortized
      // instead of re-copying the whole accumulated line per chunk).
      this.#enforceLimits()
      return
    }
    if (this.buffer) this._chunks.unshift(this.buffer) // leftover of previous feeds precedes the new chunks
    this.buffer = this._chunks.join('')
    this._chunks = []
    let idx
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, idx)
      this.buffer = this.buffer.slice(idx + 1)
      this.bufferBytes -= Buffer.byteLength(line, 'utf8') + 1 // + the consumed '\n'
      this.#account()
      if (Buffer.byteLength(line, 'utf8') > this.limit) {
        this.#overLimit()
        return
      }
      if (line.length === 0) continue
      // D21 (P2 2026-10-02): only JSON parsing belongs in the sever-on-failure path. The old
      // single try wrapped onMessage too, so a HANDLER bug threw → mislabeled 'bad JSON line'
      // ProtocolError → socket destroyed with the wireConnection no-op onError = a silent
      // disconnect indistinguishable from a peer protocol fault (and it killed every remaining
      // buffered line in the same feed). Now: torn JSON severs (protocol fault, as before); a
      // dispatch error is logged loudly and the connection survives — the peer is not at fault.
      let msg
      try {
        msg = JSON.parse(line)
      } catch (err) {
        this.#account()
        this.onError(new ProtocolError(`bad JSON line: ${err.message}`))
        this.socket.destroy()
        return
      }
      try {
        this.onMessage(msg)
      } catch (err) {
        this.#logDispatchError(err)
      }
    }
    this.#enforceLimits()
  }

}
module.exports = { MAX_LINE_BYTES, PRE_AUTH_LINE_BYTES, LINE_BUFFER_BUDGET_BYTES, lineBufferState, __setLineBufferBudget, ProtocolError, cleanDeviceName, LineReader }
