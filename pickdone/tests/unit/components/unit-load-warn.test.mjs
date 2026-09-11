import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dayPlannedLoad, loadLevel } from '../../../renderer/js/utils/loadWarn.js'

const est = t => t.est

test('dayPlannedLoad sums estimates of incomplete tasks only', () => {
  const todos = [
    { id: 1, est: 3 },
    { id: 2, est: 2, complete: true }, // done: excluded
    { id: 3, est: 1, delete: true }, // deleted: excluded
    { id: 4, est: 2 }
  ]
  assert.equal(dayPlannedLoad(todos, est), 5)
})

test('dayPlannedLoad clamps missing/0 estimate to one slot per task', () => {
  assert.equal(dayPlannedLoad([{ est: 0 }, { est: null }, {}], est), 3)
  assert.equal(dayPlannedLoad([], est), 0)
  assert.equal(dayPlannedLoad(null, est), 0)
})

test('dayPlannedLoad falls back to task.tomatoEstimate without an accessor', () => {
  assert.equal(dayPlannedLoad([{ tomatoEstimate: 4 }, { tomatoEstimate: 0 }]), 5)
})

test('loadLevel: threshold <= 0 disables the warning', () => {
  assert.equal(loadLevel(99, 0), 'off')
  assert.equal(loadLevel(99, -3), 'off')
  assert.equal(loadLevel(99, undefined), 'off')
})

test('loadLevel: warn strictly above threshold, ok at or below', () => {
  assert.equal(loadLevel(10, 10), 'ok')
  assert.equal(loadLevel(11, 10), 'warn')
  assert.equal(loadLevel(3, 10), 'ok')
})

test('loadLevel: fractional thresholds round to whole tomatoes', () => {
  assert.equal(loadLevel(11, 10.4), 'warn') // threshold rounds to 10
  assert.equal(loadLevel(10, 10.4), 'ok')
})
