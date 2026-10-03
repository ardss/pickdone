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
 * disk (att-transfer maybeStart d.exists check) and att transfers do not append to the oplog.
 *
 * D15 C10 (2026-10-03): the seq key has two PROVEN blind spots — (a) sync-ack echo rows
 * (commitSyncBatch's excluded-from-oplog-capture writes) and (b) attachment-file deletions on
 * disk (no todo row changes, no oplog append) — both left the memo stale FOREVER, so files
 * whose rows said "have it" stayed on the "missing" list indefinitely (and vice versa). The
 * memo is now TTL-bounded (MISSING_CACHE_TTL_MS): beyond the window it recomputes even at an
 * unchanged seq. The invariant is therefore: "the live todo set can only change when the seq
 * advances OR the TTL expires" — seq-only memoization was not an invariant. */
const MISSING_CACHE_TTL_MS = 1000
let missingCache = { seq: null, keys: null, at: 0 }
function missingAttachmentKeys (st, inject = {}) {
  try {
    const fs = require('node:fs')
    const path = require('node:path')
    const { collectMissingKeys } = require('./att-transfer')
    const now = inject.now || Date.now
    const seq = require('../sync-apply').readMaxOplogSeq(st)
    if (missingCache.seq === seq && missingCache.keys && now() - missingCache.at < MISSING_CACHE_TTL_MS) return missingCache.keys
    const dir = inject.attachDir || require('../attachments').attachDir()
    const exists = inject.existsSync || (key => fs.existsSync(path.join(dir, path.basename(String(key)))))
    const keys = collectMissingKeys(st.db.call('getAll', { deleted: 0 }), exists)
    missingCache = { seq, keys, at: now() }
    return keys
  } catch { return [] }
}

  return { K_PEER_ALIAS_PREFIX, peerAliasOf, missingAttachmentKeys }
}
