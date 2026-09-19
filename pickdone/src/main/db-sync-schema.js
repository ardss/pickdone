/* P2 sync-schema extension (2026-09-16, docs/sync/同步整体方案-2026-09-15.md §4.2 + §5).
 * Split out of db.js for the size ratchet; db.js keeps only thin wiring (require, DDL concat,
 * one MIGRATIONS entry, four OPS delegating lines, one registerOps call).
 *
 * 1. settings_rows: the settings/habits state currently mirrored as whole blobs in meta
 *    (db.settingsState / db.habitsState) moves to per-key rows with updatedAt + tombstones —
 *    blob-level LWW would let two devices overwrite each other wholesale (§4.2). Follows the
 *    plan_chips row-table precedent: soft delete, updatedAt stamped on change, change-captured
 *    into sync_oplog.
 * 2. Legacy bridge: until the renderer switches to the row ops (Wave-2), a setMeta on a sync
 *    blob key mirrors its changed top-level fields into settings_rows, so rows never go stale
 *    while the old blob path is still live. Non-sync meta keys are untouched.
 *
 * Value encoding: every row value is JSON.stringify-ed (uniform roundtrip; scalar strings are
 * quoted). Readers JSON.parse; a corrupted value surfaces as null rather than crashing reads.
 */

const SYNC_BLOB_KEYS = ['db.settingsState', 'db.habitsState']
// Belt and braces (2026-09-19): pre-rename installs wrote the habits blob under the bare 'habitsState'
// meta key; normalize either spelling to the canonical db.* key so migrateV6/bridge migrate both.
const canonBlobKey = k => k === 'habitsState' ? 'db.habitsState' : k

const DDL = `
CREATE TABLE IF NOT EXISTS settings_rows (
  key       TEXT PRIMARY KEY,
  value     TEXT,
  updatedAt INTEGER NOT NULL DEFAULT 0,
  deleted   INTEGER NOT NULL DEFAULT 0,
  deletedAt INTEGER NOT NULL DEFAULT 0
);`

const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

