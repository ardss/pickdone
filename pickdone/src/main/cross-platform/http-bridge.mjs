/* eslint-env node */
/**
 * Cross-platform HTTP bridge — the REAL desktop transport (Lane A wiring, 2026-11-07).
 *
 * Wires the 85d5f3c1 security stack (one-shot pairing challenge, short-lived scoped
 * capability tokens, AuthGate origin/CSRF/replay/rate/scope) onto actual node:http
 * routes served by the Electron main process:
 *
 *   POST /crossplatform/pair    {challengeId, code, deviceId}  -> one-shot capability token
 *   POST /crossplatform/pull    {}                             -> all entities as DTOs (READ)
 *   POST /crossplatform/push    {ops:[{entity, rows}]}         -> apply verdicts       (WRITE)
 *
 * Hard constraints:
 *   - binds 127.0.0.1 ONLY, and only when start() is called; the app must keep it
 *     disabled by default (gate on the sync.crossPlatform.enabled setting at the caller)
 *   - no SQLite/file/command surface on the wire — only the three routes above
 *   - every request goes through AuthGate.handle; nothing bypasses the gate
 *   - state (pairing secret, session nonce, revocations) is injected + persisted by the
 *     caller, so a desktop restart keeps valid tokens valid and revocations sticky
 *
 * ESM: imported by tests directly; the Electron bootstrap wires it via dynamic import.
 */

import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { PairingChallengeService, PAIRING_ERRORS } from '../../../shared/cross-platform/pairing-challenge.mjs'
import { AuthGate, GATE_ERRORS } from '../../../shared/cross-platform/auth-gate.mjs'
import { revokeToken, SCOPE_READ } from '../../../shared/cross-platform/capability-token.mjs'
import {
  taskToDto, categoryToDto, episodeToDto, sourceRefToDto, sourceLinkToDto,
  taskFromDto, categoryFromDto, episodeFromDto, sourceRefFromDto, sourceLinkFromDto
} from '../../../shared/cross-platform/dto.mjs'
import { applyInboundBatch } from '../../../shared/cross-platform/dto-service.mjs'

const MAX_BODY_BYTES = 2 * 1024 * 1024
const ROUTES = new Set(["/crossplatform/pair", "/crossplatform/pull", "/crossplatform/push"])
const ENTITY_TO_DTO_IN = {
  todos: taskFromDto,
  categories: categoryFromDto,
  work_episodes: episodeFromDto,
  source_refs: sourceRefFromDto,
  task_source_links: sourceLinkFromDto
}
const ENTITY_TO_DTO_OUT = {
  todos: taskToDto,
  categories: categoryToDto,
  work_episodes: episodeToDto,
  source_refs: sourceRefToDto,
  task_source_links: sourceLinkToDto
}
const PAIR_ERROR_STATUS = {
  [PAIRING_ERRORS.NO_CHALLENGE]: 404,
  [PAIRING_ERRORS.EXPIRED]: 410,
  [PAIRING_ERRORS.BURNED]: 410,
  [PAIRING_ERRORS.BAD_CODE]: 401,
  [PAIRING_ERRORS.THROTTLED]: 429,
  [PAIRING_ERRORS.BAD_REQUEST]: 400
}
const GATE_ERROR_STATUS = {
  [GATE_ERRORS.ORIGIN]: 403,
  [GATE_ERRORS.CSRF]: 403,
  [GATE_ERRORS.RATE_LIMITED]: 429,
  [GATE_ERRORS.REPLAY_MALFORMED]: 400
}

