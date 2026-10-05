'use strict'
/**
 * S6 (2026-10-03): ONE read-throw/abort-write helper for settings-backed whole-map stores.
 *
 * Root being removed: per-key divergent catch policy. The D15 C1 fix established the contract
 * for sync.peers ONLY (paired-peers.js: a read THROW is not the same as "never paired"; a write
 * must never be derived from a failed read), while the sibling whole-map stores (per-peer
 * watermarks, security ring) still silently defaulted to empty on a failed read — and their
 * unconditional whole-map writers then persisted that empty value OVER the durable row,
 * erasing it on the next persist tick after every restart under a failing read.
 *
 * Contract (identical to paired-peers.js D15 C1):
 *   - load() THROWS when the settings value is unreadable/undecodable. Callers must not derive
 *     a write from a failed read; the helper latches `degraded` until the next SUCCESSFUL load.
 *   - canPersist() is false while degraded: whole-map/array writers gate on it, so a corrupt
 *     read can never shrink/erase the durable row. A later successful load re-arms writes.
 *   - A malformed-but-READABLE value yields the default WITHOUT degrading (absence is a valid
 *     state; only a read failure is not).
 *
 * Injected settings access keeps the bootstrap's swappable module-level `state` (__test.setState)
 * effective, mirroring the paired-peers/peer-extras factory pattern.
 */
module.exports = function createJsonSettingStore ({ settingGet, settingPut, log, key, name, defaultValue, validate }) {
  let degraded = false
  /** Read + decode. Throws on a read/decode failure (S6 contract); malformed-but-readable
   *  values yield the default without degrading. */
  function load () {
    let v
    try { v = JSON.parse(settingGet(key) || defaultValue) } catch (e) {
      degraded = true
      throw new Error(name + ' read failed (refusing to derive a write from it): ' + (e && e.message))
    }
    // D22 (P2 2026-10-03) latch-clear fix: the read+decode SUCCEEDED here, so the earlier
    // failure latch must be cleared regardless of what validate() says next. The old order ran
    // the validate early-return BEFORE the clear, so once degraded (e.g. one transient read
    // throw) a subsequent readable-but-invalid value kept the store latched forever — the
    // validate-fail path never re-entered normal mode. Clearing on decode success matches the
    // documented malformed-but-readable policy: that value may yield the default, and writes
    // re-arm (the write is derived from a SUCCESSFUL read, never from the failed one).
    degraded = false
    if (validate && !validate(v)) return JSON.parse(defaultValue)
    return v
  }
  /** False while the live value was derived from a FAILED read — writers must abort. */
  function canPersist () { return !degraded }
  /** Force the degraded latch (e.g. a boot seed caught the load throw itself). */
  function markDegraded () { degraded = true }
  /** Persist one whole value; aborts while degraded (never derive a write from a failed read). */
  function persist (value) {
    if (degraded) {
      log.warn('[LanSync] ' + name + ' persist SKIPPED — the live value was seeded from a failed settings read (no write is ever derived from a failed read)')
      return false
    }
    try { settingPut(key, JSON.stringify(value)); return true } catch (e) { log.warn('[LanSync] ' + name + ' persist failed:', e.message); return false }
  }
  return { load, canPersist, markDegraded, persist, get key () { return key } }
}
