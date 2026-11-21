import test from 'node:test'
import assert from 'node:assert/strict'

// RED-FIRST (S5 continuity): URL deep links must open a concrete task by the SAME
// cross-platform id the desktop/Android use (#/task/:id), plus tab routes.
import { parseHash, hashFor } from '../src/router.js'

test('empty/root hash resolves to today', () => {
  assert.deepEqual(parseHash(''), { name: 'today' })
  assert.deepEqual(parseHash('#/'), { name: 'today' })
  assert.deepEqual(parseHash('#'), { name: 'today' })
})

test('tab routes map by name', () => {
  for (const name of ['today', 'projects', 'history', 'sync', 'backup']) {
    assert.deepEqual(parseHash('#/' + name), { name })
    assert.equal(hashFor({ name }), '#/' + name)
  }
})

test('#/task/:id deep-links to the task with the cross-platform id preserved verbatim', () => {
  const id = '3f2c8a52-6b1d-4f0a-9c8e-1a2b3c4d5e6f'
  assert.deepEqual(parseHash('#/task/' + id), { name: 'task', id })
  assert.equal(hashFor({ name: 'task', id }), '#/task/' + id)
})

test('task id is NOT decoded weirdly and survives round-trip', () => {
  const id = 'abc-DEF_123~special%2B'
  const route = parseHash('#/task/' + id)
  assert.equal(route.id, id, 'verbatim, no double decode')
  assert.equal(parseHash(hashFor(route)).id, id)
})

test('unknown routes fall back to today (never a blank screen)', () => {
  assert.deepEqual(parseHash('#/nonsense'), { name: 'today' })
  assert.deepEqual(parseHash('#/task/'), { name: 'today' }, 'missing id falls back')
})