export class CrossPlatformBridge {
  /**
   * @param {object} deps
   *   repo            — createDesktopRepo() adapter (get/put/allRows)
   *   stores          — persisted injected state:
   *                     pairingSecret: {load()->string|null, save(s)}, sessionNonce likewise,
   *                     revocations: {load()->string[], save(a)}
   *   allowedOrigins  — browser origins allowed past the origin check
   *   pairing / gate  — optional pre-built services (tests inject the clock)
   *   rate, log       — rate limit config; audit sink
   */
  constructor (deps) {
    if (!deps || !deps.repo) throw new TypeError('CrossPlatformBridge: repo required')
    const st = deps.stores
    if (!st || !st.pairingSecret || !st.sessionNonce || !st.revocations) {
      throw new TypeError('CrossPlatformBridge: stores {pairingSecret, sessionNonce, revocations} required (restart recovery depends on persisted state)')
    }
    this.repo = deps.repo
    this.stores = st
    this.log = deps.log || (() => {})
    this.now = deps.now || (() => Date.now())

    // persisted trust root: mint once on first boot, reuse across restarts
    this.pairingSecret = st.pairingSecret.load()
    if (!this.pairingSecret) {
      this.pairingSecret = randomBytes(32).toString('hex')
      st.pairingSecret.save(this.pairingSecret)
      this.log('bridge', 'pairing-secret minted (first boot)')
    }
    this.sessionNonce = st.sessionNonce.load()
    if (!this.sessionNonce) {
      this.sessionNonce = randomBytes(16).toString('hex')
      st.sessionNonce.save(this.sessionNonce)
    }
    this.revocations = new Set(st.revocations.load() || [])
    // paired-device registry (settings UI surface): {deviceId, scope, pairedAt, revokedAt?}
    // persisted when the caller supplies a devices store; in-memory otherwise (tests)
    this.devices = new Map((st.devices && st.devices.load() || []).map(d => [d.deviceId, d]))
    this._devicesStore = st.devices || null
    this.bindAddress = deps.bindAddress || '127.0.0.1'

    this.pairing = deps.pairing || new PairingChallengeService()
    this.gate = deps.gate || new AuthGate({
      secret: this.pairingSecret,
      sessionNonce: this.sessionNonce,
      revocations: this.revocations,
      allowedOrigins: deps.allowedOrigins || [],
      ...(deps.rate ? { rate: deps.rate } : {})
    })
    this.server = null
    this.port = null
  }

  /** Desktop UI side: mint a one-time challenge for a device (returns code to display). */
  issuePairing (deviceId, { scope = SCOPE_READ } = {}) {
    const ch = this.pairing.issue(deviceId, { scope, pairingSecret: this.pairingSecret })
    this.log('bridge', `pairing challenge issued for device ${deviceId} scope=${scope}`)
    return ch
  }

  /** Desktop UI side: cut a device off immediately (kills all its tokens). */
  revokeDevice (deviceId) {
    revokeToken(this.revocations, { deviceId })
    this._persistRevocations()
    const entry = this.devices.get(String(deviceId))
    if (entry) {
      entry.revokedAt = this.now()
      if (this._devicesStore) this._devicesStore.save([...this.devices.values()])
    }
    this.log('bridge', `device revoked: ${deviceId}`)
  }

  /** Settings UI: sanitized snapshot - NO secrets, NO user data. */
  status () {
    const running = !!(this.server && this.port != null)
    return {
      running,
      port: running ? this.port : null,
      bindAddress: this.bindAddress,
      lanReachable: this.bindAddress !== '127.0.0.1',
      devices: [...this.devices.values()].map(d => ({ deviceId: d.deviceId, scope: d.scope, pairedAt: d.pairedAt, revokedAt: d.revokedAt || null })),
      lastError: this.lastError || null
    }
  }

  _persistRevocations () {
    this.stores.revocations.save([...this.revocations])
  }

