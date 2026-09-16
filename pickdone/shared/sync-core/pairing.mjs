/* eslint-env node */
/**
 * PickDone sync-core: 6-digit pairing code derivation/verification.
 *
 * PLATFORM BOUNDARY — the one deliberate node:crypto import in sync-core.
 * The engine (engine.mjs) stays pure; this module runs only in Node/Electron
 * main or a bundler-shimmed environment. If sync-core is extracted to an
 * isomorphic package, swap this file for a WebCrypto implementation with the
 * same exported signatures (derive uses HMAC-SHA256 + mod 1e6, see below).
 *
 * Design (§4.1 pairing, pre-E2EE trust bootstrap): the pairing secret is a
 * 32-byte random value exchanged out-of-band (QR / manual paste). Both sides
 * derive the same 6-digit display code as HMAC-SHA256(secret, deviceId)
 * truncated to 6 digits — proving possession of the secret without
 * transmitting it. Verification is constant-time (timingSafeEqual).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** 32 random bytes, hex-encoded. Out-of-band exchange is the transport's job. */
export function generatePairingSecret() {
  return randomBytes(32).toString('hex')
}

/**
 * Derive the 6-digit pairing code for a device.
 * Deterministic: same (secret, deviceId) always yields the same code.
 * @param {string} secret - hex pairing secret from generatePairingSecret()
 * @param {string} deviceId
 * @returns {string} 6 digits, zero-padded (e.g. "004213")
 */
export function derivePairingCode(secret, deviceId) {
  if (!secret || !deviceId) throw new Error('derivePairingCode: secret and deviceId are required')
  const mac = createHmac('sha256', secret).update(String(deviceId)).digest()
  // 4 bytes -> unsigned int -> mod 1e6; uniform enough for a human-verified code
  const n = mac.readUInt32BE(0) % 1000000
  return String(n).padStart(6, '0')
}

/** Constant-time string equality (both inputs padded to equal length). */
export function constantTimeEqual(a, b) {
  const ab = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ab.length !== bb.length) {
    // still burn a compare so timing does not reveal length mismatch
    timingSafeEqual(ab, ab)
    return false
  }
  return timingSafeEqual(ab, bb)
}

/**
 * Verify a user-entered 6-digit code against the expected derivation.
 * @returns {boolean}
 */
export function verifyPairingCode(secret, deviceId, code) {
  const expected = derivePairingCode(secret, deviceId)
  return constantTimeEqual(expected, String(code).trim())
}
