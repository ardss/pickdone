import test from 'node:test'
import assert from 'node:assert/strict'
import { Hlc } from '../../../shared/sync-core/clock/hlc.mjs'
import { createEnvelope, packEnvelope, unpackEnvelope } from '../../../shared/sync-core/revision/envelope.mjs'
import { createRevisionStore, commitLocal, applyEnvelope, materialized } from '../../../shared/sync-core/causality/merge.mjs'

/**
 * Wave-1 delivery tests for the v2 causal merge (spec §9-§12):
 * out-of-order replay, duplicate idempotency, cross-device clock skew,
 * concurrent edits on different fields, same-field conflicts,
 * delete vs edit / delete vs restore.
 * Every convergence assertion runs BOTH application orders where order can vary.
 */

const entity = { entity: 'todo', entityId: 't1' }

/** Deterministic winner convergence across two stores after applying the same envelope set. */
function assertConverged(a, b, entityId, note = '') {
  const ma = materialized(a, entityId)
  const mb = materialized(b, entityId)
  assert.equal(ma.current.revisionId, mb.current.revisionId, `current revision must converge ${note}`)
  assert.deepEqual(
    ma.conflicts.map(c => c.revisionId).sort(),
    mb.conflicts.map(c => c.revisionId).sort(),
    `conflict copies must converge ${note}`
  )
}

// ---------- 1. 乱序重放 (out-of-order replay) ----------

test('out-of-order chain: child applied before parents still converges, parents land as ancestors', () => {
  const a = createRevisionStore('devA')
  const clockA = new Hlc('devA', { now: () => 1000 })
  const r1 = commitLocal(a, { ...entity, clock: clockA, payload: { title: 'v1' } })
  const r2 = commitLocal(a, { ...entity, clock: clockA, payload: { title: 'v2' } })
  const r3 = commitLocal(a, { ...entity, clock: clockA, payload: { title: 'v3' } })

  const b = createRevisionStore('devB')
  // delivery order 3,1,2 (worst reorder)
  const res3 = applyEnvelope(b, r3)
  assert.equal(res3.status, 'applied')
  applyEnvelope(b, r1)
  applyEnvelope(b, r2)
  // after full delivery the current must be the tip of the chain r3
  assert.equal(materialized(b, 't1').current.revisionId, r3.revisionId)
  assert.equal(materialized(b, 't1').conflicts.length, 0, 'no spurious conflict from reordering')
  // and store A (author) agrees with B
  assertConverged(a, b, 't1', '(reordered chain)')
})

test('out-of-order replay of an old revision after a newer current is ignored (ancestor), never resurrects', () => {
  const b = createRevisionStore('devB')
  const clockA = new Hlc('devA', { now: () => 1000 })
  const r1 = createEnvelope({ ...entity, hlc: clockA.tick(), parents: [], payload: { title: 'v1' } })
  const r2 = createEnvelope({ ...entity, hlc: clockA.tick(), parents: [r1.revisionId], payload: { title: 'v2' } })
  applyEnvelope(b, r2) // tip arrives first
  const res = applyEnvelope(b, r1) // stale replay afterwards
  assert.ok(res.status === 'ignored' || res.status === 'ancestor', `stale replay must not reapply, got ${JSON.stringify(res)}`)
  assert.equal(materialized(b, 't1').current.payload.title, 'v2')
})

// ---------- 2. 重复包幂等 (duplicate idempotency) ----------

test('duplicate delivery of the same envelope is idempotent across arbitrary replays', () => {
  const a = createRevisionStore('devA')
  const b = createRevisionStore('devB')
  const clockA = new Hlc('devA', { now: () => 1000 })
  const r1 = commitLocal(a, { ...entity, clock: clockA, payload: { title: 'x' } })

  assert.equal(applyEnvelope(b, r1).status, 'applied')
  for (let i = 0; i < 5; i++) {
    const dup = unpackEnvelope(packEnvelope(r1)) // fresh object each time, wire roundtrip
    assert.equal(applyEnvelope(b, dup).status, 'duplicate')
  }
  assert.equal(materialized(b, 't1').current.revisionId, r1.revisionId)
  assert.equal(materialized(b, 't1').conflicts.length, 0)
  assertConverged(a, b, 't1', '(duplicates)')
})

test('duplicate concurrent-loser replay does not re-mint or duplicate the conflict copy', () => {
  const b = createRevisionStore('devB')
  const ra = createEnvelope({ ...entity, hlc: { physical: 100, logical: 0, nodeId: 'devA' }, payload: { title: 'a' } })
  const rb = createEnvelope({ ...entity, hlc: { physical: 100, logical: 0, nodeId: 'devB' }, payload: { title: 'b' } })
  applyEnvelope(b, ra)
  applyEnvelope(b, rb)
  const conflictsAfterFirst = materialized(b, 't1').conflicts.length
  assert.equal(conflictsAfterFirst, 1)
  for (let i = 0; i < 3; i++) {
    assert.equal(applyEnvelope(b, unpackEnvelope(packEnvelope(ra))).status, 'duplicate')
    assert.equal(applyEnvelope(b, unpackEnvelope(packEnvelope(rb))).status, 'duplicate')
  }
  assert.equal(materialized(b, 't1').conflicts.length, conflictsAfterFirst, 'replays must not mint extra copies')
})

