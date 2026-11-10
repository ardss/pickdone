/* pd20 (2026-11-10) — S1 Finding/Decision closure (migration v14): the two entities the
 * mission §04 contract still lacked after v13 (Task/Episode/SourceRef/Handoff existed).
 * User-visible behavior asserted through the same doors the app uses:
 *   (a) migration v14 CREATES work_findings + work_decisions on an existing v11+v12+v13
 *       library (additive, IF NOT EXISTS — legacy dbs upgrade in place, zero data loss);
 *   (b) v14 is idempotent (a retried boot converges to identical columns/indexes) and the
 *       fresh-install SCHEMA DDL stays column-identical to the migration (dual manifest);
 *   (c) finding.put stores a KNOWN confidence {high,medium,low} and verificationLevel
 *       {observed,inferred,speculation}; an out-of-family value stores NULL — never
 *       fabricate (same doctrine as episode.role / source_refs.level);
 *   (d) THE MISSION RULE: a speculation finding can NEVER carry status 'confirmed' —
 *       a guess must not become an acceptance conclusion (storage normalizes to 'open');
 *   (e) finding sourceRefs is a JSON array of source-ref ids (invalid shapes store NULL);
 *   (f) decision.put stores choice/alternatives/tradeoffs/decider/rationale/
 *       relatedFindings + the supersedes relation; queryDecisionsByTask surfaces the
 *       reverse relation (supersededBy) computed from live rows;
 *   (g) queryFindingsByTask / queryDecisionsByTask are the read-only view models (live
 *       rows only, tombstoned rows invisible);
 *   (h) removes are tombstones returning the ids ACTUALLY changed (row-granular contract).
 * Run: node --test tests/unit/main/pd20-finding-decision.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const buildMigrations = require_('../../../src/main/db-migrations.js')
const episodeOps = require_('../../../src/main/db-episode-ops.cjs')
const Database = require_('../../../vendor/better-sqlite3-multiple-ciphers')
const { SCHEMA } = require_('../../../src/main/db-schema.js')

const migrations = buildMigrations(null, null)
const v11 = migrations.find(m => m.v === 11)
const v12 = migrations.find(m => m.v === 12)
const v13 = migrations.find(m => m.v === 13)
const v14 = migrations.find(m => m.v === 14)
const TABLES = ['work_findings', 'work_decisions']
const colsOf = (d, t) => d.prepare(`PRAGMA table_info(${t})`).all().map(c => `${c.name}:${c.type}:${c.notnull}:${String(c.dflt_value)}`)

/** A pre-v14 library (v11 tables + v12 verification columns + v13 role column). */
function legacyDb () {
  const d = new Database(':memory:')
  v11.fn(d)
  v12.fn(d)
  v13.fn(d)
  return d
}

test('migration v14 creates the finding/decision tables on an existing v11+v12+v13 library; legacy rows survive', () => {
  assert.ok(v14, 'migration chain must carry a v:14 step (red before the slice: no v14 entry)')
  const d = legacyDb()
  // Legacy data already in the library: v14 must not lose a single row.
  d.prepare('INSERT INTO work_episodes (id, taskId, startedAt, note, role, deleted, deletedAt, updatedAt) VALUES (?, ?, ?, ?, ?, 0, 0, ?)')
    .run('ep-legacy', 't1', 1000, 'goal: legacy round', 'agent', 1000)
  d.prepare('INSERT INTO source_refs (id, providerId, externalId, title, level, deleted, deletedAt, updatedAt) VALUES (?, ?, ?, ?, ?, 0, 0, ?)')
    .run('src-legacy', 'web', 'https://example.com', 'spec', 'L1', 1000)
  v14.fn(d)
  for (const t of TABLES) {
    const name = d.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(t)
    assert.ok(name, `legacy library: table ${t} exists after the v14 migration`)
  }
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM work_episodes').get().n, 1, 'legacy episodes survive the upgrade')
  assert.equal(d.prepare('SELECT COUNT(*) AS n FROM source_refs').get().n, 1, 'legacy source refs survive the upgrade')
  assert.equal(d.prepare('SELECT role FROM work_episodes WHERE id = ?').get('ep-legacy').role, 'agent', 'legacy episode data intact')
})

test('v14 is idempotent: a second run keeps identical columns and indexes', () => {
  const d = new Database(':memory:')
  v11.fn(d); v12.fn(d); v13.fn(d)
  v14.fn(d)
  const before = Object.fromEntries(TABLES.map(t => [t, colsOf(d, t)]))
  const idxBefore = d.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all()
  const r2 = v14.fn(d)
  assert.notEqual(r2, false, 'second run must NOT abort the migrator loop (retried boots)')
  const after = Object.fromEntries(TABLES.map(t => [t, colsOf(d, t)]))
  assert.deepEqual(after, before, 're-running v14 leaves every column identical (IF NOT EXISTS)')
  const idxAfter = d.prepare("SELECT name, sql FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name").all()
  assert.deepEqual(idxAfter, idxBefore, 're-running v14 leaves the indexes identical')
})

