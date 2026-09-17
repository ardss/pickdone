'use strict'

/**
 * LAN sync pairing adapter.
 *
 * Delegates to the sync-core pairing contract (shared/sync-core/pairing.mjs:
 * HMAC-SHA256(secret, deviceId) mod 1e6, 6-digit zero-padded code, constant-
 * time verify). That module is pure ESM and this layer is CommonJS, so the
 * derivation is mirrored here byte-for-byte and `assertSyncCorePairingParity`
 * (used by tests) dynamically imports the real module and proves the two
 * agree. If sync-core's derivation ever changes, the parity check fails first.
 *
 * The pairing secret is provided by the DB/meta layer (Wave-2); this module
 * only derives and verifies codes. No Electron imports. CommonJS.
 */

const crypto = require('node:crypto')

/**
 * Mirror of shared/sync-core/pairing.mjs#derivePairingCode.
 * @param {string} pairingSecret - hex pairing secret (from DB/meta layer)
 * @param {string} deviceId
 * @returns {string} 6-digit zero-padded code
 */
function deriveAuthCode(pairingSecret, deviceId) {
  if (typeof pairingSecret !== 'string' || pairingSecret.length === 0) {
    throw new Error('deriveAuthCode: pairingSecret must be a non-empty string')
  }
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    throw new Error('deriveAuthCode: deviceId must be a non-empty string')
  }
  const mac = crypto.createHmac('sha256', pairingSecret).update(String(deviceId)).digest()
  const n = mac.readUInt32BE(0) % 1000000
  return String(n).padStart(6, '0')
}

/** Constant-time string equality (pads both to the same length first). */
function timingSafeEqualStr(a, b) {
  const ab = Buffer.from(String(a), 'utf8')
  const bb = Buffer.from(String(b), 'utf8')
  if (ab.length !== bb.length) {
    // Compare against self to keep timing uniform, then fail.
    crypto.timingSafeEqual(ab, ab)
    return false
  }
  return crypto.timingSafeEqual(ab, bb)
}

/**
 * Verify a peer's authCode against the pairing secret and its claimed deviceId.
 * @returns {boolean} true if the code is valid for this deviceId
 */
function verifyAuthCode(pairingSecret, deviceId, authCode) {
  if (typeof pairingSecret !== 'string' || pairingSecret.length === 0) return false
  if (typeof deviceId !== 'string' || deviceId.length === 0) return false
  if (typeof authCode !== 'string' || authCode.length === 0) return false
  return timingSafeEqualStr(deriveAuthCode(pairingSecret, deviceId), String(authCode).trim())
}

/** Shape check for a pairing secret (32-byte hex from generatePairingSecret, or 6+ char manual code). */
function isValidPairingSecret(secret) {
  return typeof secret === 'string' && /^[A-Za-z0-9-]{6,128}$/.test(secret)
}

/**
 * Prove this adapter's derivation matches shared/sync-core/pairing.mjs.
 * Resolves {parity: true} on success; rejects if the real module disagrees or
 * is unreadable. Tests must await this so derivation drift fails loudly.
 */
async function assertSyncCorePairingParity() {
  const core = await import('../../../shared/sync-core/pairing.mjs')
  const vectors = [
    ['a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2a3b4c5d6a7b8c9d0e1f2', 'device-a'],
    ['secret-123', 'device-b'],
    ['0123456789abcdef', 'node-9'],
  ]
  for (const [secret, device] of vectors) {
    const expected = core.derivePairingCode(secret, device)
    const actual = deriveAuthCode(secret, device)
    if (expected !== actual) {
      throw new Error(`pairing parity drift: sync-core=${expected} lan-sync=${actual}`)
    }
    if (!core.verifyPairingCode(secret, device, actual)) {
      throw new Error('pairing parity: sync-core cannot verify lan-sync code')
    }
  }
  return { parity: true }
}

module.exports = { deriveAuthCode, verifyAuthCode, isValidPairingSecret, assertSyncCorePairingParity }
