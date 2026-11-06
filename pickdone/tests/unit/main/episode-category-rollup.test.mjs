/* pd20 P1-01 (project overview work-handoff) — queryEpisodesByCategory rollup op.
 * User-visible behavior asserted through the SAME doctrine as episode-ops.test.mjs
 * (real better-sqlite3, real v11 migration + static todos schema, ops called directly):
 *   (a) rollup correctness across multiple tasks: per-task episodeCount, lastEpisodeAt,
 *       lastGoal/lastOutcome/lastNextAction parsed from the serialized note
 *       (goal:/outcome:/nextAction: round-trip — plain notes fall back to whole-note-as-goal);
 *   (b) tasks WITHOUT episodes are INCLUDED with episodeCount 0 / 0 timestamps / '' fields —
 *       the 'tasks with episodes only' filter is the renderer's toggle, never the op's;
 *   (c) tombstoned episodes and tombstoned task/source links are invisible (counts and the
 *       project-level recent list never see them);
 *   (d) the project-recent list is the last 8 live episodes across the category, startedAt desc;
 *   (e) the pd20-P1 timeline array carries EVERY live episode (capped only as a wire-shape
 *       bound at 300), the same rows the recent list is sliced from.
 * Run: node --test tests/unit/main/episode-category-rollup.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const buildMigrations = require_('../../../src/main/db-migrations.js')
const episodeOps = require_('../../../src/main/db-episode-ops.cjs')
const { SCHEMA } = require_('../../../src/main/db-schema.js')
const Database = require_('../../../vendor/better-sqlite3-multiple-ciphers')

const v11 = buildMigrations(null, null).find(m => m.v === 11)

/** Real SQLite db with the static todos schema + the three v11 tables. Episodes/links land
 *  through the same domain ops the bus routes to (episodePut/taskSourcePut/...). */
function wired () {
  const d = new Database(':memory:')
  d.exec(SCHEMA)
  v11.fn(d)
  return d
}

const putTodo = (d, id, categoryId, content) => d.prepare(
  'INSERT INTO todos (id, content, categoryId, deleted, complete, createdAt) VALUES (?, ?, ?, 0, 0, 1)'
).run(id, content, categoryId)

test('rollup correctness across multiple tasks: counts, latest-note fields, newest-first ordering', () => {
  const d = wired()
  putTodo(d, 'tA', 7, 'Task A')
  putTodo(d, 'tB', 7, 'Task B')
  putTodo(d, 'tOther', 8, 'Other project task')
  // tA: two episodes, the newer one carries the serialized fields (order matters)
  episodeOps.episodePut(d, { id: 'a1', taskId: 'tA', startedAt: 100, note: 'goal: set up renderer\noutcome: builds green\nnextAction: run gates' })
  episodeOps.episodePut(d, { id: 'a2', taskId: 'tA', startedAt: 300, note: 'goal: fix rollup\noutcome: tests pass\nnextAction: ship P1-01' })
  // tB: one PLAIN note (no field lines) → the whole note IS the goal (EditPanelWork doctrine)
  episodeOps.episodePut(d, { id: 'b1', taskId: 'tB', startedAt: 200, note: '白天写了渲染层' })
  // another category's episode must not leak into tOther's rollup of category 7
  episodeOps.episodePut(d, { id: 'x1', taskId: 'tOther', startedAt: 50, note: 'unrelated' })

  const res = episodeOps.queryEpisodesByCategory(d, 7)
  assert.ok(Array.isArray(res.tasks) && Array.isArray(res.recent), 'returns the { tasks, recent } envelope')
  const byId = Object.fromEntries(res.tasks.map(r => [r.taskId, r]))
  assert.deepEqual(res.tasks.map(r => r.taskId), ['tA', 'tB'], 'newest lastEpisodeAt first; other category excluded')
  assert.equal(byId.tA.episodeCount, 2)
  assert.equal(byId.tA.lastEpisodeAt, 300)
  assert.equal(byId.tA.lastGoal, 'fix rollup')
  assert.equal(byId.tA.lastOutcome, 'tests pass')
  assert.equal(byId.tA.lastNextAction, 'ship P1-01', 'fields come from the LATEST episode, not the first')
  assert.equal(byId.tB.episodeCount, 1)
  assert.equal(byId.tB.lastNextAction, '', 'plain note has no nextAction line → empty, never fabricated')
  assert.equal(byId.tB.lastGoal, '白天写了渲染层', 'plain note round-trips as the goal')
  assert.deepEqual(res.recent.map(e => e.episodeId), ['a2', 'b1', 'a1'], 'project-recent is live episodes startedAt desc')
  assert.equal(res.recent[0].goal, 'fix rollup')
  assert.deepEqual(res.timeline.map(e => e.episodeId), ['a2', 'b1', 'a1'], 'timeline carries ALL live episodes (same order), not capped at 8')
  d.close()
})

