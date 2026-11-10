/* eslint-env node */
/**
 * Short-term scoped capability tokens for cross-platform sync (Lane A, 2026-11-07).
 *
 * A paired mobile/web client receives an HMAC-signed bearer token carrying
 * {deviceId, scope, iat, exp, jti}. Tokens are:
 *   - short-lived (default 15 min; the pairing exchange is the only way to mint one)
 *   - scope-limited (READ = pull only, WRITE = push/pull)
 *   - revocable (device or per-jti revocation, checked at verify time)
 *   - constant-time verified; any tamper/expiry/revocation fails closed with a
 *     machine-readable code so the auth gate can reject without leaking why.
 *
 * Reuses the desktop pairing secret as the HMAC key — no second trust root.
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

export const SCOPE_READ = 'READ'
export const SCOPE_WRITE = 'WRITE'
export const DEFAULT_TOKEN_TTL_MS = 15 * 60 * 1000

export const TOKEN_ERRORS = {
  MISSING: 'token_missing',
  MALFORMED: 'token_malformed',
  BAD_SIGNATURE: 'token_bad_signature',
  EXPIRED: 'token_expired',
  REVOKED: 'token_revoked',
  BAD_SCOPE: 'token_bad_scope',
  BAD_PAYLOAD: 'token_bad_payload'
}

function b64url (buf) { return Buffer.from(buf).toString('base64url') }

function sign (secret, signingInput) {
  return createHmac('sha256', String(secret)).update(signingInput).digest('base64url')
}

function safeEqual (a, b) {
  const ab = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab) // burn a compare so timing does not reveal length mismatch
    return false
  }
  return timingSafeEqual(ab, bb)
}

export function isValidScope (scope) {
  return scope === SCOPE_READ || scope === SCOPE_WRITE
}

/**
 * Mint a token. `revocations` is an optional Set-like shared with verify (device ids
 * or jti strings). Returns {token, jti, expiresAt}.
 */
export function issueToken (secret, { deviceId, scope, ttlMs = DEFAULT_TOKEN_TTL_MS, now = Date.now(), revocations = null } = {}) {
  if (!secret) throw new TypeError('issueToken: secret required (reuse the pairing secret)')
  if (!deviceId) throw new TypeError('issueToken: deviceId required')
  if (!isValidScope(scope)) throw new TypeError(`issueToken: scope must be ${SCOPE_READ} or ${SCOPE_WRITE}`)
  const jti = randomBytes(12).toString('hex')
  const payload = { deviceId: String(deviceId), scope, iat: now, exp: now + ttlMs, jti }
  const body = b64url(JSON.stringify(payload))
  const mac = sign(secret, body)
  return { token: `${body}.${mac}`, jti, expiresAt: payload.exp }
}

export function revokeToken (revocations, { jti = null, deviceId = null } = {}) {
  if (jti) revocations.add(`jti:${jti}`)
  if (deviceId) revocations.add(`device:${deviceId}`)
}

/**
 * Verify a bearer token. Fail-closed: returns {ok:false, code} on ANY problem.
 * `requiredScope` (optional) enforces the minimum scope — WRITE implies READ.
 */
export function verifyToken (secret, token, { requiredScope = null, now = Date.now(), revocations = null } = {}) {
  if (!token) return { ok: false, code: TOKEN_ERRORS.MISSING }
  const parts = String(token).split('.')
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, code: TOKEN_ERRORS.MALFORMED }
  const [body, mac] = parts
  const expected = sign(secret, body)
  if (!safeEqual(mac, expected)) return { ok: false, code: TOKEN_ERRORS.BAD_SIGNATURE }
  let payload
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
  } catch {
    return { ok: false, code: TOKEN_ERRORS.MALFORMED }
  }
  if (!payload || typeof payload !== 'object' || !payload.deviceId || !payload.jti ||
      !isValidScope(payload.scope) || typeof payload.exp !== 'number' || typeof payload.iat !== 'number') {
    return { ok: false, code: TOKEN_ERRORS.BAD_PAYLOAD }
  }
  if (payload.exp <= now) return { ok: false, code: TOKEN_ERRORS.EXPIRED }
  if (revocations) {
    if (revocations.has(`jti:${payload.jti}`) || revocations.has(`device:${payload.deviceId}`)) {
      return { ok: false, code: TOKEN_ERRORS.REVOKED }
    }
  }
  if (requiredScope) {
    if (!isValidScope(requiredScope)) return { ok: false, code: TOKEN_ERRORS.BAD_SCOPE }
    if (requiredScope === SCOPE_WRITE && payload.scope !== SCOPE_WRITE) {
      return { ok: false, code: TOKEN_ERRORS.BAD_SCOPE }
    }
  }
  return { ok: true, payload }
}