test('dual manifest parity: fresh-install SCHEMA and the v14 migration produce identical column sets', () => {
  // The SCHEMA static string carries the CREATE TABLE copies for fresh installs; the v14
  // migration is the upgrade path (v8-style dual manifest — v11 doctrine).
  const fresh = new Database(':memory:')
  fresh.exec(SCHEMA)
  const upgraded = legacyDb()
  v14.fn(upgraded)
  for (const t of TABLES) {
    assert.deepEqual(colsOf(upgraded, t), colsOf(fresh, t), `SCHEMA and v14 must agree on ${t} columns`)
  }
})

test('finding.put stores known confidence/verificationLevel; out-of-family stores NULL (never fabricate)', () => {
  const d = legacyDb()
  v14.fn(d)
  const idA = episodeOps.findingPut(d, { taskId: 't1', statement: 'Build fails on Node 20', confidence: 'high', verificationLevel: 'observed', createdBy: 'agent:A', ts: 1 })
  const idM = episodeOps.findingPut(d, { taskId: 't1', statement: 'Maybe a config drift', confidence: 'medium', verificationLevel: 'inferred', createdBy: 'agent:A', ts: 2 })
  const idX = episodeOps.findingPut(d, { taskId: 't1', statement: 'Fabricated certainty', confidence: 'certain', verificationLevel: 'divine', createdBy: 'agent:A', ts: 3 })
  const fA = d.prepare('SELECT * FROM work_findings WHERE id = ?').get(idA)
  assert.equal(fA.confidence, 'high')
  assert.equal(fA.verificationLevel, 'observed')
  assert.equal(d.prepare('SELECT confidence, verificationLevel FROM work_findings WHERE id = ?').get(idM).confidence, 'medium')
  const fX = d.prepare('SELECT * FROM work_findings WHERE id = ?').get(idX)
  assert.equal(fX.confidence, null, "out-of-family confidence ('certain') is not fabricated")
  assert.equal(fX.verificationLevel, null, "out-of-family verificationLevel ('divine') is not fabricated")
  // finding.put requires taskId + statement
  assert.throws(() => episodeOps.findingPut(d, { statement: 'no task' }), /taskId is required/)
  assert.throws(() => episodeOps.findingPut(d, { taskId: 't1' }), /statement is required/)
})

test('THE MISSION RULE: a speculation finding can never carry status confirmed (a guess is not an acceptance conclusion)', () => {
  const d = legacyDb()
  v14.fn(d)
  // The caller tries to mark a speculation as confirmed — storage must not persist that.
  const id = episodeOps.findingPut(d, { taskId: 't1', statement: 'I guess the port is blocked', verificationLevel: 'speculation', status: 'confirmed', createdBy: 'agent:A', ts: 1 })
  const f = d.prepare('SELECT verificationLevel, status FROM work_findings WHERE id = ?').get(id)
  assert.equal(f.verificationLevel, 'speculation')
  assert.equal(f.status, 'open', 'speculation + confirmed normalizes to open at storage — never a fabricated acceptance conclusion')
  // Same-id correction to an OBSERVED level may confirm for real.
  episodeOps.findingPut(d, { id, taskId: 't1', statement: 'Verified: port blocked by firewall', verificationLevel: 'observed', status: 'confirmed', createdBy: 'agent:QA', ts: 2 })
  const f2 = d.prepare('SELECT verificationLevel, status FROM work_findings WHERE id = ?').get(id)
  assert.equal(f2.verificationLevel, 'observed')
  assert.equal(f2.status, 'confirmed', 'an observed finding CAN be confirmed (same-id put corrects)')
})

test('finding sourceRefs is a JSON array of source-ref ids; invalid shapes store NULL', () => {
  const d = legacyDb()
  v14.fn(d)
  const id = episodeOps.findingPut(d, { taskId: 't1', statement: 's', sourceRefs: ['src-1', 'src-2'], createdBy: 'agent:A', ts: 1 })
  assert.deepEqual(JSON.parse(d.prepare('SELECT sourceRefs FROM work_findings WHERE id = ?').get(id).sourceRefs), ['src-1', 'src-2'])
  const idBad = episodeOps.findingPut(d, { taskId: 't1', statement: 's', sourceRefs: 'src-1', createdBy: 'agent:A', ts: 2 })
  assert.equal(d.prepare('SELECT sourceRefs FROM work_findings WHERE id = ?').get(idBad).sourceRefs, null, 'a bare string is not an array — stores NULL, never a fabricated shape')
  const idNo = episodeOps.findingPut(d, { taskId: 't1', statement: 's', createdBy: 'agent:A', ts: 3 })
  assert.equal(d.prepare('SELECT sourceRefs FROM work_findings WHERE id = ?').get(idNo).sourceRefs, null)
})

