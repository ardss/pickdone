import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { createQuitAckTracker } = require('../../../src/main/quit-ack.js')

/* W21 (2026-10-30): abandon() now REFUSES count-form rounds — see quit-ack.js abandon() comment.
 * Both production callers (index.js before-quit, updater.js runFlushRound) open rounds with the
 * exact sender-id array, so the pins below moved from the legacy count form to the id-set form.
 * Count-form refusal itself is pinned in w21-log-isolation-timing.test.mjs. */

test('abandon: window destroyed before ack lets allAcked go true early (H7 P2 regression)', () => {
  const t = createQuitAckTracker()
  const token = t.nextToken()
  t.beginRound([101, 102], token)
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
  t.beginRound([1, 2], token)
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

test('abandon: unknown sender is refused — it cannot eat into expected (W14/W21 gate)', () => {
  const t = createQuitAckTracker()
  const token = t.nextToken()
  t.beginRound([100, 101], token)
  assert.equal(t.abandon(999), false, 'sender outside the expected set cannot decrement')
  assert.equal(t.allAcked(), false, 'both real windows still owe their acks')
  t.ack(token, 100)
  assert.equal(t.allAcked(), false, 'one real window still owes')
  t.ack(token, 101)
  assert.equal(t.allAcked(), true)
})

test('abandon: null sender is tolerated, expected never goes negative', () => {
  const t = createQuitAckTracker()
  const token = t.nextToken()
  t.beginRound([1], token)
  assert.equal(t.abandon(null), false)
  assert.equal(t.allAcked(), false)
  t.ack(token, 1)
  assert.equal(t.allAcked(), true)
})

test('beginRound clears abandoned set from the previous round', () => {
  const t = createQuitAckTracker()
  const t1 = t.nextToken()
  t.beginRound([1], t1)
  t.abandon(1)
  assert.equal(t.allAcked(), true)
  const t2 = t.nextToken()
  t.beginRound([1], t2)
  assert.equal(t.allAcked(), false, 'fresh round expects the window again')
  assert.equal(t.ack(t2, 1), true)
  assert.equal(t.allAcked(), true)
})

test('ack after abandon: late ack from an abandoned sender does not resurrect the round', () => {
  const t = createQuitAckTracker()
  const token = t.nextToken()
  t.beginRound([1], token)
  t.abandon(1)
  assert.equal(t.ack(token, 1), true) // recorded, harmless
  assert.equal(t.allAcked(), true) // already satisfied via abandon
})
