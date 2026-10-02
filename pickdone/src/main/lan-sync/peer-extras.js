/* Peer display alias + missing-attachment key collection, extracted from lan-sync-bootstrap.js
 * (2026-09-25 structure size ratchet) — same injected-settings pattern as lan-sync/paired-peers.js,
 * so the swappable module-level `state`/settings (bootstrap __test.setState) still applies. */
module.exports = ({ settingGet }) => {
  /* ---------- per-peer machine-local display alias (round-2 P1) ---------- */
  const K_PEER_ALIAS_PREFIX = 'sync.peerAlias.'
  function peerAliasOf (deviceId) {
    if (!deviceId) return null
    const v = settingGet(K_PEER_ALIAS_PREFIX + String(deviceId))
    const s = typeof v === 'string' ? v.trim().slice(0, 40) : ''
    return s || null
  }

  /* ---------- Round-2 P1 (F7, 2026-09-21): missing-attachment key collection ----------
   * Only LIVE todos may re-pull files: getAll({deleted:null}) returned ALL rows including
   * recycle-bin tombstones, so a deleted todo's files were re-requested from the peer every
   * round forever (orphans GC on hard purge). Injectable existsFn/attachDir for tests.
   *
   * perf fix (2026-10-02, d15 att-missing-keys-full-scan-per-round): the collection ran a full
   * live-table getAll + per-row JSON.parse + per-key fs.existsSync on EVERY round (maybeStart →
   * opts.getKeys()). Memoize the result on the max oplog seq: every applied/local row is itself
   * change-captured into the oplog, so the live todo set can only change when the seq advances.
   * A stale key list is benign at consume time — the puller skips keys that already exist on
   * disk (att-transfer maybeStart d.exists check) and att transfers do not append to the oplog. */
  let missingCache = { seq: null, keys: null }
  function missingAttachmentKeys (st, inject = {}) {
    try {
      const fs = require('node:fs')
      const path = require('node:path')
      const { collectMissingKeys } = require('./att-transfer')
      const seq = require('../sync-apply').readMaxOplogSeq(st)
      if (missingCache.seq === seq && missingCache.keys) return missingCache.keys
      const dir = inject.attachDir || require('../attachments').attachDir()
      const exists = inject.existsSync || (key => fs.existsSync(path.join(dir, path.basename(String(key)))))
      const keys = collectMissingKeys(st.db.call('getAll', { deleted: 0 }), exists)
      missingCache = { seq, keys }
      return keys
    } catch { return [] }
  }

  return { K_PEER_ALIAS_PREFIX, peerAliasOf, missingAttachmentKeys }
}
