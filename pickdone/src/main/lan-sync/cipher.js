'use strict'

/**
 * LAN sync transport payload encryption (2026-09-18): post-auth sync traffic used to be
 * plaintext JSON lines over TCP — anyone sniffing the LAN read task data. This module
 * provides the symmetric layer transport.js frames onto:
 *
 *   - Session key: HKDF-SHA256(pairingSecret, salt = per-connection 16B random, 32B out).
 *     The CLIENT generates the salt and sends it in the plaintext `hello` message
 *     (`salt`, b64); the server derives the same key after verifying the authCode.
 *     Info string: 'pickdone-lan-sync-v1'.
 *   - Frame: one JSON LINE `{"enc":1,"seq":N,"iv":"<b64 12B>","tag":"<b64 16B>","data":"<b64>"}`.
 *     `data` is the AES-256-GCM ciphertext of the UTF-8 JSON payload. Random 12-byte IV
 *     per message; GCM auth tag verified on decrypt — any tampering throws and the
 *     caller severs the connection. `seq` is a per-DIRECTION monotonically increasing
 *     counter starting at 0 on every connection (transport.js owns the counters and the
 *     strictly-increasing enforcement; this module only carries the field) — it blocks
 *     replaying a captured frame back into the same connection. Handshake/pair frames
 *     (pair-accept) omit `seq`: they are single-message handshakes on a connection that
 *     closes immediately after. Line-based framing and the dynamic line caps in
 *     transport.js are untouched (caps apply to the whole wire line, encrypted or not).
 *   - Pair-accept handshake key (v2, 2026-09-18): pre-pairing there is no shared long-lived
 *     secret, so the `pair-accept {secret}` reply is encrypted under HKDF-SHA256 over EPHEMERAL
 *     ECDH (NIST P-256) plus the transcript nonces:
 *       client pair-request: {nonce, pub = client ephemeral P-256 public key (b64)}
 *       server pair-challenge: {challenge, pub = server ephemeral P-256 public key (b64)}
 *       ikm = <code> | ECDH(clientPriv, serverPub) | <nonce> | <challenge>   (utf8, '|' joined)
 *       info 'pickdone-lan-sync-pair-v2', fixed salt. The code is '' in two-way mode; in MANUAL
 *       (6-digit) mode it is mixed in so an offline brute force must go through ECDH per guess.
 *     A PASSIVE sniffer sees both public keys, the nonce and the challenge — all public — but
 *     not either ephemeral private key, so it can NOT derive the shared secret (the v1 scheme
 *     HKDF(code|nonce|challenge) was fully derivable from the transcript, and in manual mode
 *     fell to a 10^6 offline brute force). Replay of an OLD captured accept under v1 keys also
 *     fails: the v1 derivation no longer matches anything.
 *     HONEST LIMITATION (do not oversell): the handshake is UNAUTHENTICATED. An ACTIVE
 *     machine-in-the-middle can substitute its own ephemeral keys on both legs, learn the
 *     secret (and, in manual mode, verify code guesses online). Stopping that requires
 *     authenticating the ephemeral keys (a PAKE such as SPAKE2+, or TLS/Noise with a shared
 *     verification string) — tracked as a known follow-up, out of scope here. Single-use server
 *     nonces (transport.js) and the connection-bound challenge still stop trivial replay of a
 *     captured accept. The long-lived pairing secret still never appears verbatim on the wire.
 *   - Zeroize: buffers are overwritten in place on socket close (best-effort — GC copies
 *     of key material inside node:crypto internals cannot be reached).
 *
 * Pure node:crypto. CommonJS, no Electron imports.
 */

const crypto = require('node:crypto')

const HKDF_INFO_SESSION = 'pickdone-lan-sync-v1'
const HKDF_INFO_PAIR = 'pickdone-lan-sync-pair-v2'
const HKDF_SALT_PAIR = 'pickdone-pair-hs-salt-v2'
const SALT_BYTES = 16
const IV_BYTES = 12
const KEY_BYTES = 32
const ENC_VER = 1
const ECDH_CURVE = 'prime256v1' // NIST P-256

/** HKDF-SHA256 -> 32-byte key Buffer. */
function hkdf(ikm, salt, info) {
  return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, KEY_BYTES))
}

/**
 * Derive the per-connection session key from the pairing secret and the client's
 * hello salt. Both sides must arrive at the same buffer (transport.js contract).
 * @param {string} pairingSecret
 * @param {string} saltB64 - 16-byte b64 salt from the `hello` message
 * @returns {Buffer} 32-byte AES-256 key
 */
function deriveSessionKey(pairingSecret, saltB64) {
  if (typeof pairingSecret !== 'string' || pairingSecret.length === 0) {
    throw new Error('deriveSessionKey: pairingSecret must be a non-empty string')
  }
  if (!isValidToken(saltB64, SALT_BYTES)) {
    throw new Error('deriveSessionKey: salt must be a 16-byte b64 token')
  }
  return hkdf(Buffer.from(pairingSecret, 'utf8'), Buffer.from(saltB64, 'base64'), HKDF_INFO_SESSION)
}

/**
 * Generate one ephemeral ECDH (P-256) keypair for the pair-accept handshake.
 * @returns {{ ecdh: object, pub: string }} the node:crypto ECDH object and our
 *   public key as b64 (goes on the wire; the private half never leaves the process)
 */
