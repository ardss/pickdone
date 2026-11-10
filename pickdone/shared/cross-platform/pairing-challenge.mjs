/* eslint-env node */
/**
 * One-shot pairing challenge for Android/Web clients (Lane A, 2026-11-07).
 *
 * Flow: desktop issues a challenge {challengeId, code, expiresAt}; the mobile/web
 * client presents {challengeId, code, deviceId} ONCE; success mints a scoped
 * capability token (see capability-token.mjs). Properties:
 *   - challenge is single-use: the first consume wins, replays fail closed
 *   - code TTL reuses the desktop pairing contract constant (pairing-ttl.mjs, 10 min)
 *   - wrong-code attempts are throttled per challengeId (MAX_ATTEMPTS then burn)
 *   - code derivation reuses sync-core pairing.mjs (HMAC-SHA256 mod 1e6) — one
 *     derivation scheme across desktop LAN pairing and cross-platform pairing
 *   - tokens are minted ONLY here; there is no other credential path
 *
 * Pure logic with injected clock — no Electron, no sockets, no listeners.
 */

import { randomBytes } from 'node:crypto'
import { derivePairingCode, verifyPairingCode, generatePairingSecret } from '../sync-core/pairing.mjs'
import { PAIRING_CODE_TTL_MS } from '../pairing-ttl.mjs'
import { issueToken, SCOPE_READ, SCOPE_WRITE } from './capability-token.mjs'

export const MAX_ATTEMPTS = 5

export const PAIRING_ERRORS = {
  NO_CHALLENGE: 'challenge_unknown',
  EXPIRED: 'challenge_expired',
  BURNED: 'challenge_burned',
  BAD_CODE: 'challenge_bad_code',
  THROTTLED: 'challenge_throttled',
  BAD_REQUEST: 'pairing_bad_request'
}

export class PairingChallengeService {
  constructor ({ now = Date.now, ttlMs = PAIRING_CODE_TTL_MS, maxAttempts = MAX_ATTEMPTS } = {}) {
    this.now = now
    this.ttlMs = ttlMs
    this.maxAttempts = maxAttempts
    /** @type {Map<string, {secret:string, deviceId:string, scope:string, expiresAt:number, attempts:number, consumed:boolean}>} */
    this.challenges = new Map()
  }

  /**
   * Desktop side: issue a challenge bound to a device id and scope.
   * The returned `code` is what the user types/confirms on the desktop; the
   * client proves possession by presenting it within the TTL.
   */
  issue (deviceId, { scope = SCOPE_READ, pairingSecret = generatePairingSecret() } = {}) {
    if (!deviceId) throw new TypeError('issue: deviceId required')
    if (scope !== SCOPE_READ && scope !== SCOPE_WRITE) throw new TypeError(`issue: scope must be ${SCOPE_READ} or ${SCOPE_WRITE}`)
    const challengeId = randomBytes(12).toString('hex')
    const code = derivePairingCode(pairingSecret, deviceId)
    const expiresAt = this.now() + this.ttlMs
    this.challenges.set(challengeId, { secret: pairingSecret, deviceId: String(deviceId), scope, expiresAt, attempts: 0, consumed: false })
    return { challengeId, code, expiresAt, scope }
  }

  _fail (entry, code) {
    return { ok: false, code }
  }

  /**
   * Mobile/web side: consume a challenge. Exactly one call can succeed;
   * every other path fails closed with a machine-readable code.
   * On success mints a short-lived scoped token (capability-token.mjs).
   */
  consume ({ challengeId, code, deviceId, pairingSecretOverride = null } = {}, { tokenTtlMs } = {}) {
    if (!challengeId || !deviceId || code == null) return { ok: false, code: PAIRING_ERRORS.BAD_REQUEST }
    const entry = this.challenges.get(String(challengeId))
    if (!entry) return { ok: false, code: PAIRING_ERRORS.NO_CHALLENGE }
    if (String(deviceId) !== entry.deviceId) {
      // wrong device probing someone else's challenge — burn it immediately
      entry.consumed = true
      return { ok: false, code: PAIRING_ERRORS.BAD_CODE }
    }
    if (entry.attempts >= this.maxAttempts) {
      entry.consumed = true
      return { ok: false, code: PAIRING_ERRORS.THROTTLED }
    }
    if (entry.consumed) return { ok: false, code: PAIRING_ERRORS.BURNED }
    if (this.now() > entry.expiresAt) {
      entry.consumed = true
      return { ok: false, code: PAIRING_ERRORS.EXPIRED }
    }
    const secret = pairingSecretOverride != null ? pairingSecretOverride : entry.secret
    entry.attempts += 1
    if (!verifyPairingCode(secret, deviceId, code)) {
      // after the last allowed bad attempt the challenge is dead
      if (entry.attempts >= this.maxAttempts) entry.consumed = true
      return { ok: false, code: PAIRING_ERRORS.BAD_CODE }
    }
    entry.consumed = true // keep the entry so a replay reports BURNED, not "unknown"; sweep cleans up
    const issued = issueToken(secret, { deviceId: entry.deviceId, scope: entry.scope, now: this.now(), ...(tokenTtlMs ? { ttlMs: tokenTtlMs } : {}) })
    return { ok: true, token: issued.token, jti: issued.jti, expiresAt: issued.expiresAt, scope: entry.scope, deviceId: entry.deviceId }
  }

  /** Housekeeping: drop dead challenges (expired or consumed). */
  sweep () {
    const now = this.now()
    for (const [id, e] of this.challenges) {
      if (e.consumed || now > e.expiresAt) this.challenges.delete(id)
    }
  }
}
