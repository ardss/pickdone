/* X4 (2026-09-20): user recovery path for machine-local meta LWW conflict backups.
 * metaConflictBackup.* keys (written by sync-apply.writeMetaConflictBackup, P1-5) were
 * write-only: correct to keep out of sync, but unrecoverable by users. These two ops are
 * registered via db-sync-ops (see lan-sync-bootstrap registerOps) and exposed to the renderer
 * through the todo-db:call whitelist; the UI surface lives in the renderer (agent Y).
 * Separate module so lan-sync-bootstrap.js stays under its size ratchet. */
const META_CONFLICT_BACKUP_PREFIX = 'metaConflictBackup.'
const PREVIEW_MAX = 200

/* B16 follow-up (P0, 2026-09-25): since B16 the apply path also backs up NON-meta losers under
 * `metaConflictBackup.<entity>:<id>.<ts36>` with the FULL RAW ROW as the value (see the else
 * branch in sync-apply.js applyRowInner). Restoring those used to go through setMeta, so db.js's
 * String(v) coercion wrote the literal '[object Object]' into meta, the unique lost row was
 * never returned to its table, and the backup key was then deleted — unrecoverable corruption.
 * The restore now routes by key prefix: an `<entity>:<id>` original key whose entity has a
 * registered bulk-write command is restored INTO ITS NATIVE TABLE via that command; only true
 * meta keys go through setMeta. The routing table is derived from the command manifest (single
 * source — never a hand-copied prefix list). Old-format backups (bare key + object value, no
 * structured entity/id fields on the write side) resolve through the same prefix parse.
 * CONVENTION to guard (review 2026-09-25): user-data META keys must never be named
 * `<syncable-entity>:` — the prefix IS the routing decision here. If a future meta key ever
 * needs such a shape, move the write side to structured entity/id fields first. */
const manifest = require('./command-manifest')
/* Entities whose losers B16 backs up (the applyRowInner else branch): setting rides the SAME
 * putMany command shape as plan/filter/category/tomato — the entity list is exactly the manifest
 * commands with verb putMany/appendMany, so no entity can be dropped by a hand-maintained list
 * again (review round 3: 'setting' was missing and its restores corrupted to '[object Object]'). */
const ENTITY_RESTORE_OPS = (() => {
  const m = Object.create(null)
  for (const row of Object.values(manifest.COMMANDS)) {
    if (!row || (row.verb !== 'putMany' && row.verb !== 'appendMany')) continue
    if (['plan', 'filter', 'category', 'tomato', 'setting'].includes(row.entity)) m[row.entity] = row.op
  }
  return m
})()
/* Post-write read-back probes per entity: the bulk ops SILENTLY skip malformed rows
 * (planAddMany drops bad day/mm, tomatoAppendMany/rowPutMany park bad rows in `rejected`,
 * upsertCategoryMany/filterUpsertMany suppress no-changes) — a blind backup-key delete after
 * the call could destroy the only surviving copy of a row that never landed. */
const ENTITY_READBACK = {
  plan: (call, id) => (call('planAll') || []).some(r => String(r.id) === id),
  filter: (call, id) => (call('filterList') || []).some(r => String(r.id) === id),
  category: (call, id) => (call('categoriesAllRows') || []).some(r => String(r.id) === id && !r.deleted),
  tomato: (call, id) => (call('tomatoAll') || []).some(r => String(r.tomatoId) === id),
  setting: (call, id) => (call('settingsRowsAll') || []).some(r => r.key === id && !r.deleted)
}
/* C8 (2026-09-25): fetch the CURRENT winning row (raw) per entity — same sources as the
 * readback probes but returning the row itself, so the restore can re-backup the row it is
 * about to overwrite. Read-only probes; a missing row returns null (nothing to re-backup).
 * Tombstone-winner fix (2026-09-26): the `!r.deleted` filters contradicted the module's own C8
 * invariant ("snapshot the current winner BEFORE the bulk write") — when the winner was a
 * TOMBSTONE (deleted row), current read as null, no re-backup was minted, and the restore write
 * silently erased the deletion mark. Now tombstone winners are snapshotted too:
 *   - category/setting: the raw table reads (categoriesAllRows / settingsRowsAll) already carry
 *     tombstones — the filter is simply dropped (no new read op, pruneBackups bounds growth).
 *   - plan/filter: fallback to the M3 tombstone reads (planTombstones/filterTombstones) when the
 *     live probe misses. DEBATABLE PART (documented, not invented around): those reads carry only
 *     id/updatedAt/deletedAt, so the snapshot is a PARTIAL row — it faithfully records THAT A
 *     DELETION was overwritten (and its stamps), but it is not a full row: re-restoring it is
 *     refused by the bulk op's row validation (refuse-to-lose keeps the original backup). A
 *     fuller tombstone shape would need a schema change — deliberately out of scope here.
 *   - tomato: KNOWN GAP — no raw tombstone read exists for tomato_records (tomatoAll filters
 *     deleted=0 and there is no tomatoTombstones read op wired into db.call), so a tomato
 *     tombstone winner still yields no re-backup. Same reversibility gap as before this fix,
 *     scoped unchanged; add the read op before extending this table. */
