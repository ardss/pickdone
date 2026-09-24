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

function parseBackup (raw) {
  try { const o = JSON.parse(raw); if (o && typeof o === 'object' && !Array.isArray(o)) return o } catch { /* unreadable payload surfaces as skipped/err below */ }
  return null
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
          call(restoreOp, [row])
          // Read-back before consuming: the bulk op may have SILENTLY skipped the row (see
          // ENTITY_READBACK). If it never landed, keep the backup key — the restore is
          // refuse-to-lose, never ok:true-with-copy-deleted.
          if (!ENTITY_READBACK[entity](call, String(row.id))) {
            throw new Error('syncConflictBackupRestore: restored row did not land in ' + entity + ' (bulk op skipped it) — backup kept')
          }
          call('deleteMeta', key)
          return { ok: true, key: originalKey, entity }
        }
        const current = call('getMeta', originalKey)
        if (current != null) {
          const ts36 = Date.now().toString(36)
          call('setMeta', [META_CONFLICT_BACKUP_PREFIX + originalKey + '.' + ts36, JSON.stringify({ key: originalKey, value: current, lostAt: Date.now() })])
          // Wave-B P3: the re-backup must honor the same 20-per-key cap as the apply path's
          // writeMetaConflictBackup (sync-apply.js) — the old restore minted unpruned backups,
          // so repeated restore/re-conflict cycles grew metaConflictBackup.<key>.* forever.
          try {
            const prefix = META_CONFLICT_BACKUP_PREFIX + originalKey + '.'
            const keys = (call('listMetaKeys') || []).map(String).filter(k => k.startsWith(prefix)).sort()
            for (const old of keys.slice(0, Math.max(0, keys.length - 20))) {
              try { call('deleteMeta', old) } catch { /* prune is best-effort */ }
            }
          } catch { /* prune is best-effort */ }
        }
        call('setMeta', [originalKey, b.value])
        call('deleteMeta', key)
        return { ok: true, key: originalKey }
      }
    }
  }
}
