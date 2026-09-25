/**
 * Extracted from src/main/db.js (structure-size ratchet): per-task meta-key GC helpers used by
 * the hard-delete/purge transactions. Factory takes a live `db` getter (same pattern as
 * db-bulk-ops) — moved verbatim, no behavior change.
 */

module.exports = (getDb) => ({
  // main-ipc-3 unbounded-key fix (2026-09-22): snowDedup:<taskId>:<dedupKey> meta keys are written
  // once per focus session (bumpSnow idempotency fence) and previously had NO cleanup path — they
  // accumulated linearly forever, and survived even after the owning task was hard-deleted or its
  // recycle-bin row purged (the startup meta GC's family list never covered them either). Purge the
  // owning task's keys inside the SAME delete transaction. Range predicate instead of LIKE: task
  // ids are renderer-supplied and % / _ in an id would silently widen a LIKE pattern.
  deleteSnowDedupKeysFor (ids) {
    for (const id of ids) {
      const prefix = `snowDedup:${String(id)}:`
      getDb().prepare('DELETE FROM meta WHERE key >= ? AND key < ?').run(prefix, prefix + ';')
    }
  },
  // planChipsSnapshot meta lifecycle (parity with deleteSnowDedupKeysFor): the renderer mints a
  // `planChipsSnapshot:<taskId>` meta key per task with schedule chips (restoreSnapshot reads it
  // back). When the owning rows die here, the snapshot can never be restored — the key is a
  // permanent meta orphan (the CLI purge already deletes these keys for the same reason: a later
  // taskId collision could resurrect a stale chip set). Exact-key delete: ids never contain the
  // `planChipsSnapshot:` prefix shape collision risk (one row per task).
  deleteChipsSnapshotKeysFor (ids) {
    for (const id of ids) {
      getDb().prepare("DELETE FROM meta WHERE key = 'planChipsSnapshot:' || ?").run(String(id))
    }
  }
})
