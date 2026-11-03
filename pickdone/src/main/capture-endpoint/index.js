/**
 * capture-endpoint — main-process wiring for the local HTTP capture door (S4, P0).
 *
 * Boot line (src/main/index.js, one line): require('./capture-endpoint').start()
 *
 * State lives in two MACHINE-LOCAL meta rows ('_'-prefixed → the shared machine-local-keys
 * filter keeps them off every sync egress — a captured secret or the toggle state can never
 * ride LAN/cloud sync to a peer):
 *   '_captureEndpointEnabled' = '1' when the user turned the tab switch on (default absent = OFF)
 *   '_captureEndpointSecret'  = the 48-hex access key (minted by the settings tab on enable),
 *                               stored ENCRYPTED ('enc1:'-prefixed safeStorage blob) whenever
 *                               the OS keyring is available; plaintext fallback otherwise
 *
 * Both are read PER REQUEST, so toggling the switch or regenerating the key in the settings
 * tab takes effect on the next request without a restart. The db may not be open yet at boot —
 * every read guards to fail-closed (disabled / no secret → nothing is reachable).
 *
 * Secret-at-rest: safeStorage encrypts before the value touches meta and decrypts on read
 * (QA defect: the key used to sit in meta as plaintext). Without a usable keyring (early
 * boot, Linux without a keyring) the value falls back to plaintext — the settings tab shows
 * a warning in that case (it can detect the missing 'enc1:' prefix). The settings tab keeps
 * minting the key through the normal bus meta.put (plaintext lands once); the very next
 * getSecret read (per request / at boot) migrates it to the encrypted form.
 */

const db = require('../db')
const { startCaptureServer } = require('./server')

const META_ENABLED_KEY = '_captureEndpointEnabled'
const META_SECRET_KEY = '_captureEndpointSecret'

/** Prefix marking an encrypted-at-rest secret (safeStorage blob, base64). */
const SECRET_ENC_PREFIX = 'enc1:'

/**
 * Resolve the safeStorage to use: an injected one wins (tests); otherwise Electron's, and
 * only when encryption is actually available (null → plaintext fallback).
 */
function resolveSafeStorage (injected) {
  if (injected !== undefined) return injected
  try {
    const { safeStorage } = require('electron')
    if (safeStorage && typeof safeStorage.isEncryptionAvailable === 'function' && safeStorage.isEncryptionAvailable()) {
      return safeStorage
    }
  } catch { /* not in electron main (unit tests): plaintext fallback */ }
  return null
}

/** Encrypt a secret for storage; no/unusable safeStorage → plaintext fallback. */
function encryptSecretValue (plain, safeStorage) {
  if (!safeStorage) return plain
  if (typeof safeStorage.isEncryptionAvailable === 'function' && !safeStorage.isEncryptionAvailable()) return plain
  return SECRET_ENC_PREFIX + Buffer.from(safeStorage.encryptString(plain)).toString('base64')
}

/** Decrypt a stored secret; plaintext values pass through; failures fail closed (null). */
function decryptSecretValue (stored, safeStorage) {
  if (typeof stored !== 'string' || !stored) return null
  if (!stored.startsWith(SECRET_ENC_PREFIX)) return stored // plaintext fallback (or not yet migrated)
  if (!safeStorage) return null // encrypted at rest but no keyring now: fail closed
  try {
    return safeStorage.decryptString(Buffer.from(stored.slice(SECRET_ENC_PREFIX.length), 'base64'))
  } catch {
    return null // corrupt blob: never hand back garbage as the key
  }
}

/**
 * One-shot migration: a plaintext secret row + a usable keyring → re-written encrypted.
 * Injected read/write/safeStorage keep it unit-testable without electron or a real db.
 */
function migrateSecret ({ read, write, safeStorage }) {
  const raw = read()
  if (!raw || typeof raw !== 'string' || raw.startsWith(SECRET_ENC_PREFIX) || !safeStorage) return
  try {
    write(encryptSecretValue(raw, safeStorage))
  } catch { /* keyring hiccup: keep plaintext, retry on next boot */ }
}

function readMeta (key) {
  try {
    if (!db.isOpen()) return null
    const v = db.call('getMeta', key)
    return v == null ? null : String(v)
  } catch {
    return null // closed/re-initializing handle: fail closed
  }
}

function writeMeta (key, value) {
  try {
    // via the bus singleton (same shape as scheduler.js / external-db-watch.js machine-local
    // meta writes): the capture secret is a '_' machine-local key, never a sync egress
    require('../command-bus').commit('meta', 'put', [key, value], { preserveStamp: true })
  } catch { /* fail closed: keep the old value */ }
}

function start (opts = {}) {
  const safeStorage = resolveSafeStorage(opts.safeStorage)
  // memoize the migration per raw value so per-request getSecret calls don't rewrite meta
  let migratedRaw = null
  const migrate = () => {
    const raw = readMeta(META_SECRET_KEY)
    if (raw === migratedRaw) return
    migratedRaw = raw
    migrateSecret({ read: () => raw, write: v => writeMeta(META_SECRET_KEY, v), safeStorage })
  }
  migrate() // encrypt anything plaintext left over from an earlier session
  return startCaptureServer(Object.assign({
    getMeta: k => readMeta(k),
    getSecret: () => {
      migrate() // also covers a key the settings tab minted after boot
      return decryptSecretValue(readMeta(META_SECRET_KEY), safeStorage)
    },
    isEnabled: () => readMeta(META_ENABLED_KEY) === '1'
  }, opts))
}

module.exports = {
  start,
  META_ENABLED_KEY,
  META_SECRET_KEY,
  SECRET_ENC_PREFIX,
  resolveSafeStorage,
  encryptSecretValue,
  decryptSecretValue,
  migrateSecret
}
