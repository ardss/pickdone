import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Database = require('../../../vendor/better-sqlite3-multiple-ciphers')
const { SCHEMA } = require('../../../src/main/db-schema.js')
const migrations = require('../../../src/main/db-migrations.js')
const ops = require('../../../src/main/db-episode-ops.cjs')

test('project timeline returns 305 real episodes without a hidden 300-record cap', () => {
  const db = new Database(':memory:')
  try {
    db.exec(SCHEMA)
    migrations(null, null).find(m => m.v === 11).fn(db)
    db.prepare('INSERT INTO todos (id, content, categoryId, deleted, complete, createdAt) VALUES (?, ?, ?, 0, 0, 1)')
      .run('history-task', 'Real history', 22)
    for (let i = 1; i <= 305; i++) {
      ops.episodePut(db, { id: 'episode-' + i, taskId: 'history-task', startedAt: i * 1000, note: 'goal: work ' + i })
    }
    const result = ops.queryEpisodesByCategory(db, 22)
    assert.equal(result.timeline.length, 305)
    assert.equal(result.recent.length, 8)
    assert.equal(result.timeline[0].episodeId, 'episode-305')
    assert.equal(result.timeline.at(-1).episodeId, 'episode-1')
    assert.equal(result.tasks[0].taskContent, 'Real history')
  } finally {
    db.close()
  }
})
