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
  // gateTs (Round-3 P1, 2026-09-21 settings LWW revert): when finite, a whole-blob mirror write
  // whose snapshot stamp (_savedAt) predates a row's updatedAt must NOT re-stamp that row back —
  // the row was applied by SYNC after the blob snapshot was taken, so the blob's value for that
  // field is STALE. Skipping keeps the row (the sync truth) and emits no oplog delta, killing the
  // revert loop: stale peer mirror → fresh-ts delta → newer row wins LWW → local user edit lost.
  const putRow = (key, rawValue, now, gateTs) => {
    const value = JSON.stringify(rawValue === undefined ? null : rawValue)
    const cur = getDb().prepare('SELECT value, deleted, updatedAt FROM settings_rows WHERE key = ?').get(key)
    if (cur && !cur.deleted && cur.value === value) return false
    // Round-4 P1 (clock skew vs the mirror gate): cur.updatedAt may carry the PEER's clock —
    // sync-apply.js clamps inbound rows only at now+SKEW_CLAMP_MS (10min), so a skewed peer can
    // legally leave a row stamped up to +10min into OUR future. Comparing that future stamp
    // against gateTs (the LOCAL _savedAt of the blob being mirrored) made every local edit
    // during the skew window look "older than the row" and got dropped — lost on restart. The
    // comparison must run on LOCAL time: clamp the row's stamp to our now, and only gate when
    // the row is MEANINGFULLY newer than the blob snapshot (1s epsilon absorbs same-tick stamp
    // ordering between the blob save and the mirror; a genuinely stale echo is minutes behind,
    // so the Round-3 revert guard keeps its strength).
    const curTs = cur ? Math.min(Number(cur.updatedAt) || 0, Date.now()) : 0
    if (Number.isFinite(gateTs) && cur && !cur.deleted && curTs - gateTs > 1000) return false // stale whole-blob echo: row wins
    getDb().prepare(`INSERT INTO settings_rows (key, value, updatedAt, deleted, deletedAt) VALUES (?, ?, ?, 0, 0)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=excluded.updatedAt, deleted=0, deletedAt=0`)
      .run(key, value, now)
    return true
  }

  // Blob -> rows diff-merge used by BOTH the v6 migration and the setMeta bridge: only fields
  // whose serialized value changed are re-stamped, so unchanged settings keep their LWW age.
  // Returns the changed field keys (caller turns them into oplog deltas).
  // gateTs (Round-3 P1): the blob's own _savedAt stamp, when the caller has one — fields whose
  // rows are NEWER than the blob snapshot are stale echoes and are skipped (see putRow).
  function mergeDoc (doc, gateTs) {
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return []
    const now = Date.now()
    const changed = []
    const tr = getDb().transaction(() => {
      for (const [k, v] of Object.entries(doc)) {
        if (UNSAFE_KEYS.has(k)) continue
        if (putRow(k, v, now, gateTs)) changed.push(k)
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
      // R7 P2-3 (2026-09-21): the old bare mergeDoc(doc) re-stamped EVERY changed field row with
      // local now, ungated. On the restore path (a pre-v6 backup's blobs land in meta and this
      // migration runs on next boot) that gave backup-era values a fresh LWW age, so they won
      // against a peer's newer live settings rows. Gate the merge by the blob's own _savedAt
      // stamp when it carries one; otherwise gate at 0 — putRow then preserves any EXISTING row
      // (its real updatedAt always beats the gate) and only stamps fields that have no row yet,
      // so absent fields land exactly once and pre-existing rows keep their true LWW age.
      const gateTs = doc && Number.isFinite(Number(doc._savedAt)) ? Number(doc._savedAt) : 0
      mergeDoc(doc, gateTs)
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
        // Round-3 P1: the renderer's whole-blob mirror carries `_savedAt` (settings.js
        // mirrorBlob stamps it at persist time). Gate the diff-merge by it: a pending mirror
        // queued BEFORE a sync-apply landed (its _savedAt older than the applied row's
        // updatedAt) must not re-stamp the pre-edit value over the applied row — that stale
        // echo used to win LWW on the peer and revert the local user's edit seconds later.
        const gateTs = doc && Number.isFinite(Number(doc._savedAt)) ? Number(doc._savedAt) : undefined
        const changed = doc ? mergeDoc(doc, gateTs) : []
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
      // D6 P2 (2026-09-21): the old `throw on any element lacking key` was a poison pill in the
      // sync flush — flushOne caught it but dropped the WHOLE buffered settings segment, so one
      // malformed element among hundreds of valid rows lost them all (architectural rule, same as
      // planAddMany round-3: a bulk op's failure granularity is per-ROW, not per-BATCH). Skip and
      // collect: valid rows commit, rejected entries are logged with their index/key and left out
      // of the returned changed list (the caller logs them; data stays recoverable via snapshot).
      const rejected = []
      const tr = getDb().transaction(() => {
        for (let i = 0; i < arr.length; i++) {
          const p = arr[i]
          const key = p && p.key != null ? String(p.key) : ''
          if (!key) { rejected.push({ index: i, key: p && p.key != null ? String(p.key) : null, reason: 'key required' }); continue }
          // R7 P1-1: an explicit updatedAt (sync apply path) preserves the winner's LWW age;
          // local writers without a stamp keep the now-stamp behavior
          if (putRow(key, p.value, (p && p.updatedAt) || now)) changed.push(key)
        }
      })
      tr()
      for (const r of rejected) log.warn(`[TodoDB] settingsRowPutMany: rejected row #${r.index} (${r.reason})`)
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
