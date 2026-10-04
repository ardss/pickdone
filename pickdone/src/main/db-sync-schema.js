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
// mig-v6-corrupt-blob-freezes-schema-forever: machine-local boot-attempt counter for the corrupt
// settings-blob retry loop (see migrateV6). 5 failed retries, then escalate (advance anyway).
const BLOB_MIGRATION_ATTEMPTS_KEY = 'sync.settingsBlobMigrationAttempts'
const BLOB_MIGRATION_ESCALATE_AT = 5
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

// Sync-11: canonical (key-order-insensitive) JSON compare, single-sourced from sync-core's
// stableStringify (the same normalization the merge layer uses for content identity).
// require(esm) — same mechanism as db.js's shared/limits.mjs import; merge.mjs is dependency-free.
const { stableStringify } = require('../../shared/sync-core/merge.mjs')

module.exports = ({ getDb, log }) => {
  const rowsAll = () => getDb().prepare('SELECT key, value, updatedAt, deleted, deletedAt FROM settings_rows').all()
    .map(r => ({ key: r.key, value: parseValue(r.value), updatedAt: r.updatedAt, deleted: !!r.deleted, deletedAt: r.deletedAt }))
  const rowGet = k => rowsAll().find(r => r.key === String(k)) || null
  // Round-3 perf (2026-09-26): the external-write watcher's per-tick settings watermark only
  // needs max(updatedAt) — it used to rowsAll() + JSON.parse every row ~4x/sec for the app's
  // lifetime. A single aggregate returns the IDENTICAL number (MAX over the column covers
  // tombstones too) with zero per-row JSON.parse.
  const maxUpdated = () => {
    const r = getDb().prepare('SELECT MAX(updatedAt) AS m FROM settings_rows').get()
    return (r && r.m) || 0
  }

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
    // Sync-11: canonical compare — the same document written with different key insertion
    // order (or a re-serialized nested object) stringifies differently but IS the same value;
    // the string compare above then read "changed", re-stamped updatedAt with fresh local now
    // and minted a fake LWW age + oplog delta for an identical write. Compare both sides
    // through stableStringify over the PARSED values (JSON semantics normalize both shapes).
    if (cur && !cur.deleted) {
      try {
        if (stableStringify(JSON.parse(cur.value)) === stableStringify(JSON.parse(value))) return false
      } catch { /* unparseable current value: genuinely changed */ }
    }
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

  // Sync-10: the blob mirror is a WHOLE-document write — a field the renderer REMOVED from the
  // blob is deleted, but the bridge only ever mirrored fields PRESENT in the doc, so the stale
  // settings_row lingered live forever: every snapshot re-pushed it to peers and a peer's newer
  // mirror re-materialized it here (a permanent resurrection loop for deleted settings fields).
  // Tombstone rows whose key is absent from the doc. The doc's `_savedAt` stamp is the CAUSAL
  // watermark: a row whose (clamped) updatedAt is AT OR AFTER the stamp was written while (or
  // after) the mirror's base doc was being authored — the renderer's whole-doc mirror, a
  // concurrent settingsSet row write inside its race window, or a sync-apply landing between
  // the doc read and this bridge write. Its absence from the doc proves nothing about
  // deletion, so those rows are kept (fixes f3-6c: the old >1s epsilon tombstoned a row a
  // concurrent writer had created milliseconds earlier, clobbering the App's change). A row
  // strictly OLDER than the stamp was fully visible to the doc's author; absence is a real
  // removal → tombstone (Sync-10's resurrection-loop fix). Without a finite stamp the doc's
  // freshness is unknown and absence proves nothing: tombstone nothing. Returns the
  // tombstoned keys (oplog deltas).
  function tombstoneAbsentRows (docKeys, gateTs) {
    // Machine-local rows (sync.deviceId, securityLock*, sync.revisions.v2 flag — shared/
    // machine-local-keys.mjs) never come from the blob doc but must NEVER be tombstoned off it:
    // the blob mirror is not their writer.
    const { isMachineLocalSettingKey } = require('../../shared/machine-local-keys.mjs')
    if (!Number.isFinite(gateTs)) return []
    const present = new Set((docKeys || []).filter(k => !UNSAFE_KEYS.has(k)))
    const rows = getDb().prepare('SELECT key, updatedAt FROM settings_rows WHERE deleted = 0').all()
    const now = Date.now()
    const removed = []
    for (const r of rows) {
      if (present.has(r.key) || isMachineLocalSettingKey(r.key)) continue
      if (Math.min(Number(r.updatedAt) || 0, now) >= gateTs) continue // written at/after the snapshot stamp: not authored-over, keep
      // D13 finding 4: stamp the tombstone with the doc's causal watermark (gateTs), not local
      // wall-clock now — the same stamp-awareness the rowDelete path carries (D11). A
      // mirror-deletion is only provable against the snapshot taken at gateTs (_savedAt,
      // potentially minutes before this bridge write); re-aging the tombstone to `now` made it
      // read newest-here and beat a peer's genuinely newer tombstone/edit in LWW.
      const res = getDb().prepare('UPDATE settings_rows SET deleted=1, deletedAt=?, updatedAt=? WHERE key=? AND deleted=0').run(gateTs, gateTs, r.key)
      if (res.changes > 0) removed.push(r.key)
    }
    return removed
  }

  // v6 migration (docs/sync §4.2 settings/habits blob split + §5 tz column). Runs under the
  // schemaVersion migrator in db.js: once per DB, retried on failure (return false keeps the
  // version stamp from advancing). Idempotent: a meta-side snapshot key per blob records the
  // last migrated blob text, so unchanged re-runs are exact no-ops (no updatedAt re-stamping).
  function migrateV6 (d) {
    // tz column (§5): IANA timezone of the creating device, stamped on write by todoToRow;
    // NULL = pre-tz "local history" rows. scheduledDay semantics unchanged.
    // 2026-09-25 guard note (no behavior change): this migration re-runs on retry-after-failure
    // (pendingRetry>0 keeps the schemaVersion stamp from advancing), so EVERY schema side here
    // must stay re-entrant: the `!cols.includes('tz')` probe is load-bearing (a bare ALTER TABLE
    // would throw on the retried run), and `d.exec(DDL)` must stay IF-NOT-EXISTS shaped. New
    // schema statements added below must follow the same exists-guard pattern — half-completed
    // runs WILL come through here a second time.
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
    // mig-v6-corrupt-blob-freezes-schema-forever (P2, symptom of the broader defect "one-shot
    // migrations with retained-input retry loops have no escalation policy"): the migrator loop
    // (db.js) breaks WITHOUT advancing schemaVersion whenever this returns false, and the corrupt
    // blob is kept for retry — so an unparseable blob (disk bit-rot, truncated write) used to
    // freeze the schema at v5 across boots forever. Machine-local attempt counter (TOMATO_PARTIAL
    // _MIGRATION_ATTEMPTS_KEY pattern from db-tomato-ops.js): after BLOB_MIGRATION_ESCALATE_AT
    // failed boots, give up retrying, log.error, and return true so the version advances. The
    // corrupt blob is left untouched (the 'settingsRows.src.<key>' snapshot is only stamped for
    // parseable docs, so idempotency bookkeeping is unaffected) and a later boot where the blob
    // became parseable (e.g. restored from backup) still migrates it: success clears the counter.
    if (pendingRetry === 0) {
      try { d.prepare('DELETE FROM meta WHERE key = ?').run(BLOB_MIGRATION_ATTEMPTS_KEY) } catch { /* best-effort */ }
      return true
    }
    let attempts = 1
    try {
      const prev = d.prepare('SELECT value FROM meta WHERE key = ?').get(BLOB_MIGRATION_ATTEMPTS_KEY)
      attempts = (Number(prev && prev.value) || 0) + 1
      d.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
        .run(BLOB_MIGRATION_ATTEMPTS_KEY, String(attempts))
    } catch { /* counter is best-effort: lose it and the retry window simply restarts */ }
    if (attempts > BLOB_MIGRATION_ESCALATE_AT) {
      log.error(`[TodoDB] settings blob migration: still unparseable after ${attempts} boots — advancing schemaVersion, corrupt blob left untouched (recovered blobs migrate on a later boot)`)
      return true
    }
    return false
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
        // Sync-10: fields removed from the whole-blob mirror are deletions — tombstone their
        // rows too (gated like putRow, so sync-applied newer rows survive a stale echo).
        const removed = doc ? tombstoneAbsentRows(Object.keys(doc), gateTs) : []
        const snapKey = 'settingsRows.src.' + blobKey
        // P1 2026-09-17: only stamp the snapshot for PARSEABLE docs — stamping an unparseable blob
        // made migrateV6's "already migrated in this exact shape" guard skip the corruption retry.
        if (doc) getDb().prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(snapKey, String(v))
        // Row-granular change capture for the mirrored fields (the ('meta', key) delta from the
        // setMeta op itself is emitted separately by call(); both belong in the log)
        if (changed.length) oplog.appendOplog(changed.map(id => ({ entity: 'setting', entityId: id, ts: Date.now() })))
        if (removed.length) oplog.appendOplog(removed.map(id => ({ entity: 'setting', entityId: id, ts: Date.now() })))
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
    maxUpdated,
    rowGet,
    rowPut: p => {
      const key = p && p.key != null ? String(p.key) : ''
      if (!key) throw new Error('settingsRowPut: key is required')
      // D21 (P3 2026-10-02): honor an explicit updatedAt — rowPutMany already does (sync apply
      // path preserves the winner's LWW age), but single rowPut dropped it and stamped every
      // remote-applied row with now, silently re-aging it against LWW merges.
      return putRow(key, p.value, (p && p.updatedAt) || Date.now())
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
          // 2026-09-26 poison-row fix: D6 P2 only isolated the MISSING-KEY class — a per-row putRow
          // THROW (e.g. a value JSON.stringify cannot encode: BigInt / circular) still unwound the
          // whole transaction and re-threw out of rowPutMany, so the sync flush dropped EVERY row
          // in the segment, not just the poison one. Failure granularity is per-ROW: catch here,
          // commit the valid siblings, surface the poisoned one in `rejected`.
          try {
            // R7 P1-1: an explicit updatedAt (sync apply path) preserves the winner's LWW age;
            // local writers without a stamp keep the now-stamp behavior
            if (putRow(key, p.value, (p && p.updatedAt) || now)) changed.push(key)
          } catch (e) {
            rejected.push({ index: i, key, reason: (e && e.message) || String(e) })
          }
        }
      })
      tr()
      for (const r of rejected) log.warn(`[TodoDB] settingsRowPutMany: rejected row #${r.index} (${r.reason})`)
      // D13 finding 3 (uniform bulk-flush rejection contract): attach the per-row rejections to
      // the returned accepted-keys list as a NON-enumerable property — the array contract (oplog
      // expansion `arr('setting', result)`, renderer acknowledgement) stays byte-compatible,
      // while the sync flush (sync-apply.flushOne) can now see and quarantine the silently
      // dropped rows instead of acking a segment whose tail never landed.
      Object.defineProperty(changed, 'rejected', { value: rejected, enumerable: false })
      return changed
    },
    rowDelete: p => {
      // D11 finding 3 (parity with planRemoveIds/filterDelete stamps): p may be a bare key
      // (renderer/CLI) or {key, deletedAt, updatedAt} tombstone stamps (sync apply path) — the
      // sync layer carries the winner's LWW age; local writers without a stamp keep local now.
      const o = (p && typeof p === 'object') ? p : { key: p }
      const key = o.key != null ? String(o.key) : ''
      if (!key) throw new Error('settingsRowDelete: key is required')
      // Tombstone without re-stamping an already-deleted row (its deletedAt is the merge truth)
      const dAt = Number(o.deletedAt) > 0 ? Number(o.deletedAt) : Date.now()
      const r = getDb().prepare('UPDATE settings_rows SET deleted=1, deletedAt=?, updatedAt=? WHERE key=? AND deleted=0')
        .run(dAt, Number(o.updatedAt) > 0 ? Number(o.updatedAt) : dAt, key)
      return r.changes > 0
    }
  }
}
