/* W3 2026-09-12: db.commitSyncBatch — the atomic sync-commit op.
 * Contract under test:
 *  1. Success: every row lands with status='sync' AND the todosVersion cursor advances in one op.
 *  2. Atomicity: a mid-batch failure (invalid bind value throws inside the transaction) must roll back
 *     BOTH the row upserts and the setMeta — the crash-safety argument in todo.js syncTodos depends on
 *     "no intermediate state": either the whole batch is re-sent (dirty rows) or fully acknowledged
 *     (sync rows + advanced cursor). A committed-partial outcome would permanently break convergence.
 * Isolated temp DB, no real data touched.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')

db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'w3-commit-batch-')))

const todo = (taskId, over = {}) => Object.assign({
  taskId, taskContent: 'c-' + taskId, delete: false, complete: false,
  updateTime: 1, createTime: 1, status: 'add', version: 0
}, over)

test('commitSyncBatch: rows land with status=sync and todosVersion advances in one op', () => {
  assert.equal(db.call('commitSyncBatch', {
    rows: [todo('w3_a'), todo('w3_b', { status: 'update' }), todo('w3_c', { status: 'delete' })],
    version: 42
  }), true)
  for (const id of ['w3_a', 'w3_b', 'w3_c']) {
    const r = db.call('getById', id)
    assert.ok(r, id + ' persisted')
    assert.equal(r.status, 'sync', id + ' forced to sync at the db layer (renderer cannot write arbitrary status)')
    assert.equal(r.version, 42)
  }
  assert.equal(db.call('getMeta', 'todosVersion'), '42')
})

test('commitSyncBatch: mid-batch failure rolls back rows AND the version cursor (atomicity)', () => {
  // Baseline: cursor at 42 from the previous test; introduce a bad row that makes better-sqlite3 throw
  // mid-transaction (an object cannot be bound to a column). w3_d upserts fine, then the bind throws —
  // without a transaction w3_d would be committed and the cursor would already read 43.
  const rows = [todo('w3_d'), todo('w3_bad', { taskSort: { not: 'bindable' } })]
  assert.throws(() => db.call('commitSyncBatch', { rows, version: 43 }))
  assert.equal(db.call('getById', 'w3_d'), null, 'earlier row in the same batch must be rolled back')
  assert.equal(db.call('getById', 'w3_bad'), null, 'the offending row must not exist')
  assert.equal(db.call('getMeta', 'todosVersion'), '42', 'cursor must NOT advance when the batch fails (crash-safety core)')
})

test('commitSyncBatch: empty batch still advances the cursor', () => {
  assert.equal(db.call('commitSyncBatch', { rows: [], version: 44 }), true)
  assert.equal(db.call('getMeta', 'todosVersion'), '44')
})
