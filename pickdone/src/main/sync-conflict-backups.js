/* X4 (2026-09-20): user recovery path for machine-local meta LWW conflict backups.
 * metaConflictBackup.* keys (written by sync-apply.writeMetaConflictBackup, P1-5) were
 * write-only: correct to keep out of sync, but unrecoverable by users. These two ops are
 * registered via db-sync-ops (see lan-sync-bootstrap registerOps) and exposed to the renderer
 * through the todo-db:call whitelist; the UI surface lives in the renderer (agent Y).
 * Separate module so lan-sync-bootstrap.js stays under its size ratchet. */
const META_CONFLICT_BACKUP_PREFIX = 'metaConflictBackup.'
const PREVIEW_MAX = 200

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
          const value = String(b.value == null ? '' : b.value)
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
        const current = call('getMeta', originalKey)
        if (current != null) {
          const ts36 = Date.now().toString(36)
          call('setMeta', [META_CONFLICT_BACKUP_PREFIX + originalKey + '.' + ts36, JSON.stringify({ key: originalKey, value: current, lostAt: Date.now() })])
        }
        call('setMeta', [originalKey, b.value])
        call('deleteMeta', key)
        return { ok: true, key: originalKey }
      }
    }
  }
}
