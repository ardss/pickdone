/**
 * [w27 P2 2026-11-01] editSave.js multi-task debounce batch — partial failure must NOT replay
 * already-persisted entries.
 *
 * Live finding: in the debounce callback's multi-task branch each entry is dispatched inside its
 * own try/catch (failedEntries), but the dirty-field dispatch afterwards can still throw into the
 * OUTER catch, which did restore(drainedKeys)+requeue(entries) wholesale. Entries that had already
 * landed were re-queued and later replayed as a stale-value LWW write — silently overwriting newer
 * edits made in another window. Fix: track per-entry success; on failure only the unsuccessful
 * remainder is requeued, and the drained dirty keys are only re-flagged when the dirty dispatch
 * itself never landed.
 *
 * Run: node --test tests/unit/utils/w27-editsave-partial-batch-failure.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSaveQueue } from '../../../renderer/js/utils/editSave.js'

/** Store stub: fails dispatches for the given taskIds (every time), records every write. */
function makeStore (failTaskIds) {
  const writes = []
  const store = {
    async dispatch (type, payload) {
      if (type !== 'todo/updateTodoFields') return null
      writes.push(payload)
      if (failTaskIds.has(payload.taskId)) throw new Error('write failed: ' + payload.taskId)
      return payload
    }
  }
  return { writes, store }
}

/** Lazy dirty-field collector, mirroring EditPanel's dirtyPatchFor. */
const dirtyPatchFor = k => ({ [k]: 'dirty-' + k })
const flush = (ms = 450) => new Promise(r => setTimeout(r, ms))

test('w27 editSave: succeeded entries are never replayed after a batch failure (no stale LWW write)', async () => {
  let current = 'A'
  const { writes, store } = makeStore(new Set(['cur']))
  const q = createSaveQueue(store, { getTaskId: () => current, dirtyPatchFor, onFail: () => {} })
  q.boot()
  // One debounce batch, three enqueue-time tasks: A and B persist, then the dirty-field
  // dispatch for the CURRENT task ('cur') throws into the outer catch.
  current = 'A'
  q.queueSave({ title: 'A-title' })
  current = 'B'
  q.queueSave({ title: 'B-title' })
  current = 'cur'
  q.markDirty('desc')
  q.queueSave({}) // restarts the timer; all three entries share one callback batch
  await flush()
  assert.ok(writes.some(w => w.taskId === 'A' && w.patch.title === 'A-title'), 'A landed in batch 1')
  assert.ok(writes.some(w => w.taskId === 'B' && w.patch.title === 'B-title'), 'B landed in batch 1')

  // The requeued retry (any later queueSave flushes the pending slots): task A's slot must hold
  // ONLY fresh patches. Pre-fix the outer catch requeued ALL entries, so A's stale
  // { title: 'A-title' } was replayed and would LWW-overwrite another window's newer title.
  current = 'A'
  q.queueSave({ note: 'retry-trigger' })
  await flush()
  const aTitleWrites = writes.filter(w => w.taskId === 'A' && 'title' in w.patch)
  assert.equal(aTitleWrites.length, 1,
    'already-persisted A title must be written EXACTLY ONCE — a second write is the stale replay')
})

test('w27 editSave: drained dirty keys are restored only when the dirty dispatch itself failed', async () => {
  let current = 'cur'
  const { writes, store } = makeStore(new Set(['A']))
  const q = createSaveQueue(store, { getTaskId: () => current, dirtyPatchFor, onFail: () => {} })
  q.boot()
  current = 'cur'
  q.markDirty('desc')
  q.queueSave({ immediate: 1 })
  current = 'A' // switch: forces the multi-task branch; the dirty batch commits to 'A' and FAILS
  q.queueSave({})
  await flush()
  // The 'cur' entry succeeded; the dirty('desc') dispatch on 'A' threw -> 'desc' must be
  // re-flagged so a later queueSave retries it, while the succeeded entry is not requeued.
  assert.ok(writes.some(w => w.taskId === 'cur' && w.patch.immediate === 1), 'cur entry landed')
  current = 'cur'
  q.queueSave({}) // flush the restored dirty flag
  await flush()
  const descWrites = writes.filter(w => w.taskId === 'cur' && 'desc' in w.patch)
  assert.ok(descWrites.length >= 1, 'restored dirty key must be retried by a later queueSave')
})

test('w27 editSave: fully-successful batch performs no restore/requeue (failedEntries empty path intact)', async () => {
  let current = 'A'
  const { writes, store } = makeStore(new Set())
  let fails = 0
  const q = createSaveQueue(store, { getTaskId: () => current, dirtyPatchFor, onFail: () => { fails++ } })
  q.boot()
  current = 'A'
  q.queueSave({ title: 'A' })
  current = 'B'
  q.queueSave({ title: 'B' })
  await flush()
  assert.equal(fails, 0)
  assert.equal(writes.filter(w => w.taskId === 'A').length, 1)
  assert.equal(writes.filter(w => w.taskId === 'B').length, 1)
})
