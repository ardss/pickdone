'use strict'
/**
 * Built-in schema migrations v1..v7, extracted from db.js (structure size ratchet, 2026-09-29 —
 * the v7 provenance column pushed db.js over the 800-line error cap). Pure data + closures over
 * the injected syncSchema; the C2 test seam (migrationsOverride) flows through unchanged.
 * Contract with the db.js migrator loop: fn(db) === false -> abort WITHOUT advancing
 * schemaVersion (retried next boot); a throw is caught by the loop (same semantics).
 */
module.exports = function buildMigrations (syncSchema, migrationsOverride) {
  const BUILT_IN = [
    { v: 1, fn: d => { d.exec('UPDATE todos SET remindAt = 0 WHERE remindAt IS NULL') } },
    { v: 2, fn: d => {
      // data-layer important/urgent for the Eisenhower matrix (2026-08-29) + multi-reminder list
      const cols = d.prepare('PRAGMA table_info(todos)').all().map(c => c.name)
      if (!cols.includes('important')) d.exec('ALTER TABLE todos ADD COLUMN important INTEGER NOT NULL DEFAULT 0')
      if (!cols.includes('urgent')) d.exec('ALTER TABLE todos ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0')
      if (!cols.includes('reminders')) d.exec('ALTER TABLE todos ADD COLUMN reminders TEXT')
    } },
    { v: 3, fn: d => {
      // Plan chips: meta.dayPlanState JSON → plan_chips row storage (2026-09-03 root fix). The original JSON key is renamed and kept as backup.
      // Failure handling: return false → schemaVersion not advanced → retried on next startup (INSERT OR IGNORE is idempotent; the original key remains).
      const r = d.prepare("SELECT value FROM meta WHERE key='dayPlanState'").get()
      if (!r) return true
      try {
        const doc = JSON.parse(r.value)
        const ins = d.prepare('INSERT OR IGNORE INTO plan_chips (id, taskId, day, mm, sort) VALUES (?,?,?,?,?)')
        const tr = d.transaction(() => {
          let n = 0
          for (const day of Object.keys(doc)) {
            if (day.startsWith('_')) continue
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
            for (const [taskId, arr] of Object.entries(doc[day])) {
              if (!Array.isArray(arr)) continue
              for (const e of arr) {
                if (!e || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(e.mm || ''))) continue
                const id = (e && typeof e === 'object' && e.id) ? String(e.id) : ('pl_mig_' + n)
                ins.run(id, taskId, day, String(e.mm), n); n++
              }
            }
          }
        }); tr()
        d.prepare("INSERT INTO meta (key, value) VALUES ('dayPlanState.bak', ?) ON CONFLICT(key) DO NOTHING").run(r.value) // the first backup is never overwritten
        d.prepare("DELETE FROM meta WHERE key='dayPlanState'").run()
        return true
      } catch (e) {
        console.error('[TodoDB] dayPlanState 迁移失败(保留原键,schemaVersion 不推进,下次启动重试):', e)
        return false
      }
    } },
    { v: 4, fn: d => { const c=d.prepare('PRAGMA table_info(todos)').all().map(x=>x.name); if(!c.includes('predecessors')) d.exec('ALTER TABLE todos ADD COLUMN predecessors TEXT'); return true } },
    { v: 5, fn: d => {
      // P1 sync groundwork (2026-09-15): tombstone + updatedAt columns on every synced table. Only todos carried updatedAt/deletedAt before; filters/plan_chips/tomato_records deletes were physical (unpropagatable) and categories had no change timestamp. Defaults keep existing rows.
      const want = {
        categories: ['deletedAt INTEGER NOT NULL DEFAULT 0', 'updatedAt INTEGER NOT NULL DEFAULT 0'],
        filters: ['deleted INTEGER NOT NULL DEFAULT 0', 'deletedAt INTEGER NOT NULL DEFAULT 0', 'updatedAt INTEGER NOT NULL DEFAULT 0'],
        plan_chips: ['deleted INTEGER NOT NULL DEFAULT 0', 'deletedAt INTEGER NOT NULL DEFAULT 0', 'updatedAt INTEGER NOT NULL DEFAULT 0'],
        tomato_records: ['deleted INTEGER NOT NULL DEFAULT 0', 'deletedAt INTEGER NOT NULL DEFAULT 0', 'updatedAt INTEGER NOT NULL DEFAULT 0']
      }
      for (const [table, cols] of Object.entries(want)) {
        const have = new Set(d.prepare('PRAGMA table_info(' + table + ')').all().map(c => c.name))
        for (const col of cols) {
          const name = col.split(' ')[0]
          if (!have.has(name)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`)
        }
      }
      return true
    } },
    { v: 6, fn: d => syncSchema.migrateV6(d) },
    { v: 7, fn: d => {
      // Provenance (protocol v3, 2026-09-29): author of each row's current version. Probe-guarded
      // like every schema side — re-runs on retry-after-failure must be exact no-ops.
      const cols = d.prepare('PRAGMA table_info(todos)').all().map(c => c.name)
      if (!cols.includes('syncAuthor')) d.exec('ALTER TABLE todos ADD COLUMN syncAuthor TEXT')
      return true
    } },
    { v: 8, fn: d => {
      // Sync v2 revision store (docs/sync-v2-core-design.md step 3): immutable revisions +
      // write-time payloads + per-entity current pointer. Written only while the
      // sync.revisions.v2 flag is on; the tables existing changes nothing at v1 runtime.
      d.exec(`CREATE TABLE IF NOT EXISTS sync_revisions (
        revisionId TEXT PRIMARY KEY,
        entity TEXT NOT NULL,
        entityId TEXT NOT NULL,
        authorDeviceId TEXT NOT NULL,
        hlcPhysical INTEGER NOT NULL,
        hlcLogical INTEGER NOT NULL,
        parents TEXT NOT NULL DEFAULT '[]',
        payloadHash TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        createdAt INTEGER NOT NULL
      )`)
      d.exec('CREATE INDEX IF NOT EXISTS idx_sync_revisions_entity ON sync_revisions(entityId, hlcPhysical, hlcLogical)')
      // perf-sync-revisions-prune-inline-write-stall: prunePayloads picks the recent-keep window
      // with ORDER BY hlcPhysical DESC, hlcLogical DESC — without this index every prune sorts
      // the whole revisions table (TEMP B-TREE per write).
      d.exec('CREATE INDEX IF NOT EXISTS idx_sync_revisions_hlc ON sync_revisions(hlcPhysical DESC, hlcLogical DESC)')
      d.exec(`CREATE TABLE IF NOT EXISTS sync_revision_payloads (
        revisionId TEXT PRIMARY KEY,
        payload TEXT NOT NULL
      )`)
      d.exec(`CREATE TABLE IF NOT EXISTS sync_revision_current (
        entityId TEXT PRIMARY KEY,
        revisionId TEXT NOT NULL
      )`)
      return true
    } },
    { v: 9, fn: d => {
      // D13 #10: repeat-renewal idempotency at the DB layer. The renderer's check-then-insert
      // guard cannot close the query→write window (multi-window + CLI triggering the same renewal
      // concurrently minted duplicate instances). One live instance per (recurGroupId,
      // scheduledDay) is now enforced by a unique partial index; pre-existing duplicates are
      // collapsed first — keep the OLDEST row per group+day (the first-minted instance is the one
      // earlier completions chained from), tombstone the later duplicates (recoverable, never
      // destroyed). The index deliberately does NOT live in db.js's SCHEMA: the migrator loop runs
      // AFTER db.exec(SCHEMA), so an index here is what keeps an existing duplicate-carrying DB
      // from failing init. NOTE: ensureRepeatDayUniqueness is RE-RUN post-encryption-finalization
      // (db.js) — the fresh-install encryption path recreates the DB from SCHEMA and would
      // otherwise drop an index that only v9 created.
      ensureRepeatDayUniqueness(d)
      return true
    } },
    ]
  buildMigrations.ensureRepeatDayUniqueness = ensureRepeatDayUniqueness
  return migrationsOverride || BUILT_IN
}

/** Idempotent: collapse duplicate live (recurGroupId, scheduledDay) rows, then create the unique
 *  partial index. Safe to run on every boot (dedupe UPDATE is a no-op once the index exists).
 *  D14 C10 (2026-10-02): the survivor used to be `MIN(id)` — correct for legacy integer id rows
 *  (smallest = first minted) but LEXICOGRAPHIC-ARBITRARY for the current TEXT taskIds (a
 *  random/uuid id's alphabetically-smallest string has no relation to which instance the repeat
 *  chain continues from; tombstoning that one can make the visible series swap its anchor).
 *  Survivor rule is now explicit and deterministic: OLDEST createdAt wins (the first-minted
 *  instance is the one earlier completions chained from), tie-broken by smallest id so the same
 *  duplicate set always collapses to the same row on every device/boot. */
function ensureRepeatDayUniqueness (d) {
  d.exec(`UPDATE todos SET deleted = 1, deletedAt = CASE WHEN deletedAt IS NULL OR deletedAt = 0 THEN ${Date.now()} ELSE deletedAt END
          WHERE deleted = 0 AND recurGroupId IS NOT NULL AND scheduledDay > 0
            AND id NOT IN (
              SELECT id FROM (
                SELECT id, ROW_NUMBER() OVER (
                  PARTITION BY recurGroupId, scheduledDay
                  ORDER BY createdAt ASC, id ASC
                ) rn
                FROM todos
                WHERE deleted = 0 AND recurGroupId IS NOT NULL AND scheduledDay > 0
              )
              WHERE rn = 1
            )`)
  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_repeat_day ON todos (recurGroupId, scheduledDay) WHERE deleted = 0 AND recurGroupId IS NOT NULL AND scheduledDay > 0')
}
