/**
 * perf-ensure-estimate-unbatched-ipc-first-paint — regression test.
 *
 * Root cause: ensureEstimate trusted only the volatile `fetched` Set, and initFromDb ENDS with
 * invalidateEstimateCache() — so any value seeded before boot was re-fetched. N cold task ids on
 * first paint produced N individual getMeta IPCs.
 *
 * Fix: (1) epoch-guarded mirror — values landing via ensureEstimate/setEstimate record the cache
 * epoch; a `state` hit whose epoch is current memoizes without an IPC (invalidateEstimateCache
 * bumps the epoch, so inbound meta rounds still re-fetch). (2) cold ids coalesce through a
 * microtask-batched queue issuing ONE getMetaManyWithFallback(ids) call.
 *
 * Red before the fix: 300 seeded ids → 300 getMeta calls, 0 getMetaMany.
 * Green after: 0 getMeta, exactly 1 getMetaMany batch per generation.
 * Run: node --test tests/unit/utils/domainA-estimate-batch.test.mjs
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const store = new Map()
let getMetaCount = 0
let getMetaManyCalls = 0

globalThis.localStorage = {
  getItem: k => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => { store.set(k, v) },
  removeItem: k => { store.delete(k) }
}
globalThis.window = {
  location: { hash: '' },
  todoAPI: {
    dbCall: (op, key) => {
      if (op === 'getMeta') { getMetaCount++; return Promise.resolve(store.get(key) ?? null) }
      return Promise.resolve(null)
    },
    getMetaMany: keys => {
      getMetaManyCalls++
      return Promise.resolve(keys.map(k => ({ key: k, value: store.has(k) ? store.get(k) : null })))
    }
  }
}

const { ensureEstimate, getEstimate, setEstimate, invalidateEstimateCache } =
  await import('../../../renderer/js/utils/tomatoEstimate.js')

const drain = () => new Promise(r => setTimeout(r, 0))

beforeEach(() => {
  store.clear()
  getMetaCount = 0
  getMetaManyCalls = 0
  invalidateEstimateCache()
})

test('300 cold ids coalesce into ONE getMetaManyWithFallback batch and ZERO per-key getMeta', async () => {
  const ids = []
  for (let i = 0; i < 300; i++) {
    const id = 'seed-' + i
    ids.push(id)
    store.set('tomatoEstimateState:' + id, String((i % 20) + 1)) // DB has a value for every id
  }
  const ps = ids.map(id => ensureEstimate(id))
  await Promise.all(ps)
  await drain()
  assert.equal(getMetaCount, 0, 'no per-key getMeta IPC may fire (was 300 before the fix)')
  assert.equal(getMetaManyCalls, 1, 'all cold ids must ride a single batched meta read')
  assert.equal(getEstimate('seed-0'), 1, 'values land in the mirror')
  assert.equal(getEstimate('seed-299'), 20)
})

test('after invalidateEstimateCache the re-fetch is again exactly ONE batched call', async () => {
  for (let i = 0; i < 50; i++) {
    const id = 'inv-' + i
    store.set('tomatoEstimateState:' + id, '3')
    ensureEstimate(id)
  }
  await drain()
  assert.equal(getMetaManyCalls, 1)

  // Inbound meta round: invalidation must NOT be sticky-skipped — next reads re-fetch, batched.
  invalidateEstimateCache()
  store.set('tomatoEstimateState:inv-0', '9')
  const ps = []
  for (let i = 0; i < 50; i++) ps.push(ensureEstimate('inv-' + i))
  await Promise.all(ps)
  await drain()
  assert.equal(getMetaManyCalls, 2, 're-fetch after invalidation is one NEW batch (not memoized stale)')
  assert.equal(getEstimate('inv-0'), 9, 'the refreshed value wins after invalidation')
})

test('epoch guard: a value written via setEstimate is a no-IPC mirror hit', async () => {
  setEstimate('local-1', 7)
  getMetaCount = 0
  getMetaManyCalls = 0
  ensureEstimate('local-1')
  await drain()
  assert.equal(getEstimate('local-1'), 7, 'local write stays authoritative')
  assert.equal(getMetaCount, 0, 'epoch-current mirror hit must not re-fetch')
  assert.equal(getMetaManyCalls, 0)
})

test('setEstimate values DO re-fetch after invalidation (epoch is no longer current) — exactly 1 batch', async () => {
  setEstimate('local-2', 4)
  invalidateEstimateCache() // inbound meta round: the old write's epoch is stale now
  getMetaCount = 0
  getMetaManyCalls = 0
  store.set('tomatoEstimateState:local-2', '4')
  const ps = []
  for (let i = 0; i < 30; i++) ps.push(ensureEstimate('local-2'))
  await Promise.all(ps)
  await drain()
  assert.equal(getMetaManyCalls, 1, 're-fetch after invalidation rides one batch')
  assert.equal(getMetaCount, 0)
})

test('failing batch host degrades to the per-key fallback without wedging (memoized, no retry loop)', async () => {
  const orig = globalThis.window.todoAPI.getMetaMany
  globalThis.window.todoAPI.getMetaMany = () => Promise.reject(new Error('bus down'))
  store.set('tomatoEstimateState:fb-1', '5')
  const p = ensureEstimate('fb-1')
  assert.ok(p && typeof p.then === 'function', 'ensureEstimate still returns a promise')
  await Promise.all([p]).catch(() => {})
  await drain()
  assert.ok(getMetaCount >= 1, 'fallback used the per-key dbCall loop')
  assert.equal(getEstimate('fb-1'), 5)
  // memoized even on a flaky batch: second read is a no-op
  getMetaCount = 0
  ensureEstimate('fb-1')
  await drain()
  assert.equal(getMetaCount, 0, 'no infinite retry on flaky reads (fetched memoization kept)')
  globalThis.window.todoAPI.getMetaMany = orig
})