module.exports = ({ getDb, log }) => {
  const rowsAll = () => getDb().prepare('SELECT key, value, updatedAt, deleted, deletedAt FROM settings_rows').all()
    .map(r => ({ key: r.key, value: parseValue(r.value), updatedAt: r.updatedAt, deleted: !!r.deleted, deletedAt: r.deletedAt }))
  const rowGet = k => rowsAll().find(r => r.key === String(k)) || null

  // Upsert one field row; stamps updatedAt only when the value actually changed (an identical
  // write must not fake LWW freshness, same rule as upsertCategory). Tombstoned rows resurrect.
  const putRow = (key, rawValue, now) => {
    const value = JSON.stringify(rawValue === undefined ? null : rawValue)
    const cur = getDb().prepare('SELECT value, deleted FROM settings_rows WHERE key = ?').get(key)
    if (cur && !cur.deleted && cur.value === value) return false
    getDb().prepare(`INSERT INTO settings_rows (key, value, updatedAt, deleted, deletedAt) VALUES (?, ?, ?, 0, 0)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt, deleted=0, deletedAt=0`)
      .run(key, value, now)
    return true
  }

  // Blob -> rows diff-merge used by BOTH the v6 migration and the setMeta bridge: only fields
  // whose serialized value changed are re-stamped, so unchanged settings keep their LWW age.
  // Returns the changed field keys (caller turns them into oplog deltas).
  function mergeDoc (doc) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return []
    const now = Date.now()
    const changed = []
    const tr = getDb().transaction(() => {
      for (const [k, v] of Object.entries(doc)) {
        if (UNSAFE_KEYS.has(k)) continue
        if (putRow(k, v, now)) changed.push(k)
      }
    })
    tr()
    return changed
  }

  // v6 migration (docs/sync §4.2 settings/habits blob split + §5 tz column). Runs under the
  // schemaVersion migrator in db.js: once per DB, retried on failure (return false keeps the
  // version stamp from advancing). Idempotent: a meta-side snapshot key per blob records the
  // last migrated blob text, so unchanged re-runs are exact no-ops (no updatedAt re-stamping).
  function migrateV6 (d) {
    // tz column (§5): IANA timezone of the creating device, stamped on write by todoToRow;
    // NULL = pre-tz "local history" rows. scheduledDay semantics unchanged.
    const cols = d.prepare('PRAGMA table_info(todos)').all().map(c => c.name)
    if (!cols.includes('tz')) d.exec('ALTER TABLE todos ADD COLUMN tz TEXT')
    d.exec(DDL)
    // P1 2026-09-17: a corrupted blob must keep the schemaVersion from advancing (return false →
    // the migrator in db.js breaks before stamping ver, so this migration re-runs next boot and
    // retries the blob — the "retry next boot" promise in the old comment was dead because this
    // function unconditionally returned true after `continue`).
    let pendingRetry = 0
    for (const rawKey of [...SYNC_BLOB_KEYS, 'habitsState']) {
      const blobKey = canonBlobKey(rawKey)
      // The blob is stored under the RAW key as the writer spelled it; canonical key is only used
      // for the snapshot marker so both spellings share one migration bookkeeping row.
      const blob = d.prepare('SELECT value FROM meta WHERE key = ?').get(rawKey)
      if (!blob) continue // never written on this device: nothing to split
      const snapKey = 'settingsRows.src.' + blobKey
      const snap = d.prepare('SELECT value FROM meta WHERE key = ?').get(snapKey)
      if (snap && snap.value === blob.value) continue // already migrated in this exact shape
      let doc
      try { doc = JSON.parse(blob.value) } catch (e) {
        // Corrupted blob: keep it and retry next boot (same policy as the tomato blob migration) —
        // deleting or tombstoning rows off an unparseable blob could destroy recoverable data
        log.warn('[TodoDB] settings blob migration: unparseable JSON, kept for retry:', blobKey)
        pendingRetry++
        continue
      }
      mergeDoc(doc)
      d.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(snapKey, blob.value)
    }
    return pendingRetry === 0
  }

  // Bridge wiring called once from db.js after OPS/WRITE_OPS exist: wraps setMeta so legacy blob
  // writes keep settings_rows live, and registers the new write ops in WRITE_OPS (oplog entity
  // mapping lives in db-oplog.js). The blob itself is NOT deleted: the renderer still reads it.
  function registerOps (OPS, WRITE_OPS, oplog) {
    const rawSetMeta = OPS.setMeta
    OPS.setMeta = (k, v) => {
      if (Array.isArray(k)) { v = k[1]; k = k[0] }
      const r = rawSetMeta(k, v)
      const blobKey = canonBlobKey(k)
      if (SYNC_BLOB_KEYS.includes(blobKey)) {
        let doc = null
        try { doc = JSON.parse(v) } catch (e) { /* bridge mirrors parseable docs only */ }
        const changed = doc ? mergeDoc(doc) : []
        const snapKey = 'settingsRows.src.' + blobKey
        // P1 2026-09-17: only stamp the snapshot for PARSEABLE docs — stamping an unparseable blob
        // made migrateV6's "already migrated in this exact shape" guard skip the corruption retry.
        if (doc) getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(snapKey, String(v))
        // Row-granular change capture for the mirrored fields (the ('meta', key) delta from the
        // setMeta op itself is emitted separately by call(); both belong in the log)
        if (changed.length) oplog.appendOplog(changed.map(id => ({ entity: 'setting', entityId: id, ts: Date.now() })))
      }
      return r
    }
    for (const op of ['settingsRowPut', 'settingsRowPutMany', 'settingsRowDelete']) WRITE_OPS.add(op)
  }

  function parseValue (s) {
    if (s == null) return null
    try { return JSON.parse(s) } catch (e) { return null }
  }

  return {
    DDL,
    SYNC_BLOB_KEYS,
    migrateV6,
    registerOps,
    // Row ops (db.js OPS delegate here). settingsRowsAll deliberately includes tombstones: the
    // sync merge needs them; user-facing consumers filter deleted rows themselves.
    rowsAll,
    rowGet,
    rowPut: p => {
      const key = p && p.key != null ? String(p.key) : ''
      if (!key) throw new Error('settingsRowPut: key is required')
      return putRow(key, p.value, Date.now())
    },
    rowPutMany: list => {
      const arr = Array.isArray(list) ? list : [list]
      const now = Date.now()
      const changed = []
      const tr = getDb().transaction(() => {
        for (const p of arr) {
          const key = p && p.key != null ? String(p.key) : ''
          if (!key) throw new Error('settingsRowPutMany: key is required')
          if (putRow(key, p.value, now)) changed.push(key)
        }
      })
      tr()
      return changed
    },
    rowDelete: p => {
      const key = p && typeof p === 'object' ? String(p.key) : String(p)
      if (!key) throw new Error('settingsRowDelete: key is required')
      // Tombstone without re-stamping an already-deleted row (its deletedAt is the merge truth)
      const r = getDb().prepare('UPDATE settings_rows SET deleted=1, deletedAt=?, updatedAt=? WHERE key=? AND deleted=0').run(Date.now(), Date.now(), key)
      return r.changes > 0
    }
  }
}
