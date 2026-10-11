import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// S2 DVV persistence adapter (db-revisions.cjs): dotted version vectors minted on the REAL
// local revision write path, persisted into the lazy sync_revision_dvv side table, and
// re-read by exportToStore/exportStore. Coverage matrix mandated by the work package:
//   1. default OFF  → zero schema/data footprint (flag-off DB behaves byte-identically)
//   2. flag ON      → dvv minted + persisted in the SAME transaction as the revision rows
//   3. crash/restart→ dot counter never reused, dvv rows survive (SQLite atomic commit)
//   4. duplicate    → re-applying an exported envelope is idempotent (engine dedupe)
//   5. old data     → missing side table / stale counter degrade safely and self-heal
//                     (raw recorder fixture — plain temp SQLite, no electron db.js)
//   6. reversibility→ sub-flag OFF again → store.useDvv false, dvv data inert, counter frozen

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-db-rev-dvv-'))
const require = createRequire(import.meta.url)
const db = require('../../../src/main/db')

const { createRevisionStore, applyEnvelope, materializedAll } = await import('../../../shared/sync-core/causality/merge.mjs')
const { dvvRelation } = await import('../../../shared/sync-core/causality/dvv.mjs')
const revisions = db.__revisionsForTests

db.init(process.env.TODO_DB_DIR)

const seedTodo = (taskId, title) => db.call('upsert', { taskId, title, createdAt: 1000, updatedAt: 1000 })

test('dvv: default OFF — no dvv state and no side table, legacy recording untouched', () => {
  const st = db.call('revisionsFlagState')
  assert.equal(st.on, false)
  assert.equal(st.dvv, false, 'dvv sub-flag defaults to false')
  seedTodo('dv-off', 'before any flag')
  assert.equal(db.call('revisionsList').length, 0, 'base flag off: nothing recorded at all')
  assert.equal(revisions.dvvState().table, false, 'lazy side table NOT created while flags are off')
})

test('dvv: flag ON — revisions carry persisted dotted vectors, counter durable', () => {
  db.call('revisionsFlag', { on: true })
  db.call('revisionsFlagDvv', { on: true })
  const st = db.call('revisionsFlagState')
  assert.equal(st.on, true)
  assert.equal(st.dvv, true)

  seedTodo('dv1', 'first edit')
  seedTodo('dv1', 'second edit')

  const list = db.call('revisionsList', { entityId: 'dv1' })
  assert.equal(list.length, 2)
  const [r1, r2] = list
  assert.ok(r1.dvv, 'first revision carries a dvv')
  assert.equal(r1.dvv.dot.counter, 1)
  assert.deepEqual(r1.dvv.context, {}, 'first dot has an empty causal context')
  assert.ok(r2.dvv, 'second revision carries a dvv')
  assert.equal(r2.dvv.dot.counter, 2, 'dot counter strictly increments per local event')
  assert.equal(r2.dvv.context[r1.dvv.dot.deviceId], 1, 'child context covers the parent dot')
  assert.equal(dvvRelation(r2, r1), 'descendant', 'DB-minted dvv classifies the child as causal descendant')
  assert.equal(dvvRelation(r1, r2), 'ancestor')

  const dvvSt = revisions.dvvState()
  assert.equal(dvvSt.table, true, 'side table created lazily by the first flagged write')
  assert.equal(dvvSt.counter, 2, 'dot counter persisted in the SAME transaction as the dvv rows')
  assert.equal(dvvSt.maxDot, 2)
})

test('dvv: crash/restart — counter never reused, dvv rows survive the reopen', () => {
  db.close()
  db.init(process.env.TODO_DB_DIR)
  assert.equal(db.call('revisionsFlagState').dvv, true, 'sub-flag survives restart (persisted)')
  seedTodo('dv1', 'edit after restart')

  const dots = db.call('revisionsList', { entityId: 'dv1' }).map(r => r.dvv && r.dvv.dot.counter).filter(Boolean)
  assert.equal(dots.length, 3, 'all three revisions carry dvv (old rows survive reopen)')
  assert.equal(Math.max(...dots), 3, 'post-restart dot is 3 — the counter was NOT reset (no dot reuse)')
  assert.equal(new Set(dots).size, dots.length, 'all dots distinct')
})

