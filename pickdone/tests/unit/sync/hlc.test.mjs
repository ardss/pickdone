import test from 'node:test'
import assert from 'node:assert/strict'
import { Hlc, cmpHlc, hlcMax, revisionIdFrom } from '../../../shared/sync-core/clock/hlc.mjs'

const stamp = (physical, logical, nodeId) => ({ physical, logical, nodeId })

test('hlc: local ticks are strictly monotone even with a frozen wall clock', () => {
  const c = new Hlc('devA', { now: () => 1000 })
  const s1 = c.tick()
  const s2 = c.tick()
  const s3 = c.tick()
  assert.deepEqual([s1.logical, s2.logical, s3.logical], [0, 1, 2])
  assert.equal(cmpHlc(s1, s2), -1)
  assert.equal(cmpHlc(s2, s3), -1)
})

test('hlc: wall-clock rollback never lowers the clock', () => {
  let now = 5000
  const c = new Hlc('devA', { now: () => now })
  const before = c.tick()
  now = 1000 // clock jumped backwards 4s
  const after = c.tick()
  assert.equal(cmpHlc(before, after), -1)
  assert.equal(after.physical, 5000)
})

test('hlc: receiving a remote stamp advances past both sides (causality crosses devices)', () => {
  const a = new Hlc('devA', { now: () => 1000 })
  const b = new Hlc('devB', { now: () => 900 })
  const remote = a.tick() // (1000, 0, devA)
  const got = b.receive(remote)
  assert.equal(cmpHlc(got, remote), 1)
  // and a is strictly newer than what it received back
  const back = a.receive(got)
  assert.equal(cmpHlc(back, got), 1)
  assert.equal(cmpHlc(back, remote), 1)
})

test('hlc: receive with remote far in the future adopts remote physical, logical+1', () => {
  const c = new Hlc('devA', { now: () => 1000 })
  const got = c.receive(stamp(9_999_999, 5, 'devB'))
  assert.equal(got.physical, 9_999_999)
  assert.equal(got.logical, 6)
})

test('hlc: receive with our own state dominating still moves forward (no logical reset)', () => {
  const c = new Hlc('devA', { now: () => 1000 })
  c.tick(); c.tick(); c.tick() // (1000, 2)
  const got = c.receive(stamp(500, 99, 'devB'))
  assert.equal(got.physical, 1000)
  assert.equal(got.logical, 3)
  assert.equal(cmpHlc(got, stamp(1000, 2, 'devA')), 1)
})

test('hlc: equal physical/logical tie-breaks on nodeId deterministically', () => {
  assert.equal(cmpHlc(stamp(100, 0, 'a'), stamp(100, 0, 'b')), -1)
  assert.equal(cmpHlc(stamp(100, 0, 'b'), stamp(100, 0, 'a')), 1)
  assert.equal(cmpHlc(stamp(100, 0, 'a'), stamp(100, 0, 'a')), 0)
  assert.equal(hlcMax(stamp(100, 0, 'b'), stamp(100, 0, 'a')).nodeId, 'b')
})

test('hlc: restore adopts a future-dated snapshot without going backwards (crash rule)', () => {
  const c = new Hlc('devA', { now: () => 1000 })
  c.restore({ physical: 9000, logical: 7 })
  const s = c.tick()
  assert.equal(s.physical, 9000)
  assert.equal(cmpHlc(s, stamp(9000, 7, 'devA')), 1, 'next event must be strictly newer than the saved stamp')
})

test('hlc: restore of a stale snapshot is ignored', () => {
  const c = new Hlc('devA', { now: () => 5000 })
  c.restore({ physical: 100, logical: 99 })
  const s = c.tick()
  assert.equal(s.physical, 5000)
  assert.equal(s.logical, 0)
})

test('hlc: revisionIdFrom preserves total order lexicographically', () => {
  const lo = revisionIdFrom(stamp(1000, 2, 'devA'))
  const hi = revisionIdFrom(stamp(1001, 0, 'devA'))
  const tie = revisionIdFrom(stamp(1000, 2, 'devB'))
  assert.ok(lo < hi)
  assert.ok(lo < tie)
})

test('hlc: requires a non-empty nodeId', () => {
  assert.throws(() => new Hlc(''))
  assert.throws(() => new Hlc(null))
})

test('hlc: long offline catch-up — 1000 receives while frozen still stay monotone', () => {
  const a = new Hlc('devA', { now: () => 1000 })
  const b = new Hlc('devB', { now: () => 1000 })
  let prev = b.tick()
  for (let i = 0; i < 1000; i++) {
    const next = b.receive(a.tick())
    assert.equal(cmpHlc(prev, next), -1, `iteration ${i}`)
    prev = next
  }
})
