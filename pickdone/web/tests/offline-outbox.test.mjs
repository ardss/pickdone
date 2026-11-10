import test from 'node:test'
import assert from 'node:assert/strict'

// RED-FIRST (S5 continuity): offline queue -> reconnect replay convergence.
// These describe the outbox contract BEFORE implementation:
//   - local mutations are enqueued durably while offline
//   - queued ops coalesce per (store,rowId): the LATEST op wins, order by time
//   - replay drains ONLY after a full push+pull cycle succeeded (real convergence,
//     not "we tried"); failures keep the queue and report pending count
import { enqueueMutation, coalesced, outboxSummary, QUEUE_STORES } from '../src/sync/outbox.js'

test('QUEUE_STORES covers every local collection', () => {
  assert.deepEqual([...QUEUE_STORES].sort(), ['episodes', 'projects', 'tasks'])
})

test('enqueue appends a durable mutation entry', () => {
  let queue = []
  queue = enqueueMutation(queue, { store: 'tasks', rowId: 't1', kind: 'upsert', ts: 100 })
  assert.equal(queue.length, 1)
  assert.equal(queue[0].store, 'tasks')
  assert.equal(queue[0].rowId, 't1')
  assert.equal(queue[0].kind, 'upsert')
})

test('enqueue rejects unknown stores and empty rowIds', () => {
  assert.throws(() => enqueueMutation([], { store: 'notes', rowId: 'x' }))
  assert.throws(() => enqueueMutation([], { store: 'tasks', rowId: '' }))
})

test('coalesced keeps only the latest op per store+rowId, in chronological order', () => {
  const queue = [
    { id: 'a', store: 'tasks', rowId: 't1', kind: 'upsert', ts: 100 },
    { id: 'b', store: 'tasks', rowId: 't2', kind: 'upsert', ts: 110 },
    { id: 'c', store: 'tasks', rowId: 't1', kind: 'upsert', ts: 120 },
    { id: 'd', store: 'tasks', rowId: 't2', kind: 'delete', ts: 130 }
  ]
  const plan = coalesced(queue)
  assert.deepEqual(plan.map(op => op.id), ['c', 'd'], 'oldest surviving first; t1 collapsed to latest, t2 delete overrides upsert')
})

test('outboxSummary counts pending rows per store for the UI badge', () => {
  const queue = [
    { id: 'a', store: 'tasks', rowId: 't1', kind: 'upsert', ts: 100 },
    { id: 'c', store: 'tasks', rowId: 't1', kind: 'upsert', ts: 120 },
    { id: 'd', store: 'tasks', rowId: 't2', kind: 'delete', ts: 130 },
    { id: 'e', store: 'projects', rowId: 'p1', kind: 'upsert', ts: 140 }
  ]
  const summary = outboxSummary(queue)
  assert.equal(summary.total, 3, 'coalesced pending count, not raw queue length')
  assert.equal(summary.byStore.tasks, 2)
  assert.equal(summary.byStore.projects, 1)
})

// ---- durable queue against IndexedDB (storage.js, DB v2) ----
import { openDatabase, readOutbox, saveOutbox, clearOutbox, writeLocal, readAll } from '../src/storage.js'
import 'fake-indexeddb/auto'

test('writeLocal persists the row AND the outbox entry in one transaction', async () => {
  await openDatabase()
  const row = { id: 'task-off-1', content: 'offline task', updatedAt: 1, deleted: 0 }
  const queue = await writeLocal('tasks', row)
  const data = await readAll()
  assert.equal(data.tasks.find(r => r.id === 'task-off-1').content, 'offline task')
  assert.equal(queue.filter(op => op.rowId === 'task-off-1').length, 1)
  const persisted = await readOutbox()
  assert.ok(persisted.some(op => op.rowId === 'task-off-1'), 'queue survives reload')
})

test('readOutbox/clearOutbox round-trip', async () => {
  await openDatabase()
  await clearOutbox()
  assert.deepEqual(await readOutbox(), [])
  const queue = await saveOutbox([{ id: 'x', store: 'tasks', rowId: 't9', kind: 'upsert', ts: 1 }])
  assert.equal(queue.length, 1)
  assert.equal((await readOutbox()).length, 1)
  await clearOutbox()
  assert.deepEqual(await readOutbox(), [])
})
