import test from 'node:test'
import assert from 'node:assert/strict'
import { createEnvelope } from '../../../shared/sync-core/revision/envelope.mjs'
import { createRevisionStore, applyEnvelope, materialized } from '../../../shared/sync-core/causality/merge.mjs'

/**
 * S1 acceptance: a causally-LATER revision authored on a slow/rolled-back clock
 * must never lose to its causally-earlier ancestor whose stamp is huge (skewed
 * fast clock), even when delivery is out-of-order and the causal chain is long.
 *
 * The chain below is fully linked (every intermediate revision is known to the
 * store when the late ancestor arrives), so ancestry is provable from the graph
 * alone — no stamp comparison should ever override it. Winner selection by HLC
 * is only legitimate for TRUE concurrent revisions.
 */

const entity = { entity: 'todo', entityId: 't1' }

test('S1: slow-clock causal descendant must not lose to a late fast-clock ancestor (long chain, out-of-order)', () => {
  // devFast authors the FIRST revision with a hugely skewed-forward clock (physical 9e9).
  const r1 = createEnvelope({ ...entity, hlc: { physical: 9_000_000_000, logical: 0, nodeId: 'devFast' }, parents: [], payload: { title: 'fast-ancestor' } })

  // devSlow continues the causal chain with a rolled-back wall clock (physical ~1000):
  // every child is causally AFTER its parent, but its HLC stamp is far SMALLER
  // (e.g. the device lost persisted HLC state — hlc.mjs restore() cannot fix a
  // rolled-back wall clock it never sees).
  const chain = [r1]
  for (let i = 1; i < 40; i++) {
    const parent = chain[chain.length - 1]
    chain.push(createEnvelope({
      ...entity,
      hlc: { physical: 1000 + i, logical: 0, nodeId: 'devSlow' },
      parents: [parent.revisionId],
      payload: { title: `slow-child-${i}` },
    }))
  }
  const tip = chain[chain.length - 1] // causally newest, stamp-wise oldest

  // Store receives the chain OUT OF ORDER: everything except r1 first (r2's parent
  // r1 is unknown on arrival — conservative), then r1 arrives LAST as a late
  // duplicate-ish replay from another path. All 40 revisions end up in the store.
  const x = createRevisionStore('devX')
  for (const r of chain.slice(1)) applyEnvelope(x, r)
  assert.equal(materialized(x, 't1').current.revisionId, tip.revisionId)

  const res = applyEnvelope(x, r1)
  assert.ok(res.status === 'ignored' || res.status === 'ancestor' || res.status === 'duplicate',
    `late provable ancestor must not reapply as concurrent, got ${JSON.stringify(res)}`)
  // The load-bearing assertion: the causally-newest slow revision stays current.
  assert.equal(materialized(x, 't1').current.revisionId, tip.revisionId,
    'S1 violated: slow-clock causal descendant lost to fast-clock ancestor')
  assert.equal(materialized(x, 't1').current.payload.title, 'slow-child-39')
  assert.equal(materialized(x, 't1').conflicts.length, 0, 'no conflict copy: the branches are not concurrent')
})

test('S1 control: the SAME stamps with genuinely concurrent branches DO resolve by HLC and preserve the loser', () => {
  // Proves the fix above did not weaken true-concurrent semantics: a fast-clock
  // revision NOT on the descendant's causal line still wins the stamp race and
  // the slow branch is preserved as a conflict copy.
  const base = createEnvelope({ ...entity, hlc: { physical: 100, logical: 0, nodeId: 'devBase' }, parents: [], payload: { title: 'base' } })
  // rebuild the same slow chain for the control
  const slowChain = []
  {
    let prev = base
    for (let i = 1; i < 40; i++) {
      prev = createEnvelope({
        ...entity,
        hlc: { physical: 1000 + i, logical: 0, nodeId: 'devSlow' },
        parents: [prev.revisionId],
        payload: { title: `slow-child-${i}` },
      })
      slowChain.push(prev)
    }
  }
  const fastConcurrent = createEnvelope({ ...entity, hlc: { physical: 9_000_000_000, logical: 0, nodeId: 'devFast' }, parents: [base.revisionId], payload: { title: 'fast-concurrent' } })

  const x = createRevisionStore('devX')
  applyEnvelope(x, base)
  for (const r of slowChain) applyEnvelope(x, r)
  applyEnvelope(x, fastConcurrent)

  assert.equal(materialized(x, 't1').current.payload.title, 'fast-concurrent', 'true concurrent resolves by HLC — fast stamp wins')
  assert.equal(materialized(x, 't1').conflicts.length, 1, 'losing slow branch preserved as conflict copy')
  assert.equal(materialized(x, 't1').conflicts[0].payload.title, 'slow-child-39')
})
