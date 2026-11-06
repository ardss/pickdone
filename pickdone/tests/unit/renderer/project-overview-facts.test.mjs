import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { projectOverviewFacts } from '../../../renderer/js/utils/projectOverviewFacts.mjs'

const require_ = createRequire(import.meta.url)
const Database = require_('../../../vendor/better-sqlite3-multiple-ciphers')
const { SCHEMA } = require_('../../../src/main/db-schema.js')
const migrations = require_('../../../src/main/db-migrations.js')
const episodeOps = require_('../../../src/main/db-episode-ops.cjs')

test('overview facts use persisted project tasks and work episodes', () => {
  const db = new Database(':memory:')
  try {
    db.exec(SCHEMA)
    migrations(null, null).find(m => m.v === 11).fn(db)
    const put = db.prepare('INSERT INTO todos (id, content, categoryId, deleted, complete, scheduledDay, createdAt) VALUES (?, ?, ?, 0, 0, ?, 1)')
    put.run('late', 'Fix overdue issue', 7, 1000)
    put.run('next', 'Review release notes', 7, 3000)
    put.run('other', 'Other project', 8, 1000)
    episodeOps.episodePut(db, { id: 'ep1', taskId: 'late', startedAt: 1800, note: 'goal: Investigated failure\noutcome: Root cause found\nnextAction: Apply fix' })
    episodeOps.episodePut(db, { id: 'ep2', taskId: 'other', startedAt: 1900, note: 'goal: Unrelated' })
    const tasks = db.prepare('SELECT id AS taskId, content, scheduledDay AS dayStart, complete, deleted FROM todos WHERE categoryId = ?').all(7)
    const episodes = episodeOps.queryEpisodesByCategory(db, 7)
    const facts = projectOverviewFacts(tasks, [{ id: 'ms', title: 'Release', date: 1000, taskIds: ['late'] }], episodes, 2000)
    assert.equal(facts.overdueTasks, 1)
    assert.equal(facts.overdueMilestones, 1)
    assert.equal(facts.nextMilestone.title, 'Release')
    assert.equal(facts.recentWork, 'Root cause found')
    assert.equal(facts.nextAction, 'Apply fix')
    assert.equal(facts.nextActionFromEpisode, true)
    assert.equal(episodes.recent.length, 1, 'other project work must not leak')
  } finally { db.close() }
})

test('missing work records do not create activity or an AI completion claim', () => {
  const facts = projectOverviewFacts([], [], null, 2000)
  assert.equal(facts.recentWork, '')
  assert.equal(facts.nextAction, '')
  assert.equal(facts.nextMilestone, null)
  assert.equal(facts.overdueTasks, 0)
})
