import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createRelay, startRelayServer } from '../../../server/sync-relay.mjs'
import { createRelayClient } from '../../../shared/sync-transport/https/relay-client.mjs'
import { memoryStore } from '../../../server/sync-relay.mjs'

// Real app DB (not a mock): writes through db.call must land in sync_revisions
// and flow through the relay into a second device's store.
process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-v2-app-relay-'))
const require = createRequire(import.meta.url)
const db = require('../../../src/main/db')
db.init(process.env.TODO_DB_DIR)

test('integration: app writes → sync_revisions → relay → second device converges', async t => {
  const relay = createRelay(memoryStore())
  const server = await startRelayServer(relay, { port: 0 })
  t.after(() => new Promise(r => server.close(r)))
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  // flip the v2 flag on the real DB, then write like the app does
  assert.equal(db.call('revisionsFlagState').on, false)
  db.call('revisionsFlag', { on: true })
  db.call('upsert', { taskId: 'i1', title: 'from the real db', createdAt: 1, updatedAt: 100 })
  db.call('upsert', { taskId: 'i1', title: 'edited on device one', createdAt: 1, updatedAt: 200 })

  // load the recorded DAG into a sync-core store and attach it to the relay
  const revisions = db.__revisionsForTests
  const { createRevisionStore, applyEnvelope } = await import('../../../shared/sync-core/causality/merge.mjs')
  const localStore = revisions.exportToStore(createRevisionStore, applyEnvelope)
  const devA = createRelayClient({ nodeId: 'app-device', account: 'app-acc', baseUrl, store: localStore })
  await devA.register()
  const roundA = await devA.round()
  assert.ok(roundA.pushed >= 2, 'recorded revisions pushed to relay')

  // a second device joins, pulls everything, and matches the app's state exactly
  const devB = createRelayClient({ nodeId: 'peer-device', account: 'app-acc', baseUrl })
  await devB.register()
  await devB.round()
  const appTitles = {}
  for (const [entityId, hash] of Object.entries(devA.materialized())) appTitles[entityId] = hash
  assert.deepEqual(devB.materialized(), appTitles, 'peer converged with the real DB state')

  // bidirectional: peer writes, app-side store pulls the peer's revision
  await devB.commit('i2', { title: 'written by the peer' })
  await devB.round()
  await devA.round()
  assert.deepEqual(devA.materialized()['i2'], devB.materialized()['i2'], 'app store converged on peer write')

  // concurrent same-entity edits through the real pipeline: deterministic winner, loser preserved
  await devA.commit('i1', { title: 'concurrent from app' })
  await devB.commit('i1', { title: 'concurrent from peer' })
  await devA.round(); await devB.round(); await devA.round(); await devB.round()
  assert.deepEqual(devA.materialized(), devB.materialized(), 'concurrent edits converge deterministically')

  // flag off again: writes record nothing more (v1 runtime path intact)
  db.call('revisionsFlag', { on: false })
  const before = db.call('revisionsList').length
  db.call('upsert', { taskId: 'i3', title: 'after flag off', createdAt: 1, updatedAt: 300 })
  assert.equal(db.call('revisionsList').length, before, 'flag off stops recording')
})
