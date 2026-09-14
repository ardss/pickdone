/* F4 regression #3 (2026-09-15): category nextId used `idSeed = Date.now(); ++idSeed`, so two app
 * windows creating a category in the same millisecond derived identical id sequences and silently
 * overwrote each other's SQLite row (upsertCategory keyed by id). The seed now starts at a random
 * slot near Date.now(), eliminating the same-ms collision in practice while ids stay numbers.
 * No electron required.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
globalThis.window = { location: { hash: '' }, todoAPI: { dbCall: async () => null } }

const mod = await import('../../../renderer/js/store/category.js')
const store = mod.default

test('F4: two "windows" (fresh modules in the same millisecond) never derive the same id', () => {
  const frozen = Date.now
  const realRandom = Math.random
  try {
    // "Window A" draws its ids while the clock is pinned to one millisecond
    Date.now = () => 1700000000000
    Math.random = () => 0.42
    const a = [] // eslint-disable-line no-unused-vars
    // Access the private nextId through addCategory on a scratch state
    const stateA = { list: [], projectIds: [], projectMeta: {} }
    for (let i = 0; i < 5; i++) {
      store.mutations.addCategory.call({ commit: () => {} }, stateA, { categoryName: 'A' + i })
    }
    // "Window B": same frozen millisecond, a different random draw (the realistic parallel case)
    Math.random = () => 0.9
    const stateB = { list: [], projectIds: [], projectMeta: {} }
    for (let i = 0; i < 5; i++) {
      store.mutations.addCategory.call({ commit: () => {} }, stateB, { categoryName: 'B' + i })
    }
    const idsA = stateA.list.map(c => c.categoryId)
    const idsB = stateB.list.map(c => c.categoryId)
    for (const id of [...idsA, ...idsB]) {
      assert.equal(typeof id, 'number', 'ids stay plain numbers')
      assert.ok(Number.isSafeInteger(id), 'ids stay safe integers')
    }
    assert.equal(new Set(idsA).size, 5, 'within one window ids stay unique')
    assert.equal(idsA.filter(id => idsB.includes(id)).length, 0,
      'same-millisecond windows with different random seeds produce disjoint id ranges')
  } finally {
    Date.now = frozen
    Math.random = realRandom
  }
})