const ENTITY_CURRENT_ROW = {
  plan: (call, id) => (call('planAll') || []).find(r => String(r.id) === id) ||
    (call('planTombstones') || []).find(r => String(r.id) === id) || null,
  filter: (call, id) => (call('filterList') || []).find(r => String(r.id) === id) ||
    (call('filterTombstones') || []).find(r => String(r.id) === id) || null,
  category: (call, id) => (call('categoriesAllRows') || []).find(r => String(r.id) === id) || null,
  tomato: (call, id) => (call('tomatoAll') || []).find(r => String(r.tomatoId) === id) || null,
  setting: (call, id) => (call('settingsRowsAll') || []).find(r => r.key === id) || null
}

function parseBackup (raw) {
  try { const o = JSON.parse(raw); if (o && typeof o === 'object' && !Array.isArray(o)) return o } catch { /* unreadable payload surfaces as skipped/err below */ }
  return null
}

/* Wave-B P3 prune, shared: re-backups (meta AND entity branches since C8) honor the same
 * 20-per-key cap as the apply path's writeMetaConflictBackup — repeated restore/re-conflict
 * cycles must not grow metaConflictBackup.<key>.* forever. Best-effort by design. */
function pruneBackups (call, originalKey) {
  try {
    const prefix = META_CONFLICT_BACKUP_PREFIX + originalKey + '.'
    const keys = (call('listMetaKeys') || []).map(String).filter(k => k.startsWith(prefix)).sort()
    for (const old of keys.slice(0, Math.max(0, keys.length - 20))) {
      try { call('deleteMeta', old) } catch { /* prune is best-effort */ }
    }
  } catch { /* prune is best-effort */ }
}

