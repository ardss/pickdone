/**
 * capture-endpoint/secret — the X-PickDone-Key handshake primitive (S4 browser-extension
 * track, P0). Pure Node, no electron imports: loadable from plain unit tests.
 *
 * Comparison is CONSTANT-TIME: both sides are hashed with sha256 and the DIGESTS are compared
 * with crypto.timingSafeEqual. Hashing first removes the length leak (timingSafeEqual throws
 * on unequal buffer lengths, so a raw compare would have to length-gate with an early return,
 * which is exactly the timing oracle this shape avoids). Hashing also makes the comparison
 * safe for arbitrary attacker-provided header values of any length.
 */

const crypto = require('crypto')

/** The single request header carrying the capture access key. */
const KEY_HEADER = 'X-PickDone-Key'

/** 48 hex chars = 24 random bytes (192 bits) — beyond brute-force reach for a localhost door. */
function generateKey () {
  return crypto.randomBytes(24).toString('hex')
}

/** Constant-time equality for the handshake: true only when provided === expected. */
function keysMatch (provided, expected) {
  if (typeof provided !== 'string' || !provided.length) return false
  if (typeof expected !== 'string' || !expected.length) return false // no configured secret: fail closed
  const a = crypto.createHash('sha256').update(provided, 'utf8').digest()
  const b = crypto.createHash('sha256').update(expected, 'utf8').digest()
  return crypto.timingSafeEqual(a, b)
}

module.exports = { generateKey, keysMatch, KEY_HEADER }
