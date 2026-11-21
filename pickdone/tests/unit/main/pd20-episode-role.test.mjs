/* pd20 (2026-11-08) — episode `role`: the A→B→QA attribution the handoff loop was missing.
 * User-visible behavior asserted through the same doors the app uses:
 *   (a) migration v13 adds the `role` column to an existing v11+v12 library (probe-style,
 *       additive — legacy dbs upgrade in place, old rows keep role NULL);
 *   (b) episode.put stores a KNOWN role family member (human/agent/qa); an out-of-family
 *       role stores NULL — never fabricate attribution (same doctrine as source_refs.level);
 *   (c) queryEpisodesByTask surfaces the real role; a legacy NULL row reads 'human'
 *       (the EditPanel/CLI handoff must not invent a distinction that was never recorded);
 *   (d) editing an episode (same-id put) can correct its role — a QA review that first
 *       landed as 'agent' can be re-attributed without losing the row.
 * Run: node --test tests/unit/main/pd20-episode-role.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const buildMigrations = require_('../../../src/main/db-migrations.js')
const episodeOps = require_('../../../src/main/db-episode-ops.cjs')

const migrations = buildMigrations(null, null)
const v11 = migrations.find(m => m.v === 11)
const v12 = migrations.find(m => m.v === 12)
const v13 = migrations.find(m => m.v === 13)

/** A legacy-shaped library (v11 tables + v12 verification columns, NO role column yet). */
function legacyDb () {
  const d = new (require_('../../../vendor/better-sqlite3-multiple-ciphers'))(':memory:')
  v11.fn(d)
  v12.fn(d)
  return d
}

const roleCols = d => d.prepare('PRAGMA table_info(work_episodes)').all().map(c => c.name)

test('migration v13 adds the role column to an existing v11+v12 library; legacy rows keep NULL', () => {
  assert.ok(v13, 'migration v13 exists in the chain')
  const d = legacyDb()
  assert.ok(!roleCols(d).includes('role'), 'precondition: legacy shape has no role column')
  d.prepare('INSERT INTO work_episodes (id, taskId, startedAt, endedAt, note, deleted, deletedAt, updatedAt) VALUES (?, ?, ?, ?, ?, 0, 0, ?)')
    .run('ep-legacy', 't1', 1000, 0, 'goal: legacy round', 1000)
  v13.fn(d)
  assert.ok(roleCols(d).includes('role'), 'v13 adds the role column in place')
  assert.equal(d.prepare('SELECT role FROM work_episodes WHERE id = ?').get('ep-legacy').role, null, 'legacy row keeps role NULL')
  // additive probe: re-running v13 on the upgraded shape must not throw (converged shape)
  assert.doesNotThrow(() => v13.fn(d), 'v13 is idempotent on the already-upgraded shape')
})

test('episode.put stores a known role; an out-of-family role stores NULL (never fabricate)', () => {
  const d = legacyDb()
  v13.fn(d)
  const idA = episodeOps.episodePut(d, { taskId: 't1', startedAt: 1, note: 'goal: research options', role: 'agent' })
  const idB = episodeOps.episodePut(d, { taskId: 't1', startedAt: 2, note: 'goal: QA re-check', role: 'qa' })
  const idH = episodeOps.episodePut(d, { taskId: 't1', startedAt: 3, note: 'goal: plain note' }) // no role = legacy/human caller
  assert.equal(d.prepare('SELECT role FROM work_episodes WHERE id = ?').get(idA).role, 'agent')
  assert.equal(d.prepare('SELECT role FROM work_episodes WHERE id = ?').get(idB).role, 'qa')
  assert.equal(d.prepare('SELECT role FROM work_episodes WHERE id = ?').get(idH).role, null, 'omitted role stays NULL (legacy caller)')
  const idX = episodeOps.episodePut(d, { taskId: 't1', startedAt: 4, note: 'x', role: 'robot' })
  assert.equal(d.prepare('SELECT role FROM work_episodes WHERE id = ?').get(idX).role, null, "out-of-family role ('robot') is not fabricated")
})

test('queryEpisodesByTask surfaces the real role; legacy NULL reads human', () => {
  const d = legacyDb()
  v13.fn(d)
  episodeOps.episodePut(d, { id: 'ep-a', taskId: 't1', startedAt: 1, note: 'goal: survey', role: 'agent' })
  episodeOps.episodePut(d, { id: 'ep-q', taskId: 't1', startedAt: 2, note: 'goal: verify', role: 'qa' })
  episodeOps.episodePut(d, { id: 'ep-l', taskId: 't1', startedAt: 3, note: 'goal: legacy' }) // pre-v13 row shape
  const rows = episodeOps.queryEpisodesByTask(d, 't1')
  const byId = Object.fromEntries(rows.map(r => [r.episodeId, r.role]))
  assert.equal(byId['ep-a'], 'agent')
  assert.equal(byId['ep-q'], 'qa')
  assert.equal(byId['ep-l'], 'human', 'NULL legacy role reads as human (display fallback, storage stays NULL)')
})

test('same-id put can correct a role without losing the row', () => {
  const d = legacyDb()
  v13.fn(d)
  const id = episodeOps.episodePut(d, { taskId: 't1', startedAt: 5, note: 'goal: review', role: 'agent' })
  episodeOps.episodePut(d, { id, taskId: 't1', startedAt: 5, note: 'goal: review', role: 'qa' })
  const row = d.prepare('SELECT role, note, deleted FROM work_episodes WHERE id = ?').get(id)
  assert.equal(row.role, 'qa', 'role is corrected in place')
  assert.equal(row.deleted, 0, 'the row survives the edit')
})
