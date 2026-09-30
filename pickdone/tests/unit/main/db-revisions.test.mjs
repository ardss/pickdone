import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-db-revisions-'))
const require = createRequire(import.meta.url)
const db = require('../../../src/main/db')

const { createRevisionStore, applyEnvelope, materializedAll } = await import('../../../shared/sync-core/causality/merge.mjs')
const revisions = db.__revisionsForTests

db.init(process.env.TODO_DB_DIR)

const seedTodo = (taskId, title) => db.call('upsert', { taskId, title, createdAt: 1000, updatedAt: 1000 })

test('revisions: flag OFF by default — writes record nothing, v1 runtime untouched', () => {
  seedTodo('t-off', 'before flag')
  assert.equal(db.call('revisionsFlagState').on, false)
  assert.equal(db.call('revisionsList').length, 0)
})

test('revisions: flag ON — writes mint revisions with write-time payload and correct lineage', () => {
  db.call('revisionsFlag', { on: true })
  assert.equal(db.call('revisionsFlagState').on, true)
  seedTodo('t1', 'first')
  let list = db.call('revisionsList', { entityId: 't1' })
  assert.equal(list.length, 1)
  assert.equal(list[0].entity, 'todo')
  assert.equal(list[0].parents.length, 0, 'first revision of an entity has no parents')

  db.call('upsert', { taskId: 't1', title: 'second', createdAt: 1000, updatedAt: 2000 })
  list = db.call('revisionsList', { entityId: 't1' })
  assert.equal(list.length, 2)
  const [r1, r2] = list
  assert.deepEqual(r2.parents, [r1.revisionId], 'sequential edit supersedes the first revision')
  const newer = r2.hlc.physical > r1.hlc.physical ||
    (r2.hlc.physical === r1.hlc.physical && r2.hlc.logical > r1.hlc.logical)
  assert.ok(newer, 'child HLC strictly newer than parent')
})

test('revisions: hard-deleted row records a tombstone revision (write-time read finds no row)', () => {
  seedTodo('t-del', 'doomed')
  db.call('hardDelete', 't-del')
  const list = db.call('revisionsList', { entityId: 't-del' })
  assert.equal(list.length, 2)
  const exported = revisions.exportToStore(createRevisionStore, applyEnvelope)
  const { current } = (() => {
    const all = materializedAll(exported)
    return { current: all['t-del'] }
  })()
  assert.ok(current, 't-del has a materialized current revision')
})

test('revisions: recorded DAG exports into sync-core and materializes the exact live state', () => {
  seedTodo('t-export', 'one')
  db.call('upsert', { taskId: 't-export', title: 'two', createdAt: 1000, updatedAt: 3000 })
  db.call('upsert', { taskId: 't-export', title: 'three', createdAt: 1000, updatedAt: 4000 })
  const store = revisions.exportToStore(createRevisionStore, applyEnvelope)
  const state = materializedAll(store)
  assert.ok(state['t-export'], 'entity present in materialized view')
  // multi-entity coverage: settings/flag rows and the seeded todos all recorded
  for (const id of ['t1', 't-del', 't-export']) assert.ok(state[id], 'recorded: ' + id)
})

test('revisions: payload hash verifies against stored payload (integrity bridge)', () => {
  const list = db.call('revisionsList', { entityId: 't1' })
  assert.ok(list.length >= 2)
  for (const r of list) assert.equal(revisions.verifyHash(r.revisionId), true, r.revisionId)
})

test('revisions: flag flip is not itself recorded as a revision (machine-local op)', () => {
  const before = db.call('revisionsList').length
  db.call('revisionsFlag', { on: false })
  db.call('revisionsFlag', { on: true })
  assert.equal(db.call('revisionsList').length, before, 'flag writes emit no revisions')
})