test('queryFindingsByTask returns the live view model; tombstoned rows are invisible', () => {
  const d = legacyDb()
  v14.fn(d)
  const idA = episodeOps.findingPut(d, { taskId: 't1', statement: 'first observed', confidence: 'high', verificationLevel: 'observed', status: 'confirmed', createdBy: 'agent:A', sourceRefs: ['src-9'], ts: 1 })
  episodeOps.findingPut(d, { taskId: 't1', statement: 'second guess', verificationLevel: 'speculation', createdBy: 'agent:B', ts: 2 })
  episodeOps.findingPut(d, { taskId: 't2', statement: 'other task', createdBy: 'agent:A', ts: 3 })
  const rows = episodeOps.queryFindingsByTask(d, 't1')
  assert.equal(rows.length, 2, 'only this task\'s live findings')
  const f1 = rows.find(r => r.findingId === idA)
  assert.deepEqual([f1.statement, f1.confidence, f1.verificationLevel, f1.status, f1.createdBy, f1.sourceRefs], ['first observed', 'high', 'observed', 'confirmed', 'agent:A', ['src-9']])
  const guess = rows.find(r => r.statement === 'second guess')
  assert.equal(guess.status, 'open', 'in-family missing status reads open')
  assert.equal(guess.confidence, 'unknown', 'NULL (out-of-family/omitted) confidence reads unknown at the view layer — honest, never fabricated')
  // Tombstone one: the read shrinks; the remove returns the ids ACTUALLY changed.
  const changed = episodeOps.findingRemoveIds(d, [rows[0].findingId, 'ep-ghost'])
  assert.deepEqual(changed, [rows[0].findingId], 'row-granular remove: a ghost id is a no-op')
  assert.equal(episodeOps.queryFindingsByTask(d, 't1').length, 1, 'tombstoned finding is invisible')
  assert.equal(episodeOps.queryFindingsByTask(d, '').length, 0, 'empty taskId → empty list')
})

test('decision.put stores choice/alternatives/tradeoffs/decider/rationale/relatedFindings/supersedes', () => {
  const d = legacyDb()
  v14.fn(d)
  const fid = episodeOps.findingPut(d, { taskId: 't1', statement: 'port blocked', verificationLevel: 'observed', createdBy: 'agent:A', ts: 1 })
  const id = episodeOps.decisionPut(d, {
    taskId: 't1', choice: 'switch to the LAN transport', alternatives: ['keep HTTP bridge', 'drop mobile'],
    tradeoffs: ['more work now', 'safe on real devices'], decider: 'agent:B', rationale: 'mixed content kills WebView',
    relatedFindings: [fid], ts: 5
  })
  const row = d.prepare('SELECT * FROM work_decisions WHERE id = ?').get(id)
  assert.equal(row.choice, 'switch to the LAN transport')
  assert.deepEqual(JSON.parse(row.alternatives), ['keep HTTP bridge', 'drop mobile'])
  assert.deepEqual(JSON.parse(row.tradeoffs), ['more work now', 'safe on real devices'])
  assert.equal(row.decider, 'agent:B')
  assert.equal(row.rationale, 'mixed content kills WebView')
  assert.deepEqual(JSON.parse(row.relatedFindings), [fid])
  assert.equal(row.supersedes, null)
  assert.throws(() => episodeOps.decisionPut(d, { taskId: 't1' }), /choice is required/)
  assert.throws(() => episodeOps.decisionPut(d, { choice: 'no task' }), /taskId is required/)
  // Non-array list shapes store NULL — never a fabricated shape.
  const idBad = episodeOps.decisionPut(d, { taskId: 't1', choice: 'c', alternatives: 'single', relatedFindings: 'not-array', ts: 6 })
  const bad = d.prepare('SELECT alternatives, relatedFindings FROM work_decisions WHERE id = ?').get(idBad)
  assert.equal(bad.alternatives, null)
  assert.equal(bad.relatedFindings, null)
})

test('queryDecisionsByTask surfaces the reverse supersede relation (supersededBy) from live rows', () => {
  const d = legacyDb()
  v14.fn(d)
  const d1 = episodeOps.decisionPut(d, { taskId: 't1', choice: 'use HTTP bridge', decider: 'agent:A', ts: 1 })
  const d2 = episodeOps.decisionPut(d, { taskId: 't1', choice: 'use native HTTP transport', decider: 'agent:B', supersedes: d1, ts: 2 })
  const rows = episodeOps.queryDecisionsByTask(d, 't1')
  assert.equal(rows.length, 2)
  const r1 = rows.find(r => r.decisionId === d1)
  const r2 = rows.find(r => r.decisionId === d2)
  assert.deepEqual(r1.supersededBy, [d2], 'the live successor points back at the revoked decision')
  assert.equal(r2.supersededBy, null)
  assert.deepEqual(r2.supersedes, d1, 'the successor keeps its forward supersedes id')
  // Revoking (tombstoning) the successor clears the reverse pointer — the history stays honest.
  episodeOps.decisionRemoveIds(d, [d2])
  const after = episodeOps.queryDecisionsByTask(d, 't1')
  assert.equal(after.length, 1)
  assert.equal(after[0].supersededBy, null, 'a tombstoned successor no longer counts as superseding')
})