test('dvv: duplicate application — replaying an exported envelope is idempotent', () => {
  const store = revisions.exportStore()
  assert.equal(store.useDvv, true, 'exportStore opts into dvv while the sub-flag is on')
  const before = materializedAll(store)
  const env = store.revisions.get(store.currentByEntity.get('dv1'))
  assert.equal(applyEnvelope(store, env).status, 'duplicate', 're-applying the current envelope dedupes')
  assert.deepEqual(materializedAll(store), before, 'duplicate apply changes nothing')

  // a fresh store over the same DAG materializes the identical state (restart determinism)
  const store2 = revisions.exportStore()
  assert.deepEqual(materializedAll(store2), before)
})

test('dvv: sub-flag OFF after ON — dvv data inert, legacy behavior identical', () => {
  db.call('revisionsFlagDvv', { on: false })
  assert.equal(db.call('revisionsFlagState').dvv, false)
  seedTodo('dv1', 'edit with dvv off')

  const rows = db.call('revisionsList', { entityId: 'dv1' })
  assert.ok(!rows[rows.length - 1].dvv, 'new revision minted WITHOUT dvv (sub-flag off)')
  const store = revisions.exportStore()
  assert.equal(store.useDvv, false, 'exportStore falls back to the legacy store when the sub-flag is off')

  // re-enable: recording resumes with dvv; the old dvv-less rows keep exporting fine
  db.call('revisionsFlagDvv', { on: true })
  seedTodo('dv1', 'edit with dvv back on')
  const rows2 = db.call('revisionsList', { entityId: 'dv1' })
  assert.ok(rows2[rows2.length - 1].dvv, 'dvv recording resumes')
  assert.ok(materializedAll(revisions.exportStore())['dv1'], 'mixed dvv/dvv-less DAG still materializes')
})

// ---- raw recorder fixture (plain temp SQLite, mirrors db-revisions-prune-defer-index) ----
const Database = require('../../../vendor/better-sqlite3-multiple-ciphers')

function makeFixture ({ dvvFlag, counter, dots, revs, createDvvTable } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-db-rev-dvv-fx-'))
  const raw = new Database(path.join(dir, 'todos.db'))
  raw.exec(`
    CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT);
    CREATE TABLE settings_rows (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE sync_revisions (
      revisionId TEXT PRIMARY KEY, entity TEXT NOT NULL, entityId TEXT NOT NULL,
      authorDeviceId TEXT NOT NULL, hlcPhysical INTEGER NOT NULL, hlcLogical INTEGER NOT NULL,
      parents TEXT NOT NULL DEFAULT '[]', payloadHash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending', createdAt INTEGER NOT NULL
    );
    CREATE TABLE sync_revision_payloads (revisionId TEXT PRIMARY KEY, payload TEXT NOT NULL);
    CREATE TABLE sync_revision_current (entityId TEXT PRIMARY KEY, revisionId TEXT NOT NULL);
  `)
  raw.prepare("INSERT INTO settings_rows (key, value) VALUES ('sync.revisions.v2', '1')").run()
  if (dvvFlag) raw.prepare("INSERT INTO settings_rows (key, value) VALUES ('sync.revisions.v2.dvv', '1')").run()
  if (counter != null) raw.prepare("INSERT INTO settings_rows (key, value) VALUES ('sync.dvvCounter', ?)").run(String(counter))
  raw.prepare("INSERT INTO settings_rows (key, value) VALUES ('sync.deviceId', 'fx-node')").run()
  if (createDvvTable || (dots && dots.length)) {
    raw.exec('CREATE TABLE sync_revision_dvv (revisionId TEXT PRIMARY KEY, dvv TEXT NOT NULL)')
  }
  // dvv-LESS revision rows (a pre-DVV database: ancestry + payloads only)
  for (const d of revs || []) {
    raw.prepare(`INSERT INTO sync_revisions
      (revisionId, entity, entityId, authorDeviceId, hlcPhysical, hlcLogical, parents, payloadHash, status, createdAt)
      VALUES (?, 'todo', 'fx', 'fx-node', ?, 0, '[]', 'h', 'pending', 0)`).run('rev-' + d, 900 + d)
    raw.prepare('INSERT INTO sync_revision_payloads (revisionId, payload) VALUES (?, ?)').run('rev-' + d, JSON.stringify({ n: d }))
  }
  // revision rows WITH persisted dvv dots
  if (dots && dots.length) {
    for (const d of dots) {
      raw.prepare(`INSERT INTO sync_revisions
        (revisionId, entity, entityId, authorDeviceId, hlcPhysical, hlcLogical, parents, payloadHash, status, createdAt)
        VALUES (?, 'todo', 'fx', 'fx-node', ?, 0, '[]', 'h', 'pending', 0)`).run('dot-' + d, 1000 + d)
      raw.prepare('INSERT INTO sync_revision_payloads (revisionId, payload) VALUES (?, ?)').run('dot-' + d, JSON.stringify({ n: d }))
      raw.prepare('INSERT INTO sync_revision_dvv (revisionId, dvv) VALUES (?, ?)').run('dot-' + d,
        JSON.stringify({ dot: { deviceId: 'fx-node', counter: d }, context: { 'fx-node': d } }))
    }
  }
  const rec = require('../../../src/main/db-revisions.cjs')({
    getDb: () => raw,
    log: { info () {}, warn () {}, error () {} },
  })
  return { raw, rec, close: () => { try { raw.close() } catch {} } }
}

