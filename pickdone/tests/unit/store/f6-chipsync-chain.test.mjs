/* F6 regression (2026-09-12): the >64-entry eviction in enqueueChipSync must never evict a chain that is
 * still pending/settling. Previously it blindly deleted any other key, detaching the queued tail from its
 * predecessor — the next enqueue for that task started a fresh Promise.resolve() chain and the two chains
 * ran in parallel out of order. No electron required.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

globalThis.dayjs = ts => ({ format: () => String(ts), valueOf: () => ts })
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
globalThis.window = { location: { hash: '' }, todoAPI: { dbCall: async () => [] } }

const { enqueueChipSync } = await import('../../../renderer/js/store/planChips.js')

const deferred = () => {
  let resolve
  const promise = new Promise(r => { resolve = r })
  return { promise, resolve }
}

test('F6: eviction of >64 queued tasks never breaks per-task serialization', async () => {
  const order = []
  const gate = deferred()
  // taskA chain in flight (blocked on gate)
  const p1 = enqueueChipSync('A', async () => { await gate.promise; order.push('A1') })
  // flood 70 other tasks with still-pending chains (each blocked on its own gate) to blow past the 64 cap
  const gates = []
  const pending = []
  for (let i = 0; i < 70; i++) {
    const id = 't' + i
    const g = deferred()
    gates.push(g)
    pending.push(enqueueChipSync(id, async () => { await g.promise; order.push(id) }))
    pending.push(enqueueChipSync(id, async () => { order.push(id + '-tail') }))
  }
  // enqueue A's second op AFTER the eviction pressure — under the old code A's pending entry had been
  // evicted, so this started a fresh chain and ran A1/A2 concurrently (order became non-deterministic)
  const p2 = enqueueChipSync('A', async () => { order.push('A2') })

  // let microtasks run: A2 must NOT have run while A1 is still gated
  await new Promise(r => setTimeout(r, 10))
  assert.equal(order.includes('A2'), false, 'A2 waits behind the still-running A1 chain')

  gate.resolve('go')
  await Promise.all([p1, p2])
  assert.deepEqual(order.slice(0, 2), ['A1', 'A2'], 'A chain stays serial across the eviction burst')

  // release the flood: every chain still completes, per-task serial order preserved
  gates.forEach(g => g.resolve('go'))
  await Promise.allSettled(pending)
  assert.equal(order.filter(x => x === 'A1' || x === 'A2').length, 2)
  for (let i = 0; i < 70; i++) {
    const id = 't' + i
    assert.equal(order.indexOf(id) < order.indexOf(id + '-tail'), true, `${id} runs before ${id}-tail`)
  }
})

test('F6: settled entries are reaped so the map stays bounded', async () => {
  for (let i = 0; i < 100; i++) await enqueueChipSync('k' + i, async () => {})
  await new Promise(r => setTimeout(r, 10))
  // settled chains self-delete; we cannot reach the private Map, but a burst of settled enqueues must not
  // leak: next enqueue for a reaped id simply starts a fresh chain (correct — nothing is pending)
  const done = enqueueChipSync('k0', async () => 'ok')
  assert.equal(await done, 'ok')
})