module.exports = {
  /** Returns the two renderer-callable ops bound to a dbCall accessor: dbCall() -> (op, params) => any */
  ops (dbCall) {
    const call = (op, p) => dbCall()(op, p)
    return {
      /** LIST machine-local backups: [{ key, originalKey, lostAt, preview }] — value exposed only
       *  as a <=200-char preview so a huge lost blob cannot flood the renderer in one payload. */
      syncConflictBackupsList: () => {
        const out = []
        const keys = (call('listMetaKeys') || []).filter(k => String(k).startsWith(META_CONFLICT_BACKUP_PREFIX)).sort()
        for (const key of keys) {
          const b = parseBackup(call('getMeta', key))
          if (!b || b.key == null) continue
          // 发现12: entity backups carry an OBJECT value — String() rendered every one of them
          // as '[object Object]' in the recovery UI. JSON-summarize object values instead.
          const value = (b.value && typeof b.value === 'object') ? JSON.stringify(b.value) : String(b.value == null ? '' : b.value)
          out.push({ key: String(key), originalKey: String(b.key), lostAt: Number(b.lostAt) || 0, preview: value.slice(0, PREVIEW_MAX) })
        }
        return out
      },
      /** RESTORE one backup: re-apply the lost value to its original key. The CURRENT live value is
       *  re-backed-up first (a restore is itself reversible), then the backup key is deleted. The
       *  re-applied setMeta is captured by the regular oplog, so it syncs like any local edit. */
      syncConflictBackupRestore: p => {
        const key = String((p && p.key) || '')
        if (!key.startsWith(META_CONFLICT_BACKUP_PREFIX)) throw new Error('syncConflictBackupRestore: not a metaConflictBackup key')
        const b = parseBackup(call('getMeta', key))
        if (!b || b.key == null) throw new Error('syncConflictBackupRestore: backup payload unreadable')
        const originalKey = String(b.key)
        // P0 branch: an `<entity>:<id>` original key restores into the entity's NATIVE table
        // (plan_chips / filters / categories / tomato_records) through the manifest-derived bulk
        // upsert op — never through setMeta (whose String(v) coercion corrupted the value to
        // '[object Object]' and then deleted the only surviving copy). The upsert is oplog-
        // captured like any local edit, so the restored row syncs to peers; the backup key itself
        // stays machine-local (metaConflictBackup.* is in isMachineLocalMetaKey) and is consumed.
        const colon = originalKey.indexOf(':')
        const entity = colon > 0 ? originalKey.slice(0, colon) : ''
        const restoreOp = ENTITY_RESTORE_OPS[entity]
        if (restoreOp) {
          const id = originalKey.slice(colon + 1)
          const row = b.value
          if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('syncConflictBackupRestore: entity backup payload is not a row object')
          if (row.id == null) row.id = id
          // setting rows are keyed by `key` (settings_rows PK), not `id`
          if (row.key == null && entity === 'setting') row.key = id
          // loserCopy (merge.mjs) stamps the conflict markers onto the copied row; they are not
          // table columns — on tomato they would be snapshotted into the extra JSON blob and
          // permanently pollute the ledger row, so strip them before any write.
          delete row.conflictOf
          delete row.conflictAt
          // C8 (2026-09-25): the entity branch used to OVERWRITE the current winning row without
          // re-backuping it — the meta branch below re-backups the live value ("a restore is
          // itself reversible", :73-75) but the entity restore destroyed the winner's only copy
          // outside the table when the restore was itself wrong. Snapshot the current winner
          // (minus conflict markers, same write-shape rules) into a fresh backup key BEFORE the
          // bulk write, pruned to the same 20-per-key cap as every other re-backup.
          const current = ENTITY_CURRENT_ROW[entity](call, id)
          let snapKey = null
          if (current) {
            const snap = JSON.parse(JSON.stringify(current)) // detach from the live row list
            delete snap.conflictOf
            delete snap.conflictAt
            const ts36 = Date.now().toString(36)
            snapKey = META_CONFLICT_BACKUP_PREFIX + originalKey + '.' + ts36
            call('setMeta', [snapKey, JSON.stringify({ key: originalKey, value: snap, lostAt: Date.now() })])
            pruneBackups(call, originalKey)
          }
          // C8 follow-up (2026-09-25 adversarial review): the snapshot and the overwrite are not
          // a single transaction — if the bulk write (or the read-back) throws, ROLL BACK the
          // just-minted winner snapshot, otherwise the failed restore leaves an orphan
          // metaConflictBackup key advertising a "recoverable" copy of a row that was never
          // touched. The ORIGINAL backup key stays on any failure (refuse-to-lose).
          try {
            call(restoreOp, [row])
            // Read-back before consuming: the bulk op may have SILENTLY skipped the row (see
            // ENTITY_READBACK). If it never landed, keep the backup key — the restore is
            // refuse-to-lose, never ok:true-with-copy-deleted.
            if (!ENTITY_READBACK[entity](call, String(row.id))) {
              throw new Error('syncConflictBackupRestore: restored row did not land in ' + entity + ' (bulk op skipped it) — backup kept')
            }
          } catch (e) {
            if (snapKey != null) { try { call('deleteMeta', snapKey) } catch { /* rollback is best-effort; the 20-per-key prune bounds residue */ } }
            throw e
          }
          call('deleteMeta', key)
          return { ok: true, key: originalKey, entity }
        }
        const current = call('getMeta', originalKey)
        if (current != null) {
          const ts36 = Date.now().toString(36)
          call('setMeta', [META_CONFLICT_BACKUP_PREFIX + originalKey + '.' + ts36, JSON.stringify({ key: originalKey, value: current, lostAt: Date.now() })])
          // Wave-B P3: the re-backup must honor the same 20-per-key cap as the apply path's
          // writeMetaConflictBackup (sync-apply.js) — shared pruneBackups (also used by the
          // C8 entity re-backup above).
          pruneBackups(call, originalKey)
        }
        call('setMeta', [originalKey, b.value])
        call('deleteMeta', key)
        return { ok: true, key: originalKey }
      }
    }
  }
}