test('tasks without episodes are INCLUDED (episodeCount 0) — filtering is the renderer toggle', () => {
  const d = wired()
  putTodo(d, 'tWork', 3, 'Has episodes')
  putTodo(d, 'tIdle', 3, 'No episodes')
  episodeOps.episodePut(d, { id: 'w1', taskId: 'tWork', startedAt: 10, note: 'goal: g\nnextAction: n' })
  const res = episodeOps.queryEpisodesByCategory(d, 3)
  assert.equal(res.tasks.length, 2, 'the op returns ALL live todos of the category')
  const idle = res.tasks.find(r => r.taskId === 'tIdle')
  assert.deepEqual(
    { taskId: idle.taskId, taskContent: idle.taskContent, episodeCount: idle.episodeCount, lastEpisodeAt: idle.lastEpisodeAt, lastGoal: idle.lastGoal, lastOutcome: idle.lastOutcome, lastNextAction: idle.lastNextAction },
    { taskId: 'tIdle', taskContent: 'No episodes', episodeCount: 0, lastEpisodeAt: 0, lastGoal: '', lastOutcome: '', lastNextAction: '' },
    'episode-less task shape: 0 count, 0 timestamp, empty fields (renderer shows the no-record placeholder)'
  )
  assert.equal(res.recent.length, 1, 'recent carries only real episodes')
  // deleted todos are invisible entirely
  d.prepare('UPDATE todos SET deleted = 1 WHERE id = ?').run('tIdle')
  assert.deepEqual(episodeOps.queryEpisodesByCategory(d, 3).tasks.map(r => r.taskId), ['tWork'], 'tombstoned todos excluded')
  assert.deepEqual(episodeOps.queryEpisodesByCategory(d, 999), { tasks: [], recent: [], timeline: [] }, 'unknown category reads back the empty envelope')
  d.close()
})

test('tombstoned episodes and links are invisible to counts, latest fields and recent', () => {
  const d = wired()
  putTodo(d, 't1', 5, 'Task 1')
  episodeOps.episodePut(d, { id: 'keep', taskId: 't1', startedAt: 400, note: 'goal: keep goal\nnextAction: keep next' })
  episodeOps.episodePut(d, { id: 'gone', taskId: 't1', startedAt: 900, note: 'goal: deleted goal\nnextAction: deleted next' })
  episodeOps.episodeRemoveIds(d, ['gone'])
  const res = episodeOps.queryEpisodesByCategory(d, 5)
  const row = res.tasks[0]
  assert.equal(row.episodeCount, 1, 'tombstoned episode not counted')
  assert.equal(row.lastEpisodeAt, 400, 'lastEpisodeAt ignores the tombstoned newer episode')
  assert.equal(row.lastNextAction, 'keep next', 'latest fields come from live episodes only')
  assert.deepEqual(res.recent.map(e => e.episodeId), ['keep'], 'recent never lists a tombstoned episode')
  // a tombstoned source link must not resurrect anything either (link/refs ride their own tables)
  const srcId = episodeOps.sourcePut(d, { providerId: 'github', externalId: '1', title: 'spec.md' })
  const linkId = episodeOps.taskSourcePut(d, { taskId: 't1', sourceRefId: srcId })
  episodeOps.taskSourceRemove(d, [linkId])
  const res2 = episodeOps.queryEpisodesByCategory(d, 5)
  assert.equal(res2.tasks[0].episodeCount, 1, 'link tombstones do not affect the episode rollup')
  assert.deepEqual(res2.recent.map(e => e.episodeId), ['keep'])
  d.close()
})

test('recent caps at 8 live episodes across tasks, startedAt desc; guard rails for bad input', () => {
  const d = wired()
  putTodo(d, 't1', 9, 'T1')
  putTodo(d, 't2', 9, 'T2')
  for (let i = 1; i <= 10; i++) episodeOps.episodePut(d, { id: 'e' + i, taskId: i % 2 ? 't1' : 't2', startedAt: i * 10, note: 'goal: g' + i })
  const res = episodeOps.queryEpisodesByCategory(d, 9)
  assert.equal(res.recent.length, 8, 'recent is capped at 8')
  assert.deepEqual(res.recent.map(e => e.episodeId), ['e10', 'e9', 'e8', 'e7', 'e6', 'e5', 'e4', 'e3'], 'newest first across tasks')
  assert.equal(res.tasks.length, 2, 'task rows are not capped by the recent cap')
  assert.deepEqual(episodeOps.queryEpisodesByCategory(d, ''), { tasks: [], recent: [], timeline: [] }, 'empty categoryId reads back the empty envelope')
  d.close()
})
