'use strict'
/**
 * Sync v2 revision/DVV/adjudicate introspection + flag ops (structure-size ratchet move from
 * db.js, S2/S4 — verbatim logic, `db` swapped for an injected handle getter).
 *
 * Machine-local by design: deliberately NOT in WRITE_OPS (flipping a flag is never
 * oplog-captured or synced to peers) and NOT in the renderer ALLOWED_RENDERER_OPS whitelist
 * (main-internal + CLI only, like the sync.* settings namespace).
 *
 * Flag model (double opt-in, S2/S4 precedent):
 *   sync.revisions.v2              — base: record one immutable revision per write (default OFF)
 *   sync.revisions.v2.dvv          — S2: persist dotted version vectors (default OFF)
 *   sync.revisions.v2.adjudicate   — S4: user-visible delete-vs-edit rulings (default OFF)
 * Sub-flags only matter while the base flag is on; every flip back restores byte-identical
 * legacy behavior (persisted sub-flag data stays on disk, inert).
 */
module.exports = function registerRevisionsOps (OPS, revisions, getDb) {
  OPS.revisionsList = p => revisions.list(p && p.entityId, p && p.limit)
  OPS.revisionsFlag = p => {
    const d = getDb()
    if (!d || !d.open) throw new Error('db closed')
    const on = !!(p && p.on)
    d.prepare('INSERT INTO settings_rows (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(revisions.FLAG_KEY, on ? '1' : '0')
    return { on }
  }
  // `dvv` (S2) and `adjudicate` (S4) are the opt-in sub-flag states (default false) —
  // additive introspection fields.
  OPS.revisionsFlagState = () => ({
    on: revisions.flagEnabled(getDb()),
    dvv: revisions.dvvFlagEnabled(getDb()),
    adjudicate: revisions.adjudicateFlagEnabled(getDb()),
  })
  OPS.revisionsFlagDvv = p => {
    const d = getDb()
    if (!d || !d.open) throw new Error('db closed')
    const on = !!(p && p.on)
    d.prepare('INSERT INTO settings_rows (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(revisions.DVV_FLAG_KEY, on ? '1' : '0')
    return { on }
  }
  OPS.revisionsFlagAdjudicate = p => {
    const d = getDb()
    if (!d || !d.open) throw new Error('db closed')
    const on = !!(p && p.on)
    d.prepare('INSERT INTO settings_rows (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(revisions.ADJUDICATE_FLAG_KEY, on ? '1' : '0')
    return { on }
  }
  // S2 unified causal READ seam (main-internal like revisionsList, deliberately NOT in the
  // renderer whitelist): the real sync-core store over the persisted DAG, dvv attached when
  // the sub-flag is on. Read-only — never in WRITE_OPS, so it can never be oplog-captured.
  OPS.revisionsStoreSnapshot = () => revisions.exportStore()
}