function createPairEphemeral() {
  const ecdh = crypto.createECDH(ECDH_CURVE)
  return { ecdh, pub: ecdh.generateKeys('base64') }
}

/**
 * Derive the ephemeral pair-accept handshake key (v2): HKDF over the ECDH shared
 * secret with the two sides' ephemeral keys, mixed with the 6-digit code (manual
 * mode, '' in two-way mode), the client nonce and the server challenge.
 * @param {{ code?: string, ecdh: object, peerPub: string, nonce?: string, challenge?: string }} p
 *   ecdh = OUR ephemeral (createPairEphemeral), peerPub = the PEER's wire `pub` (b64).
 * @returns {Buffer} 32-byte AES-256 key
 * @throws when the peer's `pub` is missing or not a point on the curve (caller must
 *   treat the pairing attempt as failed — it is not a valid handshake peer).
 */
function deriveHandshakeKey({ code = '', ecdh, peerPub, nonce = '', challenge = '' }) {
  if (!ecdh || typeof ecdh.computeSecret !== 'function') {
    throw new Error('deriveHandshakeKey: ephemeral ECDH keypair required')
  }
  if (typeof peerPub !== 'string' || peerPub.length === 0) {
    throw new Error('deriveHandshakeKey: peer ephemeral public key required')
  }
  const shared = ecdh.computeSecret(Buffer.from(peerPub, 'base64')) // throws on a bad point
  const ikm = Buffer.concat([
    Buffer.from(`${String(code)}|`, 'utf8'),
    shared,
    Buffer.from(`|${String(nonce)}|${String(challenge)}`, 'utf8'),
  ])
  return hkdf(ikm, Buffer.from(HKDF_SALT_PAIR, 'utf8'), HKDF_INFO_PAIR)
}

/** Random b64 token (salts, nonces, challenges). */
function randomToken(bytes = SALT_BYTES) {
  return crypto.randomBytes(bytes).toString('base64')
}

/** Shape check for a b64 token of the expected decoded length. */
function isValidToken(token, bytes = SALT_BYTES) {
  if (typeof token !== 'string' || token.length === 0) return false
  try {
    return Buffer.from(token, 'base64').length === bytes
  } catch {
    return false
  }
}

/** True when the parsed message is an encrypted frame (as opposed to a plaintext message).
 *  NOTE: the `hello` message carries an `enc:1` CAPABILITY flag (versioning), so frame
 *  detection must also require the iv/tag/data payload fields — a flag-only `enc:1` is
 *  not a frame. */
function isEncFrame(msg) {
  return !!msg && typeof msg === 'object' && msg.enc === ENC_VER &&
    typeof msg.iv === 'string' && typeof msg.tag === 'string' && typeof msg.data === 'string'
}

/**
 * Encrypt one message object into a wire line (WITHOUT the trailing '\n'):
 * `{"enc":1,"seq":N,"iv":"..","tag":"..","data":".."}` with a fresh random 12-byte IV.
 * @param {Buffer} key - 32-byte session/handshake key
 * @param {object} obj
 * @param {number} [seq] - per-direction message sequence number; session frames MUST carry
 *   it (transport.js enforces strictly-increasing on receive). Omitted for one-shot
 *   handshake frames (pair-accept).
 * @returns {string} line to write
 */
function encryptFrame(key, obj, seq) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error('encryptFrame: key must be a 32-byte Buffer')
  }
  if (seq !== undefined && (!Number.isInteger(seq) || seq < 0)) {
    throw new Error('encryptFrame: seq must be a non-negative integer')
  }
  const iv = crypto.randomBytes(IV_BYTES)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(obj), 'utf8')), cipher.final()])
  return JSON.stringify({
    enc: ENC_VER,
    ...(seq !== undefined ? { seq } : {}),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: enc.toString('base64'),
  })
}

/**
 * Decrypt one encrypted frame back into the message object. Throws on ANY tampering
 * (GCM tag mismatch), wrong key, or malformed frame — callers must sever the connection.
 * @param {Buffer} key
 * @param {object} frame - parsed `{"enc":1,...}` line
 * @returns {object} the decrypted message
 */
function decryptFrame(key, frame) {
  if (!Buffer.isBuffer(key) || key.length !== KEY_BYTES) {
    throw new Error('decryptFrame: key must be a 32-byte Buffer')
  }
  if (!isEncFrame(frame) || typeof frame.iv !== 'string' || typeof frame.tag !== 'string' || typeof frame.data !== 'string') {
    throw new Error('decryptFrame: malformed encrypted frame')
  }
  const iv = Buffer.from(frame.iv, 'base64')
  if (iv.length !== IV_BYTES) throw new Error('decryptFrame: bad IV length')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(Buffer.from(frame.tag, 'base64'))
  const pt = Buffer.concat([decipher.update(Buffer.from(frame.data, 'base64')), decipher.final()])
  return JSON.parse(pt.toString('utf8'))
}

/** Best-effort in-place key zeroization (socket close). GC copies are unreachable. */
function zeroize(buf) {
  if (Buffer.isBuffer(buf)) {
    try { buf.fill(0) } catch { /* noop */ }
  }
}

module.exports = {
  ENC_VER, SALT_BYTES, IV_BYTES, KEY_BYTES,
  deriveSessionKey, createPairEphemeral, deriveHandshakeKey,
  randomToken, isValidToken, isEncFrame,
  encryptFrame, decryptFrame, zeroize,
}
