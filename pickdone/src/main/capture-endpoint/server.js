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
const path = require('path')
const { pathToFileURL } = require('url')
const { ingestCapture } = require('./handlers')
const { keysMatch, KEY_HEADER } = require('./secret')
const { CAPTURE_HOST, CAPTURE_PORT, CAPTURE_PATH } = require('./contract.cjs')

const MAX_BODY = 64 * 1024
// shared/handoff.mjs is ESM (imported by the renderer); the CJS main side loads it by URL
const handoffModuleUrl = pathToFileURL(path.join(__dirname, '..', '..', '..', 'shared', 'handoff.mjs')).href

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
  const query = opts.query || null // read door: (op, arg) => rows|null (fail-closed when unwired)
  const linkSource = opts.linkSource || null // POST /link-source handler (handlers.linkSource)
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
    // J3 sentinel: EVERY answer carries the door identity so a client (extension popup probe,
    // VS Code extension) can prove it reached the REAL PickDone door and learn the actual
    // bound port — the silent EADDRINUSE fallback to basePort+1 used to leave both ends blind.
    const headers = Object.assign({}, CORS_HEADERS, {
      'X-PickDone-Door': '1',
      'X-PickDone-Port': String(actualPort || basePort)
    })
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

  // Read door (PD20 VS Code extension MVP): GET routes behind the SAME gates as the ingest
  // door (loopback bind + kill switch + per-request X-PickDone-Key). query(op, arg) is
  // injected by index.js over the real db handle and fails closed (null → 503) when the db
  // is closed. Read-only: no bus commits on any GET path.
  const READ_ROUTES = {
    '/tasks': () => {
      const rows = query('queryTodos', { deleted: 0 }) || []
      return rows.slice(0, 200).map(r => ({
        taskId: r.taskId, content: r.taskContent, categoryId: r.categoryId,
        complete: !!r.complete, updateTime: r.updateTime
      }))
    },
    '/projects': () => {
      const rows = query('categoriesAllRows') || []
      return rows.filter(r => !r.deleted).map(r => ({ categoryId: r.id, name: r.name }))
    },
    '/sources': taskId => query('querySourcesByTask', taskId) || [],
    '/episodes': taskId => query('queryEpisodesByTask', taskId) || []
  }
  const READ_PATHS = Object.keys(READ_ROUTES).concat(['/handoff', '/link-source'])
  const KNOWN_PATHS = READ_PATHS.concat([CAPTURE_PATH])

  const server = http.createServer((req, res) => {
    Promise.resolve().then(async () => {
      const pathOnly = (req.url || '').split('?')[0]
      // preflight first: browsers send OPTIONS WITHOUT the key header, so it must be answered
      // before the auth/kill-switch gates (it carries no payload and touches nothing db-side)
      if (req.method === 'OPTIONS' && KNOWN_PATHS.includes(pathOnly)) return respond(res, 204)
      // route existence before the gates (the original ingest door answered 404 pre-auth; the
      // read door keeps that: an unknown path reveals nothing, a known path still gates below)
      const isRead = req.method === 'GET' && (READ_ROUTES[pathOnly] || pathOnly === '/handoff')
      const isLink = req.method === 'POST' && pathOnly === '/link-source'
      const isCapture = req.method === 'POST' && req.url === CAPTURE_PATH
      if (!((isRead || isLink || isCapture))) return respond(res, 404, { error: 'not found' })
      // kill switch first: a disabled endpoint answers 503 to everything, exposing nothing
      if (!isEnabled()) return respond(res, 503, { error: 'capture endpoint is disabled' })
      // then the handshake — before anything touches the db
      const provided = req.headers[KEY_HEADER.toLowerCase()]
      const expected = getSecret()
      if (!expected || !keysMatch(typeof provided === 'string' ? provided : undefined, expected)) {
        return respond(res, 401, { error: 'missing or invalid ' + KEY_HEADER })
      }

      if (req.method === 'GET' && READ_ROUTES[pathOnly]) {
        if (!query) return respond(res, 503, { error: 'read door not wired' })
        try {
          const taskId = new URL('http://x' + req.url).searchParams.get('taskId') || ''
          return respond(res, 200, READ_ROUTES[pathOnly](taskId))
        } catch {
          return respond(res, 500, { error: 'read failed' })
        }
      }
      if (req.method === 'GET' && pathOnly === '/handoff') {
        if (!query) return respond(res, 503, { error: 'read door not wired' })
        const taskId = new URL('http://x' + req.url).searchParams.get('taskId') || ''
        if (!taskId) return respond(res, 400, { error: 'taskId required' })
        try {
          const { parseNoteFields } = require('../db-episode-ops.cjs')
          const episodes = (query('queryEpisodesByTask', taskId) || []).map(ep => {
            const f = parseNoteFields(ep && ep.summary) // the SAME round-trip EditPanelWork uses
            return {
              startedAt: ep && ep.startedAt ? new Date(ep.startedAt).toISOString() : '',
              role: 'human',
              goal: f.goal,
              outcome: f.outcome,
              nextAction: f.nextAction
            }
          })
          const sources = (query('querySourcesByTask', taskId) || []).map(s => ({ level: s.level || 'L0', canonicalUri: s.canonicalUri }))
          const todos = query('queryTodos', { deleted: 0 }) || []
          const task = todos.find(t => t.taskId === taskId)
          const { buildHandoff } = await import(handoffModuleUrl)
          const h = buildHandoff(episodes, sources, { id: taskId, title: task ? task.taskContent : '' })
          return respond(res, 200, h)
        } catch {
          return respond(res, 500, { error: 'handoff read failed' })
        }
      }
      if (req.method === 'POST' && pathOnly === '/link-source') {
        if (!linkSource) return respond(res, 503, { error: 'link-source not wired' })
        let payload
        try {
          const raw = await readBody(req)
          payload = JSON.parse(raw)
        } catch (e) {
          return respond(res, e.statusCode === 413 ? 413 : 400, { error: e.statusCode === 413 ? 'body too large' : 'invalid JSON body' })
        }
        try {
          const r = linkSource(payload)
          if (!r.ok) return respond(res, r.status || 400, { error: r.error })
          if (r.status === 200) return respond(res, 200, { duplicate: true, sourceRefId: r.sourceRefId })
          return respond(res, 201, { sourceRefId: r.sourceRefId })
        } catch {
          return respond(res, 500, { error: 'link-source failed' })
        }
      }
      if (req.method !== 'POST' || req.url !== CAPTURE_PATH) return respond(res, 404, { error: 'not found' })
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
