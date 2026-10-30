'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const { createRoundEvidence, assertDistinctDeviceIds } = require('../../../cli/relay-round-evidence.cjs')

test('same sync response is evidence; no fresh status CLI can erase a quarantined frame', () => {
  const e = createRoundEvidence()
  e.record('a', { ok: true, data: { ok: true, quarantined: 0, cursor: 3 } })
  assert.throws(() => e.record('b', { ok: true, data: { ok: true, quarantined: 1, cursor: 4 } }), /quarantined=1/)
  assert.throws(() => e.assertClean(), /quarantined=1/)
})
test('missing/non-numeric quarantine field fails closed', () => {
  const e = createRoundEvidence()
  assert.throws(() => e.record('a', { ok: true, data: { ok: true, cursor: 2 } }), /missing.*quarantined/)
  assert.throws(() => e.record('a', { ok: true, data: { ok: true, quarantined: '0' } }), /missing.*quarantined/)
})
test('both sides need actual successful rounds', () => {
  const e = createRoundEvidence()
  e.record('a', { ok: true, data: { ok: true, quarantined: 0 } })
  assert.throws(() => e.assertClean(), /device b.*no.*round/i)
  e.record('b', { ok: true, data: { ok: true, quarantined: 0 } })
  assert.deepEqual(e.assertClean(), { a: 1, b: 1 })
})
test('A and B cannot share a device identity', () => {
  assert.throws(() => assertDistinctDeviceIds({ nodeId: 'same' }, { nodeId: 'same' }), /distinct/)
  assert.throws(() => assertDistinctDeviceIds({}, { nodeId: 'b' }), /missing/)
  assert.doesNotThrow(() => assertDistinctDeviceIds({ nodeId: 'a' }, { nodeId: 'b' }))
})
