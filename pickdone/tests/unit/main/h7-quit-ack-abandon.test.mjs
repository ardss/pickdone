import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createQuitAckTracker } = require('../../../src/main/quit-ack.js')

test('abandon: window destroyed before ack lets allAcked go true early (H7 P2 regression)', () => {
  const t = createQuitAckTracker()
  const token = t.nextToken()
  t.beginRound(2, token)
  assert.equal(t.allAcked(), false)
  // Window B destroyed between send and ack — never going to ack
  assert.equal(t.abandon(102), true)
  // Remaining window A acks
  assert.equal(t.ack(token, 101), true)
  // Without abandon this would stay false until the 2s cap; now it resolves immediately
  assert.equal(t.allAcked(), true)
})

test('abandon: idempotent and no-op for already-acked senders', () => {
  const t = createQuitAckTracker()
  const token = t.nextToken()
  t.beginRound(2, token)
  t.ack(token, 1)
  // Sender 1 already acked: its ack is what satisfies the round — abandon must not touch expected
  assert.equal(t.abandon(1), false)
  assert.equal(t.abandon(1), false) // repeated abandon of the same sender is a no-op
  t.abandon(2)
  assert.equal(t.abandon(2), false)
  assert.equal(t.allAcked(), true)
  // progress() stays coherent (1 acked / 1 still expected)
  assert.equal(t.progress(), '1/1')
})

test('abandon: does not satisfy the round by itself when a live window has not acked', () => {
  const t = createQuitAckTracker()
  const token = t.nextToken()
  t.beginRound(2, token)
  t.abandon(999) // crashed window
  assert.equal(t.allAcked(), false, 'the surviving live window still owes an ack')
  t.ack(token, 100)
  assert.equal(t.allAcked(), true)
})

test('abandon: stale/foreign sender ids are tolerated, expected never goes negative', () => {
  const t = createQuitAckTracker()
  const token = t.nextToken()
  t.beginRound(1, token)
  assert.equal(t.abandon(null), false)
  t.abandon(7); t.abandon(8); t.abandon(9) // unexpected senders, e.g. windows opened after send
  assert.equal(t.ack(token, 1), true)
  assert.equal(t.allAcked(), true, 'expected clamps at 0')
})

test('beginRound clears abandoned set from the previous round', () => {
  const t = createQuitAckTracker()
  const t1 = t.nextToken()
  t.beginRound(1, t1)
  t.abandon(1)
  assert.equal(t.allAcked(), true)
  const t2 = t.nextToken()
  t.beginRound(1, t2)
  assert.equal(t.allAcked(), false, 'fresh round expects the window again')
  assert.equal(t.ack(t2, 1), true)
  assert.equal(t.allAcked(), true)
})

test('ack after abandon: late ack from an abandoned sender does not resurrect the round', () => {
  const t = createQuitAckTracker()
  const token = t.nextToken()
  t.beginRound(1, token)
  t.abandon(1)
  assert.equal(t.ack(token, 1), true) // recorded, harmless
  assert.equal(t.allAcked(), true) // already satisfied via abandon
})