test('dvv fixture: lazy table creation — flag on + missing table → created on first write, dots mint from the persisted counter', () => {
  const fx = makeFixture({ dvvFlag: true, counter: 10 })
  try {
    assert.equal(fx.rec.dvvTableExists(fx.raw), false, 'fixture starts without the side table')
    const r = fx.rec.record([{ entity: 'todo', entityId: 'fx', ts: 1 }])
    assert.equal(r.recorded, 1)
    assert.equal(fx.rec.dvvTableExists(fx.raw), true, 'table created lazily inside the write path')
    const row = fx.rec.list('fx')[0]
    assert.ok(row.dvv, 'write carries a dvv')
    assert.equal(row.dvv.dot.counter, 11, 'dot continues beyond the PERSISTED counter (10 → 11), not from zero')
  } finally { fx.close() }
})

test('dvv fixture: old-data fallback — dvv-less rows export fine, unknown → ancestry owns ordering', () => {
  // fixture WITHOUT the dvv table but WITH seeded dvv-less revision rows: a pre-DVV database
  const fx = makeFixture({ revs: [1, 2] })
  try {
    const store = fx.rec.exportToStore(createRevisionStore, applyEnvelope, { useDvv: true }) // engine opted in, data absent
    assert.equal(store.useDvv, true)
    const [a, b] = [...store.revisions.values()]
    assert.ok(a && b, 'both seeded rows exported')
    assert.ok(!a.dvv && !b.dvv, 'no dvv attached (table absent — probe-guarded read, no throw)')
    assert.equal(dvvRelation(b, a), 'unknown', 'dvv-less envelopes classify as unknown')
    // the ancestry fallback still resolves ordering: re-applying the current revision dedupes
    assert.equal(applyEnvelope(store, b).status, 'duplicate')
  } finally { fx.close() }
})

test('dvv fixture: stale counter + higher persisted dots → belt-scan keeps dots monotone', () => {
  // counter row says 1, but dots up to 3 are persisted (e.g. partially restored backup):
  // the max-scan over the device's own dots must floor the next mint above 3
  const fx = makeFixture({ dvvFlag: true, counter: 1, dots: [1, 2, 3] })
  try {
    fx.raw.prepare("INSERT INTO sync_revision_current (entityId, revisionId) VALUES ('fx', 'dot-3')").run()
    const r = fx.rec.record([{ entity: 'todo', entityId: 'fx', ts: 1 }])
    assert.equal(r.recorded, 1)
    const row = fx.rec.list('fx').find(x => x.revisionId !== 'dot-1' && x.revisionId !== 'dot-2' && x.revisionId !== 'dot-3')
    assert.ok(row && row.dvv, 'new write minted a dvv')
    assert.equal(row.dvv.dot.counter, 4, 'next dot is 4 — the persisted-dot scan floor beat the stale counter (1)')
  } finally { fx.close() }
})

test('dvv fixture: dropped table self-heals on the next flagged write without throwing', () => {
  const fx = makeFixture({ dvvFlag: true, counter: 5, createDvvTable: true })
  try {
    fx.raw.exec('DROP TABLE sync_revision_dvv')
    const r = fx.rec.record([{ entity: 'todo', entityId: 'heal', ts: 1 }])
    assert.equal(r.recorded, 1, 'write path survives a dropped side table (ensure re-creates it)')
    assert.equal(fx.rec.dvvTableExists(fx.raw), true, 'table re-created')
    const row = fx.rec.list('heal')[0]
    assert.ok(row.dvv, 'post-heal write carries dvv again')
    assert.equal(row.dvv.dot.counter, 6, 'counter continuity preserved across the drop (persisted counter row governs)')
  } finally { fx.close() }
})