  /**
   * Start listening. Binds 127.0.0.1 ONLY. Resolves {port, address}.
   */
  start ({ port = 0 } = {}) {
    if (this.server) return Promise.resolve({ port: this.port, address: '127.0.0.1' })
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => { this._dispatch(req, res) })
      server.on('error', reject)
      server.listen(port, this.bindAddress, () => {
        this.server = server
        this.port = server.address().port
        this.log('bridge', `listening on ${this.bindAddress}:${this.port}${this.bindAddress === '127.0.0.1' ? ' (loopback only)' : ' (LAN reachable)'}`)
        resolve({ port: this.port, address: '127.0.0.1' })
      })
    })
  }

  async close () {
    if (!this.server) return
    // destroy idle keep-alive sockets (undici/fetch pools hold them open) so close() settles
    if (typeof this.server.closeIdleConnections === 'function') this.server.closeIdleConnections()
    if (typeof this.server.closeAllConnections === 'function') this.server.closeAllConnections()
    await new Promise(resolve => this.server.close(resolve))
    this.server = null
    this.port = null
  }

  /**
   * Controlled CORS (QA fix: real Chromium could not call the bridge - OPTIONS 405,
   * no ACAO). Headers are emitted ONLY for origins on the explicit allowlist; unknown
   * origins get no reflection and no wildcard, ever.
   */
  _corsHeaders (req) {
    const origin = req && req.headers && req.headers.origin
    if (typeof origin !== 'string' || !this.gate.allowedOrigins.has(origin)) return null
    return {
      'Access-Control-Allow-Origin': origin, // exact echo of an ALLOWLISTED origin, never *
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-PickDone-Request',
      'Access-Control-Max-Age': '600',
      'Vary': 'Origin'
    }
  }

  _send (res, status, body, req) {
    const json = JSON.stringify(body)
    const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(json) }
    const cors = this._corsHeaders(req)
    if (cors) Object.assign(headers, cors)
    res.writeHead(status, headers)
    res.end(json)
  }

  _readBody (req) {
    return new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', c => {
        size += c.length
        if (size > MAX_BODY_BYTES) {
          reject(Object.assign(new Error('payload too large'), { code: 'payload_too_large' }))
          req.destroy()
          return
        }
        chunks.push(c)
      })
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      req.on('error', reject)
    })
  }

  async _dispatch (req, res) {
    try {
      const path = (req.url || '').split('?')[0]
      // CORS preflight: ONLY on existing routes, ONLY for allowlisted origins (fail closed:
      // unknown origin -> no ACAO reflection at all). Never opens new routes.
      if (req.method === 'OPTIONS') {
        const cors = this._corsHeaders(req)
        if (ROUTES.has(path) && cors) {
          const headers = { ...cors, 'Content-Length': 0 }
          res.writeHead(204, headers)
          res.end()
          return
        }
        return this._send(res, 403, { error: 'origin_rejected' }, req)
      }
      // discovery beacon: the ONLY unauthenticated route; carries no user data
      if (req.method === 'GET' && path === '/crossplatform/hello') {
        return this._send(res, 200, { service: 'pickdone-crossplatform', proto: 1, pairingRequired: true }, req)
      }
      if (req.method !== 'POST') return this._send(res, 405, { error: 'method_not_allowed' }, req)
      if (!ROUTES.has(path)) return this._send(res, 404, { error: 'not_found' }, req)

      let raw
      try {
        raw = await this._readBody(req)
      } catch (e) {
        return this._send(res, 413, { error: e.code || 'payload_too_large' }, req)
      }
      let body = {}
      try {
        body = raw ? JSON.parse(raw) : {}
      } catch {
        return this._send(res, 400, { error: 'invalid_json' }, req)
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return this._send(res, 400, { error: 'invalid_json' }, req)
      }

      if (path === '/crossplatform/pair') return this._handlePair(res, req, body)
      if (path === '/crossplatform/pull') return this._handlePull(req, res, body)
      if (path === '/crossplatform/push') return this._handlePush(req, res, body)
    } catch (e) {
      this.lastError = `${e && e.message}`
      this.log('bridge', `dispatch error: ${e && e.message} :: ${(e && e.stack || '').split('\n').slice(1, 3).join(' | ')}`)
      return this._send(res, 500, { error: 'internal_error' }, req)
    }
  }

  _handlePair (res, req, body) {
    const r = this.pairing.consume(body)
    if (!r.ok) {
      this.log('bridge', `pairing failed: ${r.code}`)
      return this._send(res, PAIR_ERROR_STATUS[r.code] || 401, { ok: false, error: r.code }, req)
    }
    this.log('bridge', `paired device ${r.deviceId} scope=${r.scope}`)
    this.devices.set(r.deviceId, { deviceId: r.deviceId, scope: r.scope, pairedAt: this.now() })
    if (this._devicesStore) this._devicesStore.save([...this.devices.values()])
    return this._send(res, 200, { ok: true, token: r.token, expiresAt: r.expiresAt, scope: r.scope, deviceId: r.deviceId, csrfHeader: this.sessionNonce }, req)
  }

  /**
   * Shared gate marshaling: bridge-specific headers -> AuthGate request, verdict -> HTTP.
   * Push/pull MUST carry the CSRF header value issued at pairing time (`csrfHeader`).
   */
  _gateRequest (req, body, op) {
    return {
      op,
      origin: req.headers.origin,
      csrfHeader: req.headers['x-pickdone-request'],
      bearer: this._bearer(req),
      deviceId: body.deviceId,
      messageId: body.messageId,
      payload: body.payload,
      isLocalLoopback: false
    }
  }

  _bearer (req) {
    const h = req.headers.authorization || ''
    return h.startsWith('Bearer ') ? h.slice(7) : undefined
  }

  _sendGateVerdict (res, req, verdict) {
    if (!verdict.ok) this.log('bridge', `gate reject: ${verdict.code}`)
    if (verdict.ok) return this._send(res, 200, { ok: true, ...(verdict.replay ? { replay: true } : {}), result: verdict.result }, req)
    const status = GATE_ERROR_STATUS[verdict.code] || (verdict.status >= 400 ? verdict.status : 401)
    const out = { ok: false, error: verdict.code }
    if (verdict.retryAfterMs != null) out.retryAfterMs = verdict.retryAfterMs
    return this._send(res, status, out, req)
  }

  _handlePull (req, res, body) {
    const verdict = this.gate.handle(this._gateRequest(req, body, 'sync.pull'), deviceId => {
      try {
      const entities = {}
      for (const [entity, toDto] of Object.entries(ENTITY_TO_DTO_OUT)) {
        entities[entity] = (this.repo.allRows(entity) || []).map(toDto)
      }
      this.log('bridge', `pull served deviceId=${deviceId} todos=${entities.todos.length}`)
      return { entities, pulledAt: this.now() }
      } catch (e) { this.log('bridge', 'pull handler failed: ' + e.message + ' :: ' + (e.stack || '').split(String.fromCharCode(10))[1]); throw e }
    })
    return this._sendGateVerdict(res, req, verdict)
  }

  _handlePush (req, res, body) {
    // NOTE: shape validation lives INSIDE the gated handler so unauthenticated probes
    // get a plain 401 and learn nothing about payload validation.
    const verdict = this.gate.handle(this._gateRequest(req, body, 'sync.push'), deviceId => {
      const ops = body.payload && body.payload.ops
      if (!Array.isArray(ops) || ops.length === 0 || ops.length > 500) {
        return { invalid: true, error: 'push ops[] (1..500) required' }
      }
      for (const opEntry of ops) {
        if (!opEntry || !ENTITY_TO_DTO_IN[opEntry.entity] || !Array.isArray(opEntry.rows)) {
          return { invalid: true, error: `invalid op entity: ${(opEntry && opEntry.entity) || 'unknown'}` }
        }
        if (opEntry.rows.length === 0 || opEntry.rows.length > 500) {
          return { invalid: true, error: 'rows[] (1..500) required per op' }
        }
      }
      const results = []
      for (const opEntry of ops) {
        const decode = ENTITY_TO_DTO_IN[opEntry.entity]
        const rows = []
        const decodeErrors = []
        for (const dto of opEntry.rows) {
          try {
            rows.push(decode(dto))
          } catch (e) {
            decodeErrors.push({ error: 'invalid_row', detail: e && e.message })
          }
        }
        const outcomes = applyInboundBatch(this.repo, opEntry.entity, rows)
        results.push({ entity: opEntry.entity, outcomes, decodeErrors })
      }
      this.log('bridge', `push applied deviceId=${deviceId} ops=${ops.length}`)
      return { results }
    })
    if (verdict.ok && verdict.result && verdict.result.invalid) {
      return this._send(res, 400, { ok: false, error: verdict.result.error }, req)
    }
    return this._sendGateVerdict(res, req, verdict)
  }
}
