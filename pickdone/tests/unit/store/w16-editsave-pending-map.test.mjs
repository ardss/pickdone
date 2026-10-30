/**
 * W16 P2 regression (2026-10-28) — editSave's pending slot must be per-taskId, not wholesale.
 *
 * Bug: `pending` was a single {taskId, patch} slot. requeue (P2-5) put a failed dispatch's
 * immediate patch back there; a subsequent queueSave for a DIFFERENT task replaced the slot
 * wholesale (`pending = {...queued.patch}` branch), silently discarding task A's retry patch —
 * A's title/date/reminder edit was never persisted.
 *
 * Fix: pending is a map keyed by String(taskId); same-task patches merge, other tasks keep
 * their own slot, the timer (and flushSave) dispatches every entry to its own taskId, and a
 * failure requeues only the failed entries.
 * Run: node --test tests/unit/store/w16-editsave-pending-map.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSaveQueue } from '../../../renderer/js/utils/editSave.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

function makeStore (failOnceTaskIds) {
  // Simulates a transient failure: each listed taskId fails EXACTLY once, then succeeds.
  const failedOnce = new Set()
  return {
    dispatches: [],
    async dispatch (type, payload) {
      if (failOnceTaskIds && failOnceTaskIds.includes(payload.taskId) && !failedOnce.has(payload.taskId)) {
        failedOnce.add(payload.taskId)
        throw new Error('simulated dispatch failure')
      }
      this.dispatches.push({ type, payload })
      return payload
    }
  }
}

test('W16: a requeued failed patch for task A survives a later queueSave on task B', async () => {
  let current = 'task-A'
  const store = makeStore(['task-A']) // A's first dispatch fails -> requeue
  const q = createSaveQueue(store, { getTaskId: () => current, debounceMs: 350, dirtyPatchFor: () => ({}) })
  q.boot()

  q.queueSave({ title: 'A-edited' })
  await sleep(420) // timer fires; dispatch for A fails; A's patch is requeued into pending
  assert.equal(store.dispatches.length, 0, 'the A dispatch failed, nothing persisted yet')

  current = 'task-B'
  q.queueSave({ title: 'B-edited' }) // pre-fix: replaced the pending slot wholesale, A's patch was gone
  await sleep(420)
  const ids = store.dispatches.map(d => d.payload.taskId).sort()
  assert.deepEqual(ids, ['task-A', 'task-B'], 'both tasks\' pending patches must dispatch')
  const a = store.dispatches.find(d => d.payload.taskId === 'task-A')
  const b = store.dispatches.find(d => d.payload.taskId === 'task-B')
  assert.equal(a.payload.patch.title, 'A-edited')
  assert.equal(b.payload.patch.title, 'B-edited')
})

test('W16: same-task pending patches still merge (no behavior change on the happy path)', async () => {
  const store = makeStore()
  const q = createSaveQueue(store, { getTaskId: () => 'task-1', debounceMs: 350, dirtyPatchFor: () => ({}) })
  q.boot()
  q.queueSave({ title: 'one' })
  q.queueSave({ title: 'two', desc: 'd' })
  await sleep(420)
  assert.equal(store.dispatches.length, 1, 'same-task debounce merges into one dispatch')
  assert.deepEqual(store.dispatches[0].payload.patch, { title: 'two', desc: 'd' })
})

test('W16: flushSave dispatches each pending entry to its own enqueue-time task', async () => {
  let current = 'task-A'
  const store = makeStore()
  const q = createSaveQueue(store, { getTaskId: () => current, debounceMs: 350, dirtyPatchFor: () => ({}) })
  q.boot()
  q.queueSave({ title: 'A-edited' })
  current = 'task-B'
  q.queueSave({ title: 'B-edited' })
  await q.flushSave()
  const ids = store.dispatches.map(d => d.payload.taskId).sort()
  assert.deepEqual(ids, ['task-A', 'task-B'])
})

test('W16: a failed flushSave requeues only the failed entry — the other task is not clobbered', async () => {
  let current = 'task-A'
  const store = makeStore(['task-A'])
  const q = createSaveQueue(store, { getTaskId: () => current, debounceMs: 350, dirtyPatchFor: () => ({}) })
  q.boot()
  q.queueSave({ title: 'A-edited' })
  current = 'task-B'
  q.queueSave({ title: 'B-edited' })
  await q.flushSave()
  assert.deepEqual(store.dispatches.map(d => d.payload.taskId), ['task-B'], 'only B persisted')
  current = 'task-B'
  await q.flushSave() // retry: A's requeued patch must replay; B must not re-dispatch
  assert.deepEqual(store.dispatches.map(d => d.payload.taskId), ['task-B', 'task-A'])
  assert.equal(store.dispatches[1].payload.patch.title, 'A-edited')
})
