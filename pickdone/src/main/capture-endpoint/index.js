/**
 * capture-endpoint — main-process wiring for the local HTTP capture door (S4, P0).
 *
 * Boot line (src/main/index.js, one line): require('./capture-endpoint').start()
 *
 * State lives in two MACHINE-LOCAL meta rows ('_'-prefixed → the shared machine-local-keys
 * filter keeps them off every sync egress — a captured secret or the toggle state can never
 * ride LAN/cloud sync to a peer):
 *   '_captureEndpointEnabled' = '1' when the user turned the tab switch on (default absent = OFF)
 *   '_captureEndpointSecret'  = the 48-hex access key (minted by the settings tab on enable)
 *
 * Both are read PER REQUEST, so toggling the switch or regenerating the key in the settings
 * tab takes effect on the next request without a restart. The db may not be open yet at boot —
 * every read guards to fail-closed (disabled / no secret → nothing is reachable).
 */

const db = require('../db')
const { startCaptureServer } = require('./server')

const META_ENABLED_KEY = '_captureEndpointEnabled'
const META_SECRET_KEY = '_captureEndpointSecret'

function readMeta (key) {
  try {
    if (!db.isOpen()) return null
    const v = db.call('getMeta', key)
    return v == null ? null : String(v)
  } catch {
    return null // closed/re-initializing handle: fail closed
  }
}

function start (opts = {}) {
  return startCaptureServer(Object.assign({
    getMeta: k => readMeta(k),
    getSecret: () => readMeta(META_SECRET_KEY),
    isEnabled: () => readMeta(META_ENABLED_KEY) === '1'
  }, opts))
}

module.exports = { start, META_ENABLED_KEY, META_SECRET_KEY }
