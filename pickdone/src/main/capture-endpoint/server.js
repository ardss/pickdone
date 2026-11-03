/**
 * capture-endpoint/server — the local HTTP capture door (S4 browser-extension track, P0).
 *
 * Binds 127.0.0.1 ONLY (never a LAN interface). Pure Node http, dependency-injected:
 *   - getSecret()  → the current access key (main wiring reads the machine-local
 *                    '_captureEndpointSecret' meta row per request, so a regenerate from the
 *                    settings tab invalidates the old key on the very next request);
 *   - isEnabled()  → the kill switch (main wiring reads '_captureEndpointEnabled'; DEFAULT
 *                    OFF = every request 503s and nothing is exposed);
 *   - getMeta()    → dedupe reads;
 *   - ingest()     → the capture handler (defaults to handlers.ingestCapture over a bus).
 *
 * Port: try `port` (default 7789); on EADDRINUSE step +1 up to `attempts` times. The bound
 * port is exposed as `actualPort` (set once listening) and via the `ready` promise.
 *
 * Request contract:
 *   POST /capture, header X-PickDone-Key, JSON body {content, dedupeFingerprint?, sourceUrl?,
 *   sourceTitle?}. Auth precedes EVERYTHING db-side: a missing/wrong key is 401 and no bus
 *   commit happens (red→green suite asserts the fake db sees zero ops).
 */

const http = require('http')
const { ingestCapture } = require('./handlers')
const { keysMatch, KEY_HEADER } = require('./secret')
const { CAPTURE_HOST, CAPTURE_PORT, CAPTURE_PATH } = require('./contract.cjs')

const MAX_BODY = 64 * 1024

// CORS: the browser extension's origin is a random chrome-extension:// id, so the answer is
// `*`. The X-PickDone-Key handshake (fail-closed, per request) is the security boundary —
// CORS only lets the browser complete the fetch the key already gates.
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, ' + KEY_HEADER
}

function startCaptureServer (opts = {}) {
  const getSecret = opts.getSecret || (() => null)
  const isEnabled = opts.isEnabled || (() => false)
  const getMeta = opts.getMeta || (() => null)
  const bus = opts.bus || null
  const customIngest = opts.ingest || null
  const basePort = Number.isFinite(opts.port) ? opts.port : CAPTURE_PORT
  const attempts = Number.isFinite(opts.attempts) && opts.attempts > 0 ? opts.attempts : 10

  function runIngest (payload) {
    if (customIngest) return customIngest(payload)
    if (!bus) throw new Error('[capture-endpoint] no bus wired')
    return ingestCapture({ bus, getMeta, payload })
  }

  function readBody (req) {
    return new Promise((resolve, reject) => {
      const chunks = []
      let size = 0
      req.on('data', c => {
        size += c.length
        if (size > MAX_BODY) {
          const e = new Error('body too large')
          e.statusCode = 413
          req.destroy()
          reject(e)
          return
        }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  function respond (res, status, json) {
    if (res.writableEnded) return
    // 204 (OPTIONS preflight) must not carry a body
    const headers = Object.assign({}, CORS_HEADERS)
    if (status === 204) {
      res.writeHead(204, headers)
      res.end()
      return
    }
    const body = JSON.stringify(json)
    headers['content-type'] = 'application/json'
    headers['content-length'] = Buffer.byteLength(body)
    res.writeHead(status, headers)
    res.end(body)
  }

  const server = http.createServer((req, res) => {
    Promise.resolve().then(async () => {
      // preflight first: browsers send OPTIONS WITHOUT the key header, so it must be answered
      // before the auth/kill-switch gates (it carries no payload and touches nothing db-side)
      if (req.method === 'OPTIONS' && req.url === CAPTURE_PATH) return respond(res, 204)
      if (req.method !== 'POST' || req.url !== CAPTURE_PATH) return respond(res, 404, { error: 'not found' })
      // kill switch first: a disabled endpoint answers 503 to everything, exposing nothing
      if (!isEnabled()) return respond(res, 503, { error: 'capture endpoint is disabled' })
      // then the handshake — before anything touches the db
      const provided = req.headers[KEY_HEADER.toLowerCase()]
      const expected = getSecret()
      if (!expected || !keysMatch(typeof provided === 'string' ? provided : undefined, expected)) {
        return respond(res, 401, { error: 'missing or invalid ' + KEY_HEADER })
      }
      let payload
      try {
        const raw = await readBody(req)
        payload = JSON.parse(raw)
      } catch (e) {
        return respond(res, e.statusCode === 413 ? 413 : 400, { error: e.statusCode === 413 ? 'body too large' : 'invalid JSON body' })
      }
      try {
        const r = runIngest(payload)
        if (!r.ok) return respond(res, r.status || 400, { error: r.error })
        if (r.status === 200) return respond(res, 200, { duplicate: true, taskId: r.taskId })
        return respond(res, 201, { taskId: r.taskId })
      } catch (e) {
        return respond(res, 500, { error: 'capture ingest failed' })
      }
    }).catch(() => respond(res, 500, { error: 'capture ingest failed' }))
  })

  let actualPort = null
  const ready = new Promise((resolve, reject) => {
    let p = basePort
    let tries = 0
    const listen = () => {
      server.once('error', e => {
        // EADDRINUSE: someone holds the port. EACCES: on Windows a port can also be unusable
        // without a listener (excluded/managed range or security software) — the earlier
        // EADDRINUSE-only gate made the fallback give up with an uncaught error on such boxes
        // (live-repro: 7789 held by the test blocker, 7790 answers EACCES, 7791 binds fine).
        if (e && (e.code === 'EADDRINUSE' || e.code === 'EACCES') && tries < attempts) {
          tries++
          p += 1
          listen()
        } else {
          reject(e)
        }
      })
      server.listen(p, CAPTURE_HOST, () => {
        actualPort = server.address().port
        resolve(actualPort)
      })
    }
    listen()
  })

  return {
    server,
    ready,
    get actualPort () { return actualPort },
    close: () => new Promise(resolve => server.close(resolve))
  }
}

module.exports = { startCaptureServer }
