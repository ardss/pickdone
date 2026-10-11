import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// S2: the unified causal RECEIVE seam — sync-apply.causalInboundRelation(state, envelope).
// Read-only classification of an inbound envelope against the persisted local DAG through
// the read-only `revisionsStoreSnapshot` op. Contract under test:
//   - sub-flag OFF → { enabled: false, relation: 'unknown' } and the db is never consulted
//   - sub-flag ON  → 'equal' | 'descendant' | 'ancestor' | 'concurrent' | 'unknown'
//   - any internal failure degrades to { enabled: false, relation: 'unknown' } (v1 fallback)

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-sync-apply-dvv-'))
const require = createRequire(import.meta.url)
const db = require('../../../src/main/db')
const syncApply = require('../../../src/main/sync-apply')

// minimal state shape: the seam only consumes the db.call facade
const state = { db: { call: (op, p) => db.call(op, p) } }

db.init(process.env.TODO_DB_DIR)

test('seam: default OFF — disabled, never consults the DAG', () => {
  const r = syncApply.causalInboundRelation(state, { entityId: 'x', dvv: { dot: { deviceId: 'p', counter: 1 }, context: {} } })
  assert.deepEqual(r, { enabled: false, relation: 'unknown' })
})

test('seam: ON — classifies equal / descendant / ancestor / concurrent against the persisted DAG', () => {
  db.call('revisionsFlag', { on: true })
  db.call('revisionsFlagDvv', { on: true })
  db.call('upsert', { taskId: 's1', title: 'one', createdAt: 1, updatedAt: 100 })
  db.call('upsert', { taskId: 's1', title: 'two', createdAt: 1, updatedAt: 200 })

  const rows = db.call('revisionsList', { entityId: 's1' })
  assert.equal(rows.length, 2)
  const [first, current] = rows
  const dev = current.dvv.dot.deviceId

  // exact current revision → equal
  assert.equal(syncApply.causalInboundRelation(state, current).relation, 'equal')

  // synthetic causal child: dot beyond current, context covering it → descendant
  const child = {
    entityId: 's1',
    revisionId: 'synthetic-child',
    dvv: { dot: { deviceId: dev, counter: current.dvv.dot.counter + 1 }, context: { ...current.dvv.context, [dev]: current.dvv.dot.counter } },
  }
  assert.equal(syncApply.causalInboundRelation(state, child).relation, 'descendant')

  // the superseded first revision → ancestor (stale inbound row)
  assert.equal(syncApply.causalInboundRelation(state, first).relation, 'ancestor')

  // a genuinely concurrent branch from another device: no shared context → concurrent
  const concurrent = {
    entityId: 's1',
    revisionId: 'synthetic-concurrent',
    dvv: { dot: { deviceId: 'other-device', counter: 1 }, context: {} },
  }
  assert.equal(syncApply.causalInboundRelation(state, concurrent).relation, 'concurrent')

  // enabled flag surfaces on every ON result
  assert.equal(syncApply.causalInboundRelation(state, child).enabled, true)
})

test('seam: unknown entity and legacy (dvv-less) envelopes fall back to unknown', () => {
  assert.equal(syncApply.causalInboundRelation(state, { entityId: 'never-seen', dvv: { dot: { deviceId: 'p', counter: 1 }, context: {} } }).relation, 'unknown')
  assert.equal(syncApply.causalInboundRelation(state, { entityId: 's1' }).relation, 'unknown', 'dvv-less inbound row → unknown → v1 LWW fallback')
})

test('seam: broken db surface degrades to disabled/unknown instead of throwing', () => {
  const badState = { db: { call: () => { throw new Error('db closed') } } }
  const r = syncApply.causalInboundRelation(badState, { entityId: 's1', dvv: { dot: { deviceId: 'p', counter: 1 }, context: {} } })
  assert.equal(r.enabled, false)
  assert.equal(r.relation, 'unknown')
})
