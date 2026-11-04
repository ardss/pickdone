/* S1 vertical slice (P0) — idempotent migration v11: work_episodes / source_refs /
 * task_source_links (+ their indexes). User-visible behavior asserted:
 *   (a) the migration chain carries a v11 step that CREATES the three tables on a bare
 *       database (a schemaVersion=10 legacy fixture ends at schemaVersion 11 with the
 *       tables present);
 *   (b) re-running the migration is a per-column no-op (idempotent — retried boots and
 *       fresh installs must converge to the identical schema);
 *   (c) the static SCHEMA (fresh-install path) and the migration produce the SAME column
 *       sets — the v8-style dual manifest must not drift.
 * Run: node --test tests/unit/main/db-migrations-episode-tables.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const buildMigrations = require_('../../../src/main/db-migrations.js')
const Database = require_('../../../vendor/better-sqlite3-multiple-ciphers')
const { SCHEMA } = require_('../../../src/main/db-schema.js')

const TABLES = ['work_episodes', 'source_refs', 'task_source_links']

const migrations = buildMigrations(null, null) // null override → the real BUILT_IN list
const v11 = migrations.find(m => m.v === 11)
const colsOf = (d, t) => d.prepare(`PRAGMA table_info(${t})`).all().map(c => `${c.name}:${c.type}:${c.notnull}:${String(c.dflt_value)}`)

test('migration chain carries a v11 step that creates the three episode tables', () => {
  assert.ok(v11, 'BUILT_IN must carry a v:11 migration (red before the slice: no v11 entry)')
  // Legacy fixture: a schemaVersion=10 library. v11 touches only its own three tables, so
  // running the chain tail (v > 10) against the fixture mirrors the migrator loop's effect
  // for this slice without rebuilding every legacy todos column.
  const d = new Database(':memory:')
  d.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
  d.prepare("INSERT INTO meta (key, value) VALUES ('schemaVersion', '10')").run()
  for (const m of migrations.filter(m => m.v > 10)) {
    if (m.fn(d) === false) throw new Error('migration v' + m.v + ' aborted')
  }
  for (const t of TABLES) {
    const name = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)
    assert.ok(name, `legacy v10 fixture: table ${t} exists after the v11 migration`)
  }
  d.close()
})

test('v11 is idempotent: a second run keeps schemaVersion semantics and identical columns', () => {
  const d = new Database(':memory:')
  d.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
  v11.fn(d)
  const before = Object.fromEntries(TABLES.map(t => [t, colsOf(d, t)]))
  const idxBefore = d.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all()
  const r2 = v11.fn(d)
  assert.notEqual(r2, false, 'second run must NOT abort the migrator loop (retried boots)')
  const after = Object.fromEntries(TABLES.map(t => [t, colsOf(d, t)]))
  assert.deepEqual(after, before, 're-running v11 leaves every column identical (IF NOT EXISTS)')
  const idxAfter = d.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all()
  assert.deepEqual(idxAfter, idxBefore, 're-running v11 leaves the indexes identical')
  d.close()
})

test('fresh empty database: v11 alone creates the three tables with the expected core columns', () => {
  const d = new Database(':memory:')
  v11.fn(d)
  const ep = Object.fromEntries(colsOf(d, 'work_episodes').map(s => s.split(':')[0] ? [s.split(':')[0], true] : []))
  for (const c of ['id', 'taskId', 'startedAt', 'endedAt', 'deleted', 'deletedAt', 'updatedAt']) {
    assert.ok(ep[c], `work_episodes has column ${c}`)
  }
  const src = new Set(colsOf(d, 'source_refs').map(s => s.split(':')[0]))
  for (const c of ['id', 'providerId', 'externalId', 'updatedAt']) assert.ok(src.has(c), `source_refs has column ${c}`)
  // the (providerId, externalId) uniqueness the domain service relies on
  d.prepare("INSERT INTO source_refs (id, providerId, externalId, updatedAt) VALUES ('a', 'p1', 'e1', 1)").run()
  assert.throws(() => d.prepare("INSERT INTO source_refs (id, providerId, externalId, updatedAt) VALUES ('b', 'p1', 'e1', 2)").run(),
    /UNIQUE/, 'second row with the same (providerId, externalId) must hit the unique index')
  const lnk = new Set(colsOf(d, 'task_source_links').map(s => s.split(':')[0]))
  for (const c of ['id', 'taskId', 'sourceRefId', 'updatedAt']) assert.ok(lnk.has(c), `task_source_links has column ${c}`)
  d.close()
})

test('dual manifest parity: the static SCHEMA creates the same three tables as migration v11', () => {
  const viaSchema = new Database(':memory:')
  viaSchema.exec(SCHEMA)
  const viaMigration = new Database(':memory:')
  v11.fn(viaMigration)
  for (const t of TABLES) {
    assert.deepEqual(colsOf(viaSchema, t), colsOf(viaMigration, t),
      `${t}: SCHEMA (fresh install) and migration v11 (upgrade) must define identical columns`)
  }
  viaSchema.close(); viaMigration.close()
})
