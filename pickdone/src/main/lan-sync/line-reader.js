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

  #overLimit() {
    this.#account()
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
      this.#account()
      if (Buffer.byteLength(line, 'utf8') > this.limit) {
        this.#overLimit()
        return
      }
      if (line.length === 0) continue
      try {
        this.onMessage(JSON.parse(line))
      } catch (err) {
        this.#account()
        this.onError(new ProtocolError(`bad JSON line: ${err.message}`))
        this.socket.destroy()
        return
      }
    }
    if (this.bufferBytes > this.limit) { this.#overLimit(); return }
    // C4: aggregate-budget gate — when the process-wide buffered total crosses the cap, the
    // offending reader's socket is closed (its bytes are released on the 'close' handler).
    this.#account()
    if (lineBufferState.total > lineBufferState.cap) {
      this.onError(new ProtocolError(`aggregate line-buffer budget exceeded (${lineBufferState.total} > ${lineBufferState.cap} bytes)`))
      this.socket.destroy()
    }
  }

}
module.exports = { MAX_LINE_BYTES, PRE_AUTH_LINE_BYTES, LINE_BUFFER_BUDGET_BYTES, lineBufferState, __setLineBufferBudget, ProtocolError, cleanDeviceName, LineReader }
