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
    ]
  return migrationsOverride || BUILT_IN
}
