'use strict'
/* Paired-peer table persistence + host address hygiene (Round-1 P0, 2026-09-21).
 * Extracted verbatim from lan-sync-bootstrap.js for the structure size ratchet —
 * behavior identical. Settings access and limits are injected by the bootstrap so
 * the module-level swappable `state` (tests use __test.setState) keeps working. */
module.exports = function createPairedPeers ({ settingGet, settingPut, log, isDialableHost, DEFAULT_PORT, K_PAIRED_PEERS }) {
  /** Normalize a wire/host address to a dialable form: strip IPv4-mapped IPv6 (::ffff:a.b.c.d);
   *  return null for junk (scope-less link-local, 169.254.*, virtual ranges). */
  function normalizeHost (host) {
    let h = String(host || '').trim()
    if (h.startsWith('::ffff:')) h = h.slice(7)
    return isDialableHost(h) ? h : null
  }
  function loadPairedPeers () {
    try {
      const v = JSON.parse(settingGet(K_PAIRED_PEERS) || '{}')
      return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}
    } catch { return {} }
  }
  /** Merge a peer record keyed by deviceId. Writes ONLY on a real change (connection events fire
   *  per dial — this must not turn into a settings-table write amplifier). Returns true when written. */
  function persistPairedPeer (entry) {
    try {
      if (!entry || !entry.deviceId || typeof entry.deviceId !== 'string') return false
      const all = loadPairedPeers()
      const prev = all[entry.deviceId] || {}
      const next = {
        deviceId: entry.deviceId,
        name: entry.name || prev.name || entry.deviceId,
        // ACTUAL TCP address first (the caller passes socket remote addresses), previous value as
        // fallback; undialable junk never overwrites a working address.
        host: normalizeHost(entry.host) || prev.host || null,
        port: (Number.isInteger(entry.port) && entry.port > 0 && entry.port <= 65535) ? entry.port : (prev.port || DEFAULT_PORT),
        pairedAt: prev.pairedAt || Date.now(),
      }
      if (prev.host === next.host && prev.port === next.port && prev.name === next.name) return false
      all[entry.deviceId] = next
      settingPut(K_PAIRED_PEERS, JSON.stringify(all))
      return true
    } catch (e) { log.warn('[LanSync] paired-peer persist failed:', e.message); return false }
  }
  function removePairedPeer (deviceId) {
    try {
      const all = loadPairedPeers()
      if (all[deviceId]) { delete all[deviceId]; settingPut(K_PAIRED_PEERS, JSON.stringify(all)) }
    } catch (e) { log.warn('[LanSync] paired-peer remove failed:', e.message) }
  }
  return { normalizeHost, loadPairedPeers, persistPairedPeer, removePairedPeer }
}
