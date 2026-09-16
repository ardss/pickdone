/* H1 regression (2026-09-16): queueSave's immediate patch (fieldPatch title/desc/categoryId/
 * priority/deadlineTs, applyDate, onRemindersCommit go through queueSave but never markDirty)
 * lived only in the debounce timer closure — flushSave's clearTimeout discarded it wholesale,
 * so editing a title and closing the panel within 350ms silently lost the edit. flushSave now
 * merges the pending patch (with its enqueue-time taskId snapshot) into its dispatch.
 * Run: node --test tests/unit/store/h1-editsave-flush-pending.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSaveQueue } from '../../../renderer/js/utils/editSave.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

function makeStore () {
  return {
    dispatches: [],
    async dispatch (type, payload) { this.dispatches.push({ type, payload }); return payload }
  }
}

function makeQueue (store, getTaskId = () => 'task-1') {
  const q = createSaveQueue(store, { getTaskId, debounceMs: 350, dirtyPatchFor: () => ({}) })
  q.boot()
  return q
}

test('H1: queueSave followed immediately by flushSave still dispatches the pending patch', async () => {
  const store = makeStore()
  const q = makeQueue(store)
  q.queueSave({ title: 'edited title' })
  q.flushSave() // panel close / task switch inside the 350ms debounce window
  await sleep(10)
  assert.equal(store.dispatches.length, 1, 'exactly one dispatch')
  assert.equal(store.dispatches[0].payload.taskId, 'task-1')
  assert.equal(store.dispatches[0].payload.patch.title, 'edited title')
  // No double-dispatch when the (cleared) debounce timer never fires
  await sleep(400)
  assert.equal(store.dispatches.length, 1, 'cleared debounce timer must not re-dispatch')
})

test('H1: flushSave merges the pending patch with dirty-flag fields', async () => {
  const store = makeStore()
  const q = createSaveQueue(store, {
    getTaskId: () => 'task-1',
    debounceMs: 350,
    dirtyPatchFor: k => ({ subtasks: { subtasks: '["a"]' } }[k])
  })
  q.boot()
  q.markDirty('subtasks')
  q.queueSave({ title: 'x' })
  q.flushSave()
  await sleep(10)
  const patch = store.dispatches[0].payload.patch
  assert.equal(patch.title, 'x')
  assert.equal(patch.subtasks, '["a"]', 'dirty fields ride along in the same dispatch')
})

test('H1: pending patch commits to its enqueue-time task after a task switch + flush', async () => {
  const store = makeStore()
  let current = 'task-A'
  const q = createSaveQueue(store, {
    getTaskId: () => current,
    debounceMs: 350,
    dirtyPatchFor: k => ({ subtasks: { subtasks: '["a"]' } }[k])
  })
  q.boot()
  q.queueSave({ title: 'A edit' })
  current = 'task-B'
  q.markDirty('subtasks')
  q.flushSave()
  await sleep(10)
  const a = store.dispatches.find(d => d.payload.taskId === 'task-A')
  const b = store.dispatches.find(d => d.payload.taskId === 'task-B')
  assert.ok(a, 'queued edit dispatched to the enqueue-time task A')
  assert.equal(a.payload.patch.title, 'A edit')
  assert.equal(a.payload.patch.subtasks, undefined, 'task B dirty fields do not leak into A')
  assert.ok(b, 'current-task dirty fields dispatched to task B')
  assert.equal(b.payload.patch.subtasks, '["a"]')
})

test('H1: debounce path unchanged — queued patch fires after debounceMs', async () => {
  const store = makeStore()
  const q = makeQueue(store)
  q.queueSave({ title: 'later' })
  await sleep(10)
  assert.equal(store.dispatches.length, 0, 'not yet fired inside the window')
  await sleep(400)
  assert.equal(store.dispatches.length, 1)
  assert.equal(store.dispatches[0].payload.patch.title, 'later')
})