// ---------- 3. 跨设备时钟偏差 (cross-device clock skew) ----------

test('device with a wall clock far BEHIND still orders correctly after receiving peer stamps', () => {
  const a = createRevisionStore('devA')
  const clockA = new Hlc('devA', { now: () => 10_000_000 }) // wall clock ahead
  const ra = commitLocal(a, { ...entity, clock: clockA, payload: { title: 'from-ahead' } })

  const b = createRevisionStore('devB')
  const clockB = new Hlc('devB', { now: () => 1000 }) // wall clock ~11 days behind
  applyEnvelope(b, ra)
  clockB.receive(ra.hlc) // receiving advances B past A's physical — the causality bridge
  const rb = commitLocal(b, { ...entity, clock: clockB, payload: { title: 'from-behind' } })
  applyEnvelope(a, rb)

  assert.ok(cmp(rb.hlc, ra.hlc) > 0, 'B post-receive stamp must dominate A despite wall skew')
  assert.equal(materialized(a, 't1').current.payload.title, 'from-behind')
  assert.equal(materialized(b, 't1').current.payload.title, 'from-behind')
  assertConverged(a, b, 't1', '(behind clock)')
  assert.equal(materialized(a, 't1').conflicts.length, 0, 'B built on A — sequential, not concurrent')
})

function cmp(x, y) {
  if (x.physical !== y.physical) return x.physical < y.physical ? -1 : 1
  if (x.logical !== y.logical) return x.logical < y.logical ? -1 : 1
  return x.nodeId < y.nodeId ? -1 : x.nodeId > y.nodeId ? 1 : 0
}

test('device with a wall clock far AHEAD cannot permanently win every concurrent conflict', () => {
  // The store-level guard against a skewed peer: causality classifies first, so a
  // skewed stamp only breaks TIES between truly concurrent edits — and the loser
  // is preserved as a conflict copy on every device.
  const ahead = createEnvelope({ ...entity, hlc: { physical: 99_999_999_999, logical: 0, nodeId: 'devA' }, payload: { title: 'ahead' } })
  const honest = createEnvelope({ ...entity, hlc: { physical: 100, logical: 0, nodeId: 'devB' }, payload: { title: 'honest' } })
  const x = createRevisionStore('devX')
  const y = createRevisionStore('devY')
  applyEnvelope(x, ahead); applyEnvelope(x, honest)
  applyEnvelope(y, honest); applyEnvelope(y, ahead)
  assertConverged(x, y, 't1', '(skewed stamp)')
  assert.equal(materialized(x, 't1').conflicts.length, 1, 'the honest edit must survive as a conflict copy')
})

test('commitLocal receives every parent stamp: child HLC dominates parents even under adversarial skew', () => {
  const a = createRevisionStore('devA')
  const clock = new Hlc('devA', { now: () => 0 })
  const remote = { physical: 5_000_000_000, logical: 42, nodeId: 'devZ' }
  const rz = createEnvelope({ ...entity, hlc: remote, payload: { title: 'z' } })
  applyEnvelope(a, rz)
  const next = commitLocal(a, { ...entity, clock, payload: { title: 'child' } })
  assert.ok(cmp(next.hlc, remote) > 0, 'child stamp must dominate the skewed remote parent')
  assert.deepEqual(next.parents, [rz.revisionId])
})

// ---------- 4. 不同字段并发 (concurrent edits to different fields) ----------

test('concurrent edits to DIFFERENT fields: deterministic winner, both revisions preserved', () => {
  const ra = createEnvelope({ ...entity, hlc: { physical: 100, logical: 0, nodeId: 'devA' }, payload: { title: 'T', done: false } })
  const rb = createEnvelope({ ...entity, hlc: { physical: 100, logical: 0, nodeId: 'devB' }, payload: { title: 'T', done: true } })
  const a = createRevisionStore('devA')
  const b = createRevisionStore('devB')
  applyEnvelope(a, ra); applyEnvelope(a, rb)
  applyEnvelope(b, rb); applyEnvelope(b, ra)
  assertConverged(a, b, 't1', '(different fields)')
  // whole-payload LWW: winner by HLC, loser preserved — field-level merge is NOT attempted
  const cur = materialized(a, 't1').current
  assert.equal(cur.payload.done, cur.hlc.nodeId === 'devB')
  assert.equal(materialized(a, 't1').conflicts.length, 1, 'the other field edit survives as a conflict copy')
})

// ---------- 5. 同字段冲突 (same-field conflict) ----------

