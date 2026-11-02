// [w29 P3 / size split] own app version for hello broadcasts, extracted from transport.js.
// Read lazily from package.json (present in dev and inside app.asar); pure Node, no Electron
// import. W29 contract: a failed read is not a VALUE — the cache stays untouched so the next
// call retries (a failed first read used to pin '' permanently).
let _cached = null

function ownAppVersion (load = () => require('../../../package.json').version) {
  if (_cached !== null) return _cached
  try { const v = String(load() || ''); if (v) _cached = v; return v } catch { return '' }
}

function __resetOwnAppVersionForTests () { _cached = null } // test seam only

module.exports = { ownAppVersion, __resetOwnAppVersionForTests }
