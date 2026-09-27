'use strict'

/**
 * 2026-09-27 Device Center surfacing (read-only): summarize the machine-local flush quarantine
 * (sync.flushQuarantine.<op> blobs written by sync-apply.quarantineFlushRows). One entry per
 * parked op: { op, key, entries, count, lastAt, lastError }. Persisted in meta, so it stays
 * visible across restarts; a summary failure degrades to [] and never blocks getStatus.
 * Extracted from lan-sync-bootstrap.js to hold that file under its size ratchet.
 */
const { META_FLUSH_QUARANTINE_PREFIX } = require('./sync-apply')

function summarizeFlushQuarantine (db) {
  const out = []
  try {
    const keys = (db.call('listMetaKeys') || [])
      .filter(k => String(k).startsWith(META_FLUSH_QUARANTINE_PREFIX))
      .sort()
    for (const key of keys) {
      const op = String(key).slice(META_FLUSH_QUARANTINE_PREFIX.length)
      let parked = []
      try { parked = JSON.parse(db.call('getMeta', String(key)) || '[]') } catch { /* unreadable blob: degrade to empty list for this op */ }
      if (!Array.isArray(parked)) parked = []
      const last = parked[parked.length - 1] || {}
      out.push({
        op,
        key: String(key),
        entries: parked.length,
        count: parked.reduce((n, e) => n + ((e && e.count) || 0), 0),
        lastAt: (last && last.at) || null,
        lastError: String((last && last.error) || '').slice(0, 120),
      })
    }
  } catch { /* quarantine surfacing must never break getStatus */ }
  return out
}

module.exports = { summarizeFlushQuarantine }

/** Pending inbound pair request surfaced to the renderer (contract: renderer reads
 *  status.pendingPair on mount and shows the confirm dialog; syncPairRespond answers it). */
function pendingPairPayload (p) {
  if (!p || typeof p.respond !== 'function') return null
  return { deviceId: p.deviceId || null, deviceName: p.deviceName || null, host: p.host || null, at: p.at || Date.now() }
}

module.exports.pendingPairPayload = pendingPairPayload
