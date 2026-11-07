/* eslint-env node */
/**
 * Request auth gate for cross-platform sync endpoints (Lane A, 2026-11-07).
 *
 * Every inbound request must pass ALL of, in fail-closed order:
 *   1. Origin allowlist — http(s) origins must be localhost loopback peers;
 *      no public wildcard-interface endpoint is implied anywhere in this lane.
 *   2. CSRF guard — a non-simple custom header (X-PickDone-Request) must match the
 *      session nonce; cross-origin browsers cannot set it without a CORS preflight,
 *      so a forged form/tab request fails before auth is even consulted.
 *   3. Bearer capability token — HMAC-verified, unexpired, unrevoked, and carrying
 *      the scope the operation demands (WRITE ops reject READ-only tokens).
 *   4. Replay/idempotency — a (deviceId, messageId) pair already settled inside the
 *      dedupe window returns the CACHED verdict (idempotent), never re-executes.
 *   5. Rate limit — per-device fixed window; excess requests fail closed with
 *      retryAfterMs instead of being processed.
 *
 * Pure logic with injected clock — the HTTP layer (if any) only marshals.
 */

import { timingSafeEqual } from 'node:crypto'
import { verifyToken, TOKEN_ERRORS } from './capability-token.mjs'

export const GATE_ERRORS = {
  ORIGIN: 'origin_rejected',
  CSRF: 'csrf_rejected',
  RATE_LIMITED: 'rate_limited',
  REPLAY_MALFORMED: 'message_id_required'
}

export const OP_SCOPES = {
  // READ operations
  'sync.pull': 'READ',
  'sync.status': 'READ',
  // WRITE operations (push implies pull)
  'sync.push': 'WRITE',
  'task.put': 'WRITE',
  'task.delete': 'WRITE',
  'category.put': 'WRITE',
  'episode.put': 'WRITE',
  'source.put': 'WRITE'
}

const DEFAULT_RATE = { windowMs: 60 * 1000, max: 120 }

export class AuthGate {
  constructor ({ secret, sessionNonce, now = Date.now, allowedOrigins = ['null'], rate = DEFAULT_RATE, dedupeWindowMs = 10 * 60 * 1000, revocations = null } = {}) {
    if (!secret) throw new TypeError('AuthGate: secret required')
    if (!sessionNonce) throw new TypeError('AuthGate: sessionNonce required')
    this.secret = secret
    this.sessionNonce = String(sessionNonce)
    this.now = now
    this.allowedOrigins = new Set(allowedOrigins)
    this.rate = rate
    this.dedupeWindowMs = dedupeWindowMs
    this.revocations = revocations
    /** messageId -> {settledAt, result} for idempotent replay of the SAME message */
    this.settled = new Map()
    /** deviceId -> {windowStart, count} */
    this.windows = new Map()
  }

  _rateCheck (deviceId) {
    const now = this.now()
    let w = this.windows.get(deviceId)
    if (!w || now - w.windowStart >= this.rate.windowMs) {
      w = { windowStart: now, count: 0 }
      this.windows.set(deviceId, w)
    }
    w.count += 1
    if (w.count > this.rate.max) {
      return { ok: false, code: GATE_ERRORS.RATE_LIMITED, retryAfterMs: this.rate.windowMs - (now - w.windowStart) }
    }
    return null
  }

  /**
   * Gate one request.
   * @param {object} req {op, origin, csrfHeader, bearer, deviceId, messageId, isLocalLoopback}
   * @param {function} handler (deviceId, payload?) => result — called ONLY when all checks pass
   */
  handle (req, handler) {
    const { op, origin, csrfHeader, bearer, deviceId, messageId, isLocalLoopback = false } = req || {}

    // 1. origin: loopback/native clients pass; browser origins must be allowlisted
    if (isLocalLoopback !== true) {
      if (typeof origin !== 'string' || !this.allowedOrigins.has(origin)) {
        return { ok: false, code: GATE_ERRORS.ORIGIN, status: 403 }
      }
    }

    // 2. CSRF: custom header must equal the session nonce (constant-time)
    if (typeof csrfHeader !== 'string' || !timingSafeEq(csrfHeader, this.sessionNonce)) {
      return { ok: false, code: GATE_ERRORS.CSRF, status: 403 }
    }

    if (!deviceId) return { ok: false, code: TOKEN_ERRORS.BAD_PAYLOAD, status: 401 }
    const rl = this._rateCheck(String(deviceId))
    if (rl) return { ...rl, status: 429 }

    // 4. idempotent replay: same settled (deviceId, messageId) returns the cached verdict
    if (messageId == null || messageId === '') return { ok: false, code: GATE_ERRORS.REPLAY_MALFORMED, status: 400 }
    const key = `${deviceId}\u0000${messageId}`
    const prior = this.settled.get(key)
    if (prior && this.now() - prior.settledAt <= this.dedupeWindowMs) {
      return { ...prior.result, replay: true }
    }

    // 3. token + scope (checked after rate limit so floods cannot burn HMAC work)
    const requiredScope = OP_SCOPES[op]
    if (!requiredScope) return { ok: false, code: TOKEN_ERRORS.BAD_SCOPE, status: 400 }
    const verdict = verifyToken(this.secret, bearer, { requiredScope, now: this.now(), revocations: this.revocations })
    if (!verdict.ok) return { ok: false, code: verdict.code, status: 401 }
    if (verdict.payload.deviceId !== String(deviceId)) return { ok: false, code: TOKEN_ERRORS.BAD_PAYLOAD, status: 401 }

    let result
    try {
      result = { ok: true, status: 200, result: handler(String(deviceId), req.payload) }
    } catch (e) {
      result = { ok: false, status: 500, code: 'handler_error', detail: e && e.message }
    }
    this.settled.set(key, { settledAt: this.now(), result })
    this._sweepSettled()
    return result
  }

  _sweepSettled () {
    const now = this.now()
    for (const [k, v] of this.settled) {
      if (now - v.settledAt > this.dedupeWindowMs) this.settled.delete(k)
    }
  }
}

function timingSafeEq (a, b) {
  const ab = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab)
    return false
  }
  return timingSafeEqual(ab, bb)
}
