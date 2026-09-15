/* F4 regression #7 (2026-09-15): queueSave drained ALL dirty flags before dispatching; on dispatch
 * failure it only called opts.onFail — the drained keys were gone for good and the failed batch was
 * never retried (flushSave already had restore). queueSave now re-marks the drained keys on failure
 * so a later queueSave/flushSave retries them, merged with anything marked since. No electron required.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createSaveQueue } from '../../../renderer/js/utils/editSave.js'

const sleep = ms => new Promise(r => setTimeout(r, ms))

function makeStore () {
  return {
    failNext: false,
    dispatches: [],
    async dispatch (type, payload) {
      this.dispatches.push({ type, payload })
      if (this.failNext) { this.failNext = false; throw new Error('db down') }
      return payload
    }
  }
}

function makeQueue (store) {
  const flags = { failed: 0 }
  const q = createSaveQueue(store, {
    getTaskId: () => 'task-1',
    debounceMs: 0,
    dirtyPatchFor: k => ({ subtasks: { subtasks: '["a"]' }, imgs: { image: '["p"]' } }[k]),
    onFail: () => { flags.failed++ }
  })
  q.boot()
  return { q, flags }
}

test('F4: queueSave failure restores the drained dirty keys for retry', async () => {
  const store = makeStore()
  store.failNext = true
  const { q, flags } = makeQueue(store)
  q.markDirty('subtasks')
  q.markDirty('imgs')
  q.queueSave({})
  await sleep(10)
  assert.equal(flags.failed, 1, 'failure surfaced')
  assert.equal(store.dispatches.length, 1)
  // Retry after the transient failure must re-include the previously drained fields
  q.queueSave({ title: 'x' })
  await sleep(10)
  const retry = store.dispatches[1]
  assert.ok(retry, 'retry dispatched')
  assert.equal(retry.payload.patch.title, 'x')
  assert.equal(retry.payload.patch.subtasks, '["a"]', 'previously drained key restored into the retry')
  assert.equal(retry.payload.patch.image, '["p"]', 'all restored keys ride along, original set preserved')
})

test('F4: keys marked between failure and retry are kept (restore merges, flushSave order)', async () => {
  const store = makeStore()
  store.failNext = true
  const { q } = makeQueue(store)
  q.markDirty('subtasks')
  q.queueSave({})
  await sleep(10)
  q.markDirty('imgs') // marked while the failed batch was "in flight"
  q.queueSave({})
  await sleep(10)
  const patch = store.dispatches[1].payload.patch
  assert.equal(patch.subtasks, '["a"]')
  assert.equal(patch.image, '["p"]')
})

test('F4: success path still drains (no duplicate retry)', async () => {
  const store = makeStore()
  const { q } = makeQueue(store)
  q.markDirty('subtasks')
  q.queueSave({})
  await sleep(10)
  q.markDirty('imgs')
  q.queueSave({})
  await sleep(10)
  const second = store.dispatches[1]
  assert.equal(second.payload.patch.image, '["p"]', 'newly marked key dispatches')
  assert.equal(second.payload.patch.subtasks, undefined, 'successful drain is not resurrected')
})
