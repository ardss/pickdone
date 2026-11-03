/* S1 vertical slice (P0) — domain service db-episode-ops.cjs + the 6 command-manifest rows.
 * User-visible behavior asserted through the command bus (the single write door):
 *   (a) an unregistered command throws USAGE — the red case; after the slice, episode.put
 *       is a registered command that lands a row with the BUS-stamped updatedAt;
 *   (b) a second put with the same id overwrites the row;
 *   (c) episode.removeIds tombstones (deleted=1) — the row reads back gone, and a repeat
 *       remove is a no-op (id not reported as changed again);
 *   (d) source.put on a duplicate (providerId, externalId) fails with an EXPLICIT error;
 *   (e) taskSource.put/remove round-trip.
 * Run: node --test tests/unit/main/episode-ops.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const buildMigrations = require_('../../../src/main/db-migrations.js')
const episodeOps = require_('../../../src/main/db-episode-ops.cjs')
const { createBus, USAGE } = require_('../../../src/main/command-bus.js')
const Database = require_('../../../vendor/better-sqlite3-multiple-ciphers')

const v11 = buildMigrations(null, null).find(m => m.v === 11)

/** A real SQLite db with the three v11 tables, behind the real command bus — the dbCall
 * seam routes manifest ops to the domain service exactly like db.js's OPS delegates. */
function wired () {
  const d = new Database(':memory:')
  v11.fn(d)
  const routes = {
    episodePut: p => episodeOps.episodePut(d, p),
    episodeRemoveIds: p => episodeOps.episodeRemoveIds(d, p),
    sourcePut: p => episodeOps.sourcePut(d, p),
    sourceRemoveByIds: p => episodeOps.sourceRemoveByIds(d, p),
    taskSourcePut: p => episodeOps.taskSourcePut(d, p),
    taskSourceRemove: p => episodeOps.taskSourceRemove(d, p)
  }
  const bus = createBus((op, params) => {
    const fn = routes[op]
    if (!fn) throw new Error('[wired-fixture] unknown op: ' + op)
    return fn(params)
  })
  return { d, bus, USAGE }
}

test('episode.put lands a row and the BUS stamps updatedAt; unknown commands still throw USAGE', () => {
  const { d, bus } = wired()
  // the door stays closed for unregistered commands (the red case pre-slice for episode.put)
  assert.throws(() => bus.commit('episode', 'nonexistentVerb', {}), e => e.code === USAGE)
  const before = Date.now()
  const id = bus.commit('episode', 'put', { id: 'ep1', taskId: 't1', startedAt: before, endedAt: 0 })
  assert.equal(id, 'ep1')
  const row = d.prepare('SELECT * FROM work_episodes WHERE id = ?').get('ep1')
  assert.ok(row, 'episode.put lands a row')
  assert.equal(row.taskId, 't1')
  assert.ok(row.updatedAt >= before, 'bus stamped updatedAt (caller sent none)')
  // second put with the same id overwrites
  bus.commit('episode', 'put', { id: 'ep1', taskId: 't1', startedAt: before, endedAt: before + 5 })
  const row2 = d.prepare('SELECT * FROM work_episodes WHERE id = ?').get('ep1')
  assert.equal(row2.endedAt, before + 5, 'second put with the same id overwrites the row')
  assert.equal(d.prepare('SELECT COUNT(*) n FROM work_episodes').get().n, 1, 'no duplicate row minted')
  d.close()
})

test('episode.removeIds tombstones (deleted=1) and a repeat remove is a no-op', () => {
  const { d, bus } = wired()
  bus.commit('episode', 'put', { id: 'ep2', taskId: 't1', startedAt: 1, endedAt: 2 })
  const changed = bus.commit('episode', 'removeIds', ['ep2'])
  assert.deepEqual(changed, ['ep2'])
  const row = d.prepare('SELECT * FROM work_episodes WHERE id = ?').get('ep2')
  assert.equal(row.deleted, 1, 'removed episode reads back deleted=1')
  const again = bus.commit('episode', 'removeIds', ['ep2', 'ghost'])
  assert.deepEqual(again, [], 'repeat/ghost removes change nothing and report no ids')
  d.close()
})

