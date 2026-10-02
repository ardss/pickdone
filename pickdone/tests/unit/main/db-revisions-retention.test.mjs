import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// leak-sync-revisions-no-gc regression: sync_revision_payloads grew without bound while the
// sync.revisions.v2 flag was on — one full-row JSON per edit, superseded payloads never removed.
// Retention must prune non-current payloads outside the recent-keep window while keeping the
// current revision's payload (live materialization) and ancestry rows (exportToStore contract).
process.env.TODO_REVISION_PAYLOAD_KEEP = '20' // small keep for test speed (env override, min 10 → hysteresis threshold 25)
process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-db-rev-retention-'))
const require = createRequire(import.meta.url)
const db = require('../../../src/main/db')

const { createRevisionStore, applyEnvelope, materializedAll } = await import('../../../shared/sync-core/causality/merge.mjs')
const revisions = db.__revisionsForTests

db.init(process.env.TODO_DB_DIR)

test('retention: superseded payloads are pruned, current payload + ancestry survive', async t => {
  assert.equal(db.call('revisionsFlagState').on, false)
  db.call('revisionsFlag', { on: true })

  const FINAL_TITLE = 'final surviving edit'
  for (let i = 0; i < 40; i++) {
    db.call('upsert', { taskId: 'churn', title: 'edit #' + i, createdAt: 1, updatedAt: 1000 + i })
  }
  db.call('upsert', { taskId: 'churn', title: FINAL_TITLE, createdAt: 1, updatedAt: 9999 })

  // perf-sync-revisions-prune-inline-write-stall: the prune is deferred via setImmediate (out of
  // the write hot path), so yield one macrotask turn before asserting the post-prune bounds.
  await new Promise(resolve => setImmediate(resolve))

  const keep = revisions.payloadKeep()
  assert.equal(keep, 20)
  const n = db.__payloadCountForTests()
  assert.ok(n <= keep + Math.floor(keep / 4) + 1, 'payload count bounded after GC, got ' + n)
  assert.ok(n < 41, 'unbounded leak would hold all 41 payloads, got ' + n)

  // ancestry rows survive as pruned-payload lines; current payload is intact
  const list = db.call('revisionsList', { entityId: 'churn' })
  assert.equal(list.length, 41, 'sync_revisions ancestry rows are NOT pruned')
  assert.equal(revisions.verifyHash(
    db.__currentRevisionIdForTests('churn')), true, 'current revision payload survives retention')

  // exportToStore still materializes through the pruned DAG: the current revision resolves to
  // its payload hash (materializedAll maps entityId → current payloadHash)
  const store = revisions.exportToStore(createRevisionStore, applyEnvelope)
  const state = materializedAll(store)
  assert.equal(typeof state.churn, 'string', 'churn materializes to a payload hash')
  assert.ok(state.churn.length > 0, 'current revision hash survives payload pruning')
})
