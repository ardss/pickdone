import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// perf-sync-revisions-prune-inline-write-stall (P3):
// 1. prunePayloads used to run synchronously inside record() after each commit — every write
//    stalled behind a per-write COUNT + bulk DELETE (symptom of "v2 write path does synchronous
//    maintenance inline"). The prune must be deferred out of the write hot path.
// 2. The recent-keep window pick (ORDER BY hlcPhysical DESC, hlcLogical DESC) had no covering
//    index — every prune sorted the whole sync_revisions table (TEMP B-TREE).
// Plain-node fixture (cannot require electron db.js here without the full init side effects):
// drive createRevisionRecorder directly with a getDb stub against the vendor sqlite driver.

const require = createRequire(import.meta.url)
const Database = require('../../../vendor/better-sqlite3-multiple-ciphers')
const createRevisionRecorder = require('../../../src/main/db-revisions.cjs')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-db-rev-defer-'))
const db = new Database(path.join(dir, 'todos.db'))
db.exec(`
  CREATE TABLE todos (id TEXT PRIMARY KEY, title TEXT);
  CREATE TABLE settings_rows (key TEXT PRIMARY KEY, value TEXT);
  CREATE TABLE sync_revisions (
    revisionId TEXT PRIMARY KEY, entity TEXT NOT NULL, entityId TEXT NOT NULL,
    authorDeviceId TEXT NOT NULL, hlcPhysical INTEGER NOT NULL, hlcLogical INTEGER NOT NULL,
    parents TEXT NOT NULL DEFAULT '[]', payloadHash TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending', createdAt INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_sync_revisions_entity ON sync_revisions(entityId, hlcPhysical, hlcLogical);
  CREATE TABLE sync_revision_payloads (revisionId TEXT PRIMARY KEY, payload TEXT NOT NULL);
  CREATE TABLE sync_revision_current (entityId TEXT PRIMARY KEY, revisionId TEXT NOT NULL);
`)
// create the sync_revisions indexes from the REAL migration v8 source (single source of truth)
const buildMigrations = require('../../../src/main/db-migrations.js')
for (const m of buildMigrations({}, null)) {
  if (m.v === 8) m.fn(db)
}
// flag forced ON so record() actually writes
db.prepare("INSERT INTO settings_rows (key, value) VALUES ('sync.revisions.v2', '1')").run()
db.prepare("INSERT INTO settings_rows (key, value) VALUES ('sync.deviceId', 'test-node')").run()

const revisions = createRevisionRecorder({
  getDb: () => db,
  log: { info () {}, warn () {}, error () {} }
})

function seedBacklog (n) {
  const now = 1_000_000
  const insRev = db.prepare(`INSERT INTO sync_revisions
    (revisionId, entity, entityId, authorDeviceId, hlcPhysical, hlcLogical, parents, payloadHash, status, createdAt)
    VALUES (?, 'todo', 'old', 'x', ?, 0, '[]', 'h', 'pending', ?)`)
  const insPay = db.prepare('INSERT INTO sync_revision_payloads (revisionId, payload) VALUES (?, ?)')
  const tx = db.transaction(() => {
    for (let i = 0; i < n; i++) {
      insRev.run('old-' + i, now + i, now)
      insPay.run('old-' + i, JSON.stringify({ old: true }))
    }
  })
  tx()
}

test('prune is NOT invoked synchronously inside record() (deferred via setImmediate)', async () => {
  process.env.TODO_REVISION_PAYLOAD_KEEP = '20' // keep 20, hysteresis fires above 25
  const keep = revisions.payloadKeep()
  seedBacklog(keep + 60) // way past the prune threshold

  // record one fresh write; its revision becomes the entity's current pointer
  const before = db.prepare('SELECT COUNT(*) n FROM sync_revision_payloads').get().n
  revisions.record([{ entity: 'todo', entityId: 'fresh-1' }])
  const afterSync = db.prepare('SELECT COUNT(*) n FROM sync_revision_payloads').get().n

  // pre-fix behavior: prune already ran inside record() → count dropped synchronously.
  // Post-fix: nothing pruned yet — the deferred callback has not had a turn.
  assert.equal(afterSync, before + 1, 'prune must NOT run synchronously inside record() (count unchanged right after record returns)')

  // after one macrotask turn the deferred prune runs and the backlog is bounded
  await new Promise(resolve => setImmediate(resolve))
  const afterDeferred = db.prepare('SELECT COUNT(*) n FROM sync_revision_payloads').get().n
  assert.ok(afterDeferred <= keep + Math.floor(keep / 4) + 1,
    'deferred prune bounds the table, got ' + afterDeferred)
  assert.ok(afterDeferred < afterSync, 'deferred prune actually pruned rows')
})

test('recent-keep window pick is index-backed (idx_sync_revisions_hlc exists, no TEMP B-TREE sort)', () => {
  const idx = db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sync_revisions_hlc'").get()
  assert.ok(idx, 'idx_sync_revisions_hlc must exist on sync_revisions')

  const plan = db.prepare(
    'EXPLAIN QUERY PLAN SELECT revisionId FROM sync_revisions ORDER BY hlcPhysical DESC, hlcLogical DESC LIMIT 20'
  ).all()
  const planText = plan.map(r => r.detail).join(' | ')
  assert.ok(!/TEMP B-TREE/i.test(planText), 'ORDER BY must not sort via TEMP B-TREE, plan: ' + planText)
})

test('perf probe: ORDER BY hlcPhysical DESC with index is faster than without (deterministic probe)', () => {
  const N = 20000
  seedBacklogExtra(N)
  const q = 'SELECT revisionId FROM sync_revisions ORDER BY hlcPhysical DESC, hlcLogical DESC LIMIT 20'

  db.exec('DROP INDEX IF EXISTS idx_sync_revisions_hlc')
  t0(q)
  const without = t0(q)
  db.exec('CREATE INDEX idx_sync_revisions_hlc ON sync_revisions(hlcPhysical DESC, hlcLogical DESC)')
  const withIdx = t0(q)

  assert.ok(withIdx <= without, `indexed (${withIdx.toFixed(1)}ms) should not be slower than unindexed (${without.toFixed(1)}ms)`)
  console.log(`perf probe rows=${N}: no-index ${without.toFixed(1)}ms → indexed ${withIdx.toFixed(1)}ms`)
})

function seedBacklogExtra (n) {
  const base = db.prepare('SELECT MAX(hlcPhysical) m FROM sync_revisions').get().m || 0
  const insRev = db.prepare(`INSERT INTO sync_revisions
    (revisionId, entity, entityId, authorDeviceId, hlcPhysical, hlcLogical, parents, payloadHash, status, createdAt)
    VALUES (?, 'todo', 'probe', 'x', ?, 0, '[]', 'h', 'pending', 0)`)
  const tx = db.transaction(() => {
    for (let i = 0; i < n; i++) insRev.run('probe-' + i, base + i + 1)
  })
  tx()
}

function t0 (q) {
  db.prepare(q).all() // warm
  const s = process.hrtime.bigint()
  db.prepare(q).all()
  return Number(process.hrtime.bigint() - s) / 1e6
}