test('source.put: duplicate (providerId, externalId) fails with an explicit error', () => {
  const { d, bus } = wired()
  bus.commit('source', 'put', { id: 's1', providerId: 'github', externalId: '42', title: 'x' })
  assert.throws(() => bus.commit('source', 'put', { id: 's2', providerId: 'github', externalId: '42', title: 'y' }),
    e => /github/.test(e.message) && /42/.test(e.message), 'the duplicate-pair error names the colliding pair (explicit, not a bare SQLITE message)')
  assert.equal(d.prepare('SELECT COUNT(*) n FROM source_refs').get().n, 1)
  const changed = bus.commit('source', 'removeByIds', ['s1'])
  assert.deepEqual(changed, ['s1'])
  assert.equal(d.prepare('SELECT deleted FROM source_refs WHERE id = ?').get('s1').deleted, 1)
  d.close()
})

test('tasksource.put/remove round-trip through the bus', () => {
  const { d, bus } = wired()
  const id = bus.commit('tasksource', 'put', { taskId: 't9', sourceRefId: 's9' })
  assert.ok(id, 'taskSource.put returns the link id')
  const row = d.prepare('SELECT * FROM task_source_links WHERE taskId = ?').get('t9')
  assert.ok(row && row.sourceRefId === 's9')
  assert.ok(row.updatedAt > 0, 'bus stamped the link age')
  const changed = bus.commit('tasksource', 'remove', [row.id])
  assert.deepEqual(changed, [row.id])
  assert.equal(d.prepare('SELECT deleted FROM task_source_links WHERE id = ?').get(row.id).deleted, 1)
  d.close()
})

// [pd20 S3 follow-up fix] The EditPanel 'continue work' section reads a task's episodes via
// dbCall('queryEpisodesByTask', taskId) — the renderer's user-visible contract (editpanel-work
// pins): rows shaped {episodeId, summary, resources}, ordered oldest-first, tombstoned episodes
// and tombstoned links/refs invisible. Before this fix the op did not exist on the db layer at
// all (the whitelist gate flagged it: the feature was silently dead in the real app).
test('queryEpisodesByTask: renderer-shaped read (summary/resources), oldest first, tombstones invisible', () => {
  const { d, bus } = wired()
  bus.commit('episode', 'put', { id: 'ep1', taskId: 't1', startedAt: 200, endedAt: 300, note: '晚上补了回归' })
  bus.commit('episode', 'put', { id: 'ep2', taskId: 't1', startedAt: 100, endedAt: 150, note: '白天写了渲染层' })
  const ghost = bus.commit('episode', 'put', { id: 'ep3', taskId: 't1', startedAt: 50, note: '稍后删除' })
  bus.commit('episode', 'removeIds', [ghost])
  const srcId = bus.commit('source', 'put', { providerId: 'github', externalId: '42', title: 'spec.md' })
  bus.commit('source', 'put', { providerId: 'web', externalId: 'p1', title: 'notes.md' })
  bus.commit('tasksource', 'put', { taskId: 't1', sourceRefId: srcId })
  bus.commit('episode', 'put', { id: 'epX', taskId: 't2', note: '别的任务' })

  assert.equal(typeof episodeOps.queryEpisodesByTask, 'function', 'the read op exists on the domain service')
  const rows = episodeOps.queryEpisodesByTask(d, 't1')
  assert.deepEqual(rows.map(r => r.episodeId), ['ep2', 'ep1'], 'oldest startedAt first, tombstoned episode invisible')
  assert.equal(rows[0].summary, '白天写了渲染层', 'note is exposed as the renderer summary field')
  assert.deepEqual(rows[0].resources, ['spec.md'], 'the task-linked (live) source titles ride the episode rows — the schema links refs to the TASK, so the task-level resource set is what each row carries')
  assert.deepEqual(rows[1].resources, ['spec.md'], 'same task-level resource set on every episode of the task')
  assert.deepEqual(episodeOps.queryEpisodesByTask(d, 't2').map(r => r.episodeId), ['epX'], 'other tasks unaffected')
  assert.deepEqual(episodeOps.queryEpisodesByTask(d, 'missing'), [], 'unknown task reads back empty')
  assert.deepEqual(episodeOps.queryEpisodesByTask(d, ''), [], 'empty taskId reads back empty')
  d.close()
})
