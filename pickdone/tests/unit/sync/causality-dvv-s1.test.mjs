import test from 'node:test'
import assert from 'node:assert/strict'
import { Hlc } from '../../../shared/sync-core/clock/hlc.mjs'
import { createEnvelope } from '../../../shared/sync-core/revision/envelope.mjs'
import { createRevisionStore, commitLocal, applyEnvelope, materialized } from '../../../shared/sync-core/causality/merge.mjs'
import { dvvRelation } from '../../../shared/sync-core/causality/dvv.mjs'

const entity = { entity: 'todo', entityId: 's1' }
function rev(node, time, text, dvv, parents = []) {
  return createEnvelope({ ...entity, hlc: { physical: time, logical: 0, nodeId: node }, parents, payload: { title: text }, dvv })
}
const fast = rev('A', 999999, 'fast old', { dot: { deviceId: 'A', counter: 1 }, context: {} })
const slow = rev('B', 10, 'slow new', { dot: { deviceId: 'B', counter: 1 }, context: { A: 1 } })
// Deliberately absent parent link / missing history. DVV must still preserve causality.
test('S1 opt-in: a slow-clock successor wins despite missing parent graph', () => {
  for (const order of [[fast, slow], [slow, fast]]) {
    const store = createRevisionStore('R', { useDvv: true })
    for (const envelope of order) applyEnvelope(store, envelope)
    const m = materialized(store, 's1')
    assert.equal(m.current.revisionId, slow.revisionId)
    assert.equal(m.conflicts.length, 0)
  }
})
test('S1: causal winner does not depend on arrival order or HLC skew', () => {
  assert.equal(dvvRelation(slow, fast), 'descendant')
  assert.equal(dvvRelation(fast, slow), 'ancestor')
})
test('S1: legacy behaviour remains default-off (no silent production switch)', () => {
  const store = createRevisionStore('R')
  applyEnvelope(store, slow)
  applyEnvelope(store, fast)
  assert.equal(materialized(store, 's1').current.revisionId, fast.revisionId)
})
test('S1: actual concurrency still preserves conflict copy', () => {
  const a = rev('A', 10, 'A branch', { dot: { deviceId: 'A', counter: 1 }, context: {} })
  const b = rev('B', 20, 'B branch', { dot: { deviceId: 'B', counter: 1 }, context: {} })
  const store = createRevisionStore('R', { useDvv: true })
  assert.equal(dvvRelation(a, b), 'concurrent')
  applyEnvelope(store, a)
  assert.equal(applyEnvelope(store, b).action, 'concurrent')
  assert.equal(materialized(store, 's1').conflicts.length, 1)
})
test('S1: remote retries are idempotent', () => {
  const store = createRevisionStore('R', { useDvv: true })
  applyEnvelope(store, slow)
  assert.equal(applyEnvelope(store, { ...slow }).status, 'duplicate')
})
test('S1: commitLocal carries parent context for the next local revision', () => {
  const store = createRevisionStore('B', { useDvv: true })
  applyEnvelope(store, fast)
  const clock = new Hlc('B', { now: () => 10 })
  const next = commitLocal(store, { ...entity, clock, payload: { title: 'new local child' } })
  assert.equal(next.dvv.dot.deviceId, 'B')
  assert.equal(next.dvv.context.A, 1)
  assert.equal(dvvRelation(next, fast), 'descendant')
})
test('S1: incomplete or malformed DVV never overrides fallback semantics', () => {
  const a = rev('A', 1, 'one', { dot: { deviceId: 'A', counter: -1 }, context: {} })
  assert.equal(dvvRelation(a, slow), 'unknown')
  assert.equal(dvvRelation({ ...slow, dvv: undefined }, fast), 'unknown')
})