test('concurrent same-field conflict: identical winner on both peers regardless of arrival order', () => {
  const ra = createEnvelope({ ...entity, hlc: { physical: 100, logical: 0, nodeId: 'devA' }, payload: { title: 'A-title' } })
  const rb = createEnvelope({ ...entity, hlc: { physical: 200, logical: 0, nodeId: 'devB' }, payload: { title: 'B-title' } })
  const a = createRevisionStore('devA')
  const b = createRevisionStore('devB')
  applyEnvelope(a, ra); const ra2 = applyEnvelope(a, rb)
  applyEnvelope(b, rb); const rb2 = applyEnvelope(b, ra)
  assert.equal(ra2.action, 'concurrent')
  assert.equal(rb2.action, 'concurrent')
  assert.equal(materialized(a, 't1').current.payload.title, 'B-title')
  assert.equal(materialized(b, 't1').current.payload.title, 'B-title')
  assert.equal(materialized(a, 't1').conflicts[0].payload.title, 'A-title')
  assert.equal(materialized(b, 't1').conflicts[0].payload.title, 'A-title')
})

// ---------- 6. 删除与编辑/恢复 (delete vs edit / restore) ----------

test('delete vs concurrent newer edit: edit wins by HLC, deletion preserved as copy; replay is stable', () => {
  const base = createEnvelope({ ...entity, hlc: { physical: 100, logical: 0, nodeId: 'devA' }, payload: { title: 'base' } })
  const tomb = createEnvelope({ ...entity, hlc: { physical: 150, logical: 0, nodeId: 'devB' }, parents: [base.revisionId], payload: { title: 'base', deleted: true } })
  const edit = createEnvelope({ ...entity, hlc: { physical: 300, logical: 0, nodeId: 'devC' }, parents: [base.revisionId], payload: { title: 'edited-after-delete' } })
  const a = createRevisionStore('devA')
  const b = createRevisionStore('devB')
  for (const s of [a, b]) { applyEnvelope(s, base) }
  applyEnvelope(a, tomb); applyEnvelope(a, edit)
  applyEnvelope(b, edit); applyEnvelope(b, tomb)
  assertConverged(a, b, 't1', '(delete vs newer edit)')
  assert.equal(materialized(a, 't1').current.payload.deleted, undefined, 'newer live edit survives the older delete')
  assert.equal(materialized(a, 't1').conflicts.some(c => c.payload.deleted === true), true, 'the tombstone is preserved as a conflict copy')
})

test('restore: commitLocal over a tombstone current produces a live child that dominates the delete', () => {
  const a = createRevisionStore('devA')
  const clockA = new Hlc('devA', { now: () => 1000 })
  const r1 = commitLocal(a, { ...entity, clock: clockA, payload: { title: 'v1' } })
  const r2 = commitLocal(a, { ...entity, clock: clockA, payload: { title: 'v1', deleted: true } })
  const r3 = commitLocal(a, { ...entity, clock: clockA, payload: { title: 'restored' } })
  assert.deepEqual(r2.parents, [r1.revisionId])
  assert.deepEqual(r3.parents, [r2.revisionId])

  const b = createRevisionStore('devB')
  for (const r of [r1, r2, r3]) applyEnvelope(b, r)
  assert.equal(materialized(b, 't1').current.payload.title, 'restored')
  assert.equal(materialized(b, 't1').current.payload.deleted, undefined)
  assert.equal(materialized(b, 't1').conflicts.length, 0)
  assertConverged(a, b, 't1', '(restore chain)')
})

test('restore after tombstone won a concurrent race: multi-parent commit supersedes both branches', () => {
  const base = createEnvelope({ ...entity, hlc: { physical: 100, logical: 0, nodeId: 'devA' }, payload: { title: 'base' } })
  const tomb = createEnvelope({ ...entity, hlc: { physical: 200, logical: 0, nodeId: 'devB' }, parents: [base.revisionId], payload: { title: 'base', deleted: true } })
  const edit = createEnvelope({ ...entity, hlc: { physical: 150, logical: 0, nodeId: 'devC' }, parents: [base.revisionId], payload: { title: 'divergent' } })
  const a = createRevisionStore('devA')
  for (const r of [base, tomb, edit]) applyEnvelope(a, r)
  assert.equal(materialized(a, 't1').current.payload.deleted, true, 'tombstone wins the concurrent race by HLC')
  assert.equal(materialized(a, 't1').conflicts.length, 1)
  // user restores: the merge commit must supersede the tombstone AND the losing branch
  const clock = new Hlc('devA', { now: () => 5000 })
  clock.receive(tomb.hlc)
  const restore = commitLocal(a, { ...entity, clock, payload: { title: 'user-restored' } })
  const heads = a.headsByEntity.get('t1')
  assert.equal(heads.size, 0, 'restore must clear unresolved concurrent heads')
  assert.equal(materialized(a, 't1').current.revisionId, restore.revisionId)
  assert.equal(materialized(a, 't1').current.payload.deleted, undefined)
  assert.equal(materialized(a, 't1').conflicts.length, 0, 'causally-resolved conflict copy is pruned from the materialized view')
})
