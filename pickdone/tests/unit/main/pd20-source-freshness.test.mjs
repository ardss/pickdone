/* pd20 P0 work-continuity (2026-11-07) — SourceRef verification state (RED first).
 *
 * Mission P0-2 requires: "原始证据可访问与 stale/unknown 失效指示" — a source ref must carry
 * its provenance level (L0 statement / L1 observed artifact / L2 independent QA) and a
 * last-verified stamp, and the read view must DEGRADE honestly: a ref never verified reads
 * 'unknown', a ref whose verification aged out reads 'stale', a recently verified one reads
 * 'fresh'. Today the read hardcodes level:'L0' and there is NO verification column at all.
 *
 * Run: node --test tests/unit/main/pd20-source-freshness.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const buildMigrations = require_('../../../src/main/db-migrations.js')
const episodeOps = require_('../../../src/main/db-episode-ops.cjs')
const Database = require_('../../../vendor/better-sqlite3-multiple-ciphers')

const migrations = buildMigrations(null, null)
const v11 = migrations.find(m => m.v === 11)
const v12 = migrations.find(m => m.v === 12)

/** Legacy-shaped fixture: a bare db at v11 (source_refs WITHOUT verification columns). */
function wiredAt (migrationsToApply) {
  const d = new Database(':memory:')
  for (const m of migrationsToApply) m.fn(d)
  return d
}

const DAY = 24 * 60 * 60 * 1000

test('v12 migration probe-adds level/lastVerifiedAt to a legacy v11 source_refs (idempotent)', () => {
  assert.ok(v12, 'a v12 migration entry must exist')
  const d = wiredAt([v11])
  v12.fn(d)
  const cols = d.prepare('PRAGMA table_info(source_refs)').all().map(c => c.name)
  assert.ok(cols.includes('level'), 'level column added on the legacy shape')
  assert.ok(cols.includes('lastVerifiedAt'), 'lastVerifiedAt column added on the legacy shape')
  v12.fn(d) // re-run must be a no-op (probe-style), not a duplicate-column error
  const legacyRow = d.prepare("INSERT INTO source_refs (id, providerId, externalId, title, deleted, deletedAt, updatedAt) VALUES ('s0','github','x',NULL,0,0,1)").run()
  assert.equal(legacyRow.changes, 1, 'legacy inserts (no new columns) still work')
})

test('sourcePut stores an explicit level + lastVerifiedAt; an out-of-family level stores as unknown (never fabricated)', () => {
  const d = wiredAt([v11, v12])
  episodeOps.sourcePut(d, { providerId: 'github', externalId: 'u1', title: 'issue', level: 'L1', lastVerifiedAt: 1234 })
  const row = d.prepare('SELECT level, lastVerifiedAt FROM source_refs WHERE externalId = ?').get('u1')
  assert.equal(row.level, 'L1')
  assert.equal(row.lastVerifiedAt, 1234)
  episodeOps.sourcePut(d, { providerId: 'file', externalId: 'u2', level: 'L9', lastVerifiedAt: 0 })
  const bad = d.prepare('SELECT level, lastVerifiedAt FROM source_refs WHERE externalId = ?').get('u2')
  assert.equal(bad.level, null, 'a level outside L0/L1/L2 must not be stored verbatim (fabricated provenance)')
  assert.equal(bad.lastVerifiedAt, 0)
})

test("querySourcesByTask surfaces freshness: never-verified reads 'unknown', aged-out reads 'stale', recent reads 'fresh'; level is the REAL stored level", () => {
  const d = wiredAt([v11, v12])
  const now = Date.now()
  const tid = 't-fresh'
  episodeOps.sourcePut(d, { providerId: 'github', externalId: 'never', level: 'L0' })
  episodeOps.sourcePut(d, { providerId: 'github', externalId: 'aged', level: 'L2', lastVerifiedAt: now - 30 * DAY })
  episodeOps.sourcePut(d, { providerId: 'github', externalId: 'recent', level: 'L1', lastVerifiedAt: now - 2 * DAY })
  for (const ext of ['never', 'aged', 'recent']) {
    const ref = d.prepare('SELECT id FROM source_refs WHERE externalId = ?').get(ext)
    episodeOps.taskSourcePut(d, { taskId: tid, sourceRefId: ref.id })
  }
  const rows = episodeOps.querySourcesByTask(d, tid)
  assert.equal(rows.length, 3)
  const byUri = Object.fromEntries(rows.map(r => [r.externalId, r]))
  assert.equal(byUri.never.freshness, 'unknown', 'no verification stamp -> unknown (not silently fresh)')
  assert.equal(byUri.aged.freshness, 'stale', 'verification older than the staleness horizon -> stale')
  assert.equal(byUri.recent.freshness, 'fresh')
  assert.equal(byUri.aged.level, 'L2', 'level is the stored provenance level, not a hardcoded L0')
  assert.equal(byUri.never.level, 'L0')
  assert.equal(typeof byUri.aged.lastVerifiedAt, 'number')
})

test('querySourcesByTask stays backward-compatible: a legacy row (level NULL) reads level L0 + freshness unknown', () => {
  const d = wiredAt([v11, v12])
  d.prepare("INSERT INTO source_refs (id, providerId, externalId, title, deleted, deletedAt, updatedAt) VALUES ('s-leg','github','leg','legacy',0,0,1)").run()
  episodeOps.taskSourcePut(d, { taskId: 't2', sourceRefId: 's-leg' })
  const rows = episodeOps.querySourcesByTask(d, 't2')
  assert.equal(rows[0].level, 'L0', 'NULL level displays as the L0 baseline (statement-level provenance)')
  assert.equal(rows[0].freshness, 'unknown')
})
