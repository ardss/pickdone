'use strict'
/**
 * S3 (2026-10-03): ONE owner for the 'sync.peerWatermarks.v2' store — load, advance, revoke,
 * reinstate, persist, invalidate. Replaces three uncoordinated writers (unpair point-delete,
 * recovery whole-clear, whole-map persist at round/stop boundaries) plus an independent
 * insertion point (client-round's in-flight ack writing peerProgress.set into the shared Map).
 *
 * Root being removed: point invalidation had no structural protection against the whole-map
 * writer. stopSync awaits n.stop() (which yields the event loop), so an already-buffered ack
 * from the still-authenticated in-flight round could re-insert the unpaired deviceId AFTER the
 * unpair delete; stopSync's settle-point then persisted the WHOLE Map back into the settings
 * row, resurrecting the deleted watermark — a stale push watermark suppresses re-push of rows
 * <= that seq on re-pair (the exact data-loss class the P1-6 recovery fix exists to prevent
 * for the invalidate case; sync-matrix.md §5.3).
 *
 * Contract encoded once at this ownership point (not by call-site discipline):
 *   - revoke(deviceId) marks the id REVOKED (persisted alongside the map, so a restart inside
 *     the window cannot lose it) and drops it from the live map.
 *   - advance (the overridden Map.set) DROPS a revoked id: the in-flight-ack insertion point is
 *     filtered here, so stopSync's whole-map flush physically cannot write it back.
 *   - raw() excludes revoked ids from persistence.
 *   - Revocation is cleared ONLY by reinstate(deviceId), wired to a successful persistPairedPeer
 *     — the real pairing event both pairing ops and paired-inbound funnel through.
 *   - invalidate() (P1-6 recovery) clears every live watermark but KEEPS revocations: a revoked
 *     pairing must not resurrect via recovery either.
 *   - Load follows the S6 read-throw/abort-write contract (settings-map-store.js): a failed
 *     read throws / degrades persistence instead of silently seeding an empty map that the
 *     whole-map writer would then persist over the durable row.
 */
const REVOKED = '__revoked'

/** [w30 size split] v1 watermark cleanup (round-3 review): the pre-v2 'sync.peerWatermarks'
 *  row is dead data in the RECEIVER's seq space (v2 lives under key + '.v2'); delete it once.
 *  Caller supplies the settings seams; failures are warn-only. */
function deleteV1WatermarkRow ({ settingGet, settingsRowDelete, log }) {
  try {
    if (settingGet('sync.peerWatermarks') != null) {
      settingsRowDelete('sync.peerWatermarks')
      log.warn('[LanSync] v1 watermark cleanup: legacy row removed')
    }
  } catch (e) { try { log.warn('[LanSync] v1 watermark cleanup failed:', e.message) } catch { /* noop */ } }
}

module.exports = function createPeerWatermarkStore ({ settingGet, settingPut, log, key, store }) {
  /** Read + decode. THROWS on a read failure (S6). Returns { map, revoked }. */
  function load () {
    const v = store.load()
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { map: {}, revoked: [] }
    const revoked = Array.isArray(v[REVOKED]) ? v[REVOKED].map(String) : []
    const map = {}
    for (const [k, val] of Object.entries(v)) {
      if (k === REVOKED) continue
      map[k] = Number(val) || 0
    }
    return { map, revoked }
  }

  /** The live Map the node reads as peerProgress, with every writer funneled through the store. */
  function createTracked () {
    let seeded
    try {
      seeded = load()
    } catch (e) {
      // S6: a failed boot read degrades persistence for the process — persist() will skip
      // rather than write an empty map derived from the failed read over the durable row.
      log.warn('[LanSync] ' + e.message)
      seeded = { map: {}, revoked: [] }
      store.markDegraded()
    }
    const revoked = new Set(seeded.revoked)
    const m = new Map(Object.entries(seeded.map))
    m.raw = () => {
      const out = Object.fromEntries(m)
      if (revoked.size) out[REVOKED] = Array.from(revoked)
      return out
    }
    // S3: the advance path (client-round acks write peerProgress.set) filtered at the single
    // ownership point — a revoked (unpaired/invalidated) id can never be re-inserted.
    m.set = (k, v) => {
      const id = String(k)
      if (revoked.has(id)) return m
      return Map.prototype.set.call(m, id, Number(v) || 0)
    }
    /** Revoke a pairing's watermark (unpair / invalidate). Persisted with the next flush. */
    m.revoke = (id) => { revoked.add(String(id)); Map.prototype.delete.call(m, String(id)) }
    /** Clear revocation — wired to a SUCCESSFUL persistPairedPeer (the real pairing event). */
    m.reinstate = (id) => { revoked.delete(String(id)) }
    m.isRevoked = (id) => revoked.has(String(id))
    return m
  }

  /** Whole-map persist; aborts while the store is degraded (S6) or on a write failure.
   *  Tolerates a plain Map (legacy hosts/tests) — revoked filtering simply does not exist there. */
  function persist (m) { return store.persist(m ? (typeof m.raw === 'function' ? m.raw() : Object.fromEntries(m)) : {}) }

  /** P1-6 recovery: drop every LIVE watermark (full re-push next round); revocations survive. */
  function invalidate (m) {
    if (m) Map.prototype.clear.call(m)
    return persist(m)
  }

  return { load, createTracked, persist, invalidate, REVOKED }
}

module.exports.deleteV1WatermarkRow = deleteV1WatermarkRow

/** [w30 size split] test surface moved here from lan-sync-bootstrap: the same store wiring over
 *  an INJECTED db handle, so regression tests can drive corrupt-read/degraded-persist scenarios
 *  against a fresh settings table without swapping the module-level state singleton. */
function makeWatermarkStoresForDb (db, deps = {}) {
  const get = key => { const row = db.call('settingsRowsAll', {}).find(r => r.key === key && !r.deleted); return row ? row.value : null }
  const put = (key, value) => db.call('settingsRowPut', { key, value })
  const store = deps.createJsonSettingStore({ settingGet: get, settingPut: put, log: deps.log, key: deps.key, name: 'peer watermarks', defaultValue: '{}' })
  return { store, wm: module.exports({ settingGet: get, settingPut: put, log: deps.log, key: deps.key, store }) }
}
module.exports.makeWatermarkStoresForDb = makeWatermarkStoresForDb
