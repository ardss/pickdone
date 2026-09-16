/* H1 regression (2026-09-16): tomatoEstimateState grew forever — tasks purged via the recycle bin
 * left their keys in the map and a recycled id could resurrect a stale estimate. This module now
 * exposes pruneEstimates(aliveIds) (for purge-path callers) and bounds itself at 5000 keys with
 * oldest-first trimming inside setEstimate. Main-process MetaGC owns the DB-meta twin; not covered here.
 * Run: node --test tests/unit/utils/h1-tomato-estimate-gc.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { getEstimate, setEstimate, pruneEstimates } from '../../../renderer/js/utils/tomatoEstimate.js'

test('H1: pruneEstimates drops estimates of purged task ids and keeps alive ones', () => {
  setEstimate('dead-1', 3)
  setEstimate('alive-1', 5)
  setEstimate('dead-2', 7)
  assert.equal(getEstimate('dead-1'), 3)
  const changed = pruneEstimates(['alive-1'])
  assert.equal(changed, true, 'something was removed')
  assert.equal(getEstimate('dead-1'), 0, 'purged id estimate dropped')
  assert.equal(getEstimate('dead-2'), 0, 'purged id estimate dropped')
  assert.equal(getEstimate('alive-1'), 5, 'alive id estimate kept')
  assert.equal(pruneEstimates(['alive-1']), false, 'second prune is a no-op')
})

test('H1: setEstimate trims the map to the 5000-key capacity, oldest first', () => {
  const CAP = 5000
  // Fill beyond capacity
  for (let i = 0; i < CAP + 50; i++) setEstimate('cap-' + i, 1)
  const keys = Object.keys(JSON.parse(globalThis.localStorage.getItem('tomatoEstimateState')))
  assert.ok(keys.length <= CAP, 'map bounded at ' + CAP + ', got ' + keys.length)
  assert.ok(!keys.includes('cap-0'), 'oldest entries trimmed first')
  assert.ok(keys.includes('cap-' + (CAP + 49)), 'newest entry survives')
})

test('H1: pruneEstimates persists the trimmed state to localStorage', () => {
  setEstimate('p1', 2)
  pruneEstimates([])
  const stored = JSON.parse(globalThis.localStorage.getItem('tomatoEstimateState'))
  assert.ok(!('p1' in stored), 'pruned key absent from the persisted blob')
})
