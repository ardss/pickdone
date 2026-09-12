/**
 * W5 S4 split — EditPanel save pipeline (utils/editSave.js createSaveQueue).
 * Behavior ported verbatim from the original inline EditPanel implementation:
 * 350ms debounce, taskId snapshot at enqueue, dirty-flag drain/restore semantics.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSaveQueue } from '../../../renderer/js/utils/editSave.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

function makeStore () {
  const calls = []
  return {
    calls,
    failNext: false,
    async dispatch (type, payload) {
      calls.push({ type, payload })
      if (this.failNext) { this.failNext = false; throw new Error('db down') }
      return payload
    }
  }
}

function makeQueue (store, overrides = {}) {
  const flags = { failNext: false }
  const q = createSaveQueue(store, {
    getTaskId: () => overrides.taskId(),
    debounceMs: 0,
    dirtyPatchFor: k => ({
      subtasks: { subtasks: JSON.stringify(['a']) },
      imgs: { image: JSON.stringify(['pic.png']) },
      files: { files: JSON.stringify([]) },
      preds: { predecessors: '["t1"]' }
    }[k]),
    onSaving: v => flags.saving = v,
    onDone: () => { flags.failed = false },
    onFail: () => { flags.failed = true },
    ...overrides
  })
  q.boot()
  return { q, flags }
}

test('queueSave merges the immediate patch with dirty-flag fields at fire time and drains the flags', async () => {
  const store = makeStore()
  const { q } = makeQueue(store, { taskId: () => 'task-1' })
  q.markDirty('subtasks')
  q.queueSave({ todoTime: 123 })
  await sleep(10)
  assert.equal(store.calls.length, 1)
  assert.equal(store.calls[0].type, 'todo/updateTodoFields')
  assert.deepEqual(store.calls[0].payload, {
    taskId: 'task-1',
    patch: { todoTime: 123, subtasks: JSON.stringify(['a']) }
  })
  // flags drained: a follow-up flush has nothing to send
  q.flushSave()
  await sleep(5)
  assert.equal(store.calls.length, 1, 'no second dispatch after drain')
})

test('queueSave snapshots the taskId at enqueue time (task switch within the debounce window writes to the enqueue-time task)', async () => {
  const store = makeStore()
  let id = 'task-A'
  const { q } = makeQueue(store, { taskId: () => id })
  q.markDirty('imgs')
  q.queueSave({})
  id = 'task-B' // hydrate switches the task before the debounce fires
  await sleep(10)
  assert.equal(store.calls[0].payload.taskId, 'task-A', 'commits to the enqueue-time task')
})

test('queueSave dispatch failure surfaces onFail and does NOT restore the flags (original semantics)', async () => {
  const store = makeStore()
  const { q, flags } = makeQueue(store, { taskId: () => 'task-1' })
  store.failNext = true
  q.markDirty('files')
  q.queueSave({})
  await sleep(10)
  assert.equal(flags.failed, true)
  // flags were drained before dispatch and not restored -> a flush sends nothing
  q.flushSave()
  await sleep(5)
  assert.equal(store.calls.length, 1)
})

test('flushSave dispatches dirty fields only; failure restores the drained keys for a later retry', async () => {
  const store = makeStore()
  const { q, flags } = makeQueue(store, { taskId: () => 'task-1' })
  q.markDirty('subtasks')
  q.markDirty('preds')
  store.failNext = true
  q.flushSave()
  await sleep(5)
  assert.equal(flags.failed, true)
  assert.deepEqual(store.calls[0].payload.patch, { subtasks: JSON.stringify(['a']), predecessors: '["t1"]' })
  // retry path: flags restored -> the next queueSave persists them (merged with the new patch)
  q.queueSave({ todoTime: 9 })
  await sleep(10)
  assert.deepEqual(store.calls[1].payload.patch, {
    todoTime: 9,
    subtasks: JSON.stringify(['a']),
    predecessors: '["t1"]'
  })
  assert.equal(flags.failed, false, 'onDone clears the failure banner')
})

test('takeDirty(keysFilter) drains ALL flags but snapshots only the listed keys (restoreFromBin semantics)', () => {
  const store = makeStore()
  const { q } = makeQueue(store, { taskId: () => 'task-1' })
  q.markDirty('subtasks')
  q.markDirty('preds')
  const patch = q.takeDirty(['subtasks', 'imgs', 'files'])
  assert.deepEqual(patch, { subtasks: JSON.stringify(['a']) }, 'preds excluded but still drained')
  q.flushSave()
  return sleep(5).then(() => assert.equal(store.calls.length, 0, 'all flags were drained'))
})

test('flush before boot is a silent no-op (immediate watchers fire before created)', () => {
  const store = makeStore()
  const q = createSaveQueue(store, { getTaskId: () => 'task-1', debounceMs: 0, dirtyPatchFor: () => ({}) })
  q.markDirty('subtasks')
  q.flushSave()
  assert.equal(store.calls.length, 0)
  q.boot()
  q.markDirty('subtasks')
  q.flushSave()
  return sleep(5).then(() => assert.equal(store.calls.length, 1))
})

test('queueSave with an empty task id never dispatches (enqueue-time null guard)', async () => {
  const store = makeStore()
  const { q } = makeQueue(store, { taskId: () => null })
  q.queueSave({ todoTime: 1 })
  await sleep(10)
  assert.equal(store.calls.length, 0)
})
