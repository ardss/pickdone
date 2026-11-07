'use strict'
/**
 * Cross-platform bridge bootstrap — the Electron main wiring (Lane A, 2026-11-07).
 *
 * DISABLED BY DEFAULT: the HTTP bridge only listens when the desktop meta key
 * `crossplatform.enabled` === '1' AND the caller invokes start (wired behind the
 * sync settings surface — no boot-time listener is added here). Binding is
 * 127.0.0.1 ONLY; the port is ephemeral unless a caller pins one.
 *
 * Persisted state lives in the existing db meta table via db.call (getMeta/setMeta)
 * — pairing secret, session nonce and token revocations survive desktop restarts,
 * which keeps valid mobile/web tokens valid across restarts and revocations sticky.
 *
 * The security stack is the one from 85d5f3c1 (one-shot pairing challenge, scoped
 * HMAC capability tokens, AuthGate origin/CSRF/replay/rate/scope); no second
 * transport, no direct SQL surface, no commands on the wire.
 */

const { createDesktopRepo } = require('./desktop-repo')

const META_PREFIX = 'crossplatform.'
const ENABLED_KEY = `${META_PREFIX}enabled`
const LAN_ENABLED_KEY = `${META_PREFIX}lanEnabled`
const SECRET_KEY = `${META_PREFIX}pairingSecret`
const NONCE_KEY = `${META_PREFIX}sessionNonce`
const REVOCATIONS_KEY = `${META_PREFIX}revocations`
const DEVICES_KEY = `${META_PREFIX}devices`

let singleton = null

function metaStore (dbCall, key, decode, encode) {
  const dec = decode || (v => v)
  const enc = encode || (v => String(v))
  return {
    load: () => {
      try {
        const row = dbCall('getMeta', key)
        const raw = row && row.value != null ? row.value : (typeof row === 'string' ? row : null)
        return raw != null ? dec(raw) : null
      } catch { return null }
    },
    save: v => { dbCall('setMeta', { key, value: enc(v) }) }
  }
}

function readMetaFlag (dbCall, key) {
  try {
    const row = dbCall('getMeta', key)
    const v = row && row.value != null ? row.value : (typeof row === 'string' ? row : null)
    return v === '1'
  } catch { return false }
}

function isBridgeEnabled (dbCall) {
  return readMetaFlag(dbCall, ENABLED_KEY)
}

/**
 * LAN exposure: the bridge binds 127.0.0.1 unless the user EXPLICITLY enabled LAN
 * access in the settings page (meta crossplatform.lanEnabled === '1'). Default-off.
 */
function isLanEnabled (dbCall) {
  return readMetaFlag(dbCall, LAN_ENABLED_KEY)
}

/**
 * Start the bridge if (and only if) the user enabled it.
 * @param {Function} getDbCall () => (op, params) => result — lazy db access
 * @param {object} opts { port?, allowedOrigins?, log? }
 * @returns {Promise<{started:boolean, reason?:string, port?:number, bridge?:object}>}
 */
async function startCrossPlatformBridge (getDbCall, opts = {}) {
  const dbCall = getDbCall()
  if (!isBridgeEnabled(dbCall)) {
    return { started: false, reason: 'disabled (sync.crossPlatform not enabled by the user)' }
  }
  if (singleton && singleton.port != null) {
    return { started: true, port: singleton.port, bridge: singleton }
  }
  const { CrossPlatformBridge } = await import('./http-bridge.mjs')
  const bridge = new CrossPlatformBridge({
    repo: createDesktopRepo(dbCall),
    stores: {
      pairingSecret: metaStore(dbCall, SECRET_KEY),
      sessionNonce: metaStore(dbCall, NONCE_KEY),
      revocations: metaStore(dbCall, REVOCATIONS_KEY),
      devices: metaStore(dbCall, DEVICES_KEY, v => JSON.parse(v || '[]'), v => JSON.stringify(v))
    },
    allowedOrigins: opts.allowedOrigins || [],
    bindAddress: isLanEnabled(dbCall) ? '0.0.0.0' : '127.0.0.1',
    log: opts.log
  })
  const listening = await bridge.start({ port: opts.port || 0 })
  singleton = bridge
  return { started: true, port: listening.port, bridge }
}

async function stopCrossPlatformBridge () {
  if (!singleton) return
  await singleton.close()
  singleton = null
}

/** Desktop settings/UI surface: mint a one-time challenge for the displayed code. */
function issuePairing (deviceId, { scope } = {}) {
  if (!singleton || singleton.port == null) throw new Error('cross-platform bridge is not running')
  return singleton.issuePairing(deviceId, scope ? { scope } : undefined)
}

/** Desktop settings/UI surface: unpair (revoke every token of a device). */
function revokeDevice (deviceId) {
  if (!singleton) throw new Error('cross-platform bridge is not running')
  singleton.revokeDevice(deviceId)
}

function setBridgeEnabled (dbCall, enabled) {
  dbCall('setMeta', { key: ENABLED_KEY, value: enabled ? '1' : '0' })
  // disabling the bridge tears the LAN exposure with it (safer default on re-enable)
  if (!enabled) dbCall('setMeta', { key: LAN_ENABLED_KEY, value: '0' })
}

function setLanEnabled (dbCall, enabled) {
  if (!isBridgeEnabled(dbCall)) throw new Error('enable cross-platform sync before enabling LAN access')
  dbCall('setMeta', { key: LAN_ENABLED_KEY, value: enabled ? '1' : '0' })
}

/** Settings surface: full sanitized snapshot (running, port, bind, devices, lastError). */
function getStatus (dbCall) {
  if (!singleton || singleton.port == null) {
    return { running: false, enabled: isBridgeEnabled(dbCall), lanEnabled: isLanEnabled(dbCall), devices: (metaStore(dbCall, DEVICES_KEY, v => JSON.parse(v || '[]')).load() || []), lastError: null }
  }
  const st = singleton.status()
  st.enabled = isBridgeEnabled(dbCall)
  st.lanEnabled = isLanEnabled(dbCall)
  return st
}

module.exports = {
  startCrossPlatformBridge,
  stopCrossPlatformBridge,
  issuePairing,
  revokeDevice,
  setBridgeEnabled,
  setLanEnabled,
  getStatus,
  isBridgeEnabled,
  isLanEnabled,
  __keys: { ENABLED_KEY, LAN_ENABLED_KEY, SECRET_KEY, NONCE_KEY, REVOCATIONS_KEY, DEVICES_KEY },
  __metaStore: metaStore
}
