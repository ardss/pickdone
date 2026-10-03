/** C1+C9 (2026-10-02) — phase-claims lease + phase whitelist.
 *
 * C1: a renderer crash between claim and release used to block that completion phase FOREVER
 * (the claims Map had no expiry). Every claim is now a time-boxed LEASE that auto-expires.
 * C9: arbitrary phase strings used to grow the Map unboundedly. Only the exact shapes the
 * single claimPhase funnel produces ('startTomatoTime:<ms>' / 'startRestTime:<ms>') are
 * accepted; everything else is rejected {won:false} and never enters the Map.
 *
 * Run: node --test tests/unit/main/phase-claims-lease.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createPhaseClaims, CLAIM_TTL_MS } = require('../../../src/main/phase-claims.js')

/** Factory with an injectable fake clock. */
function withClock () {
  let t = 1_000_000
  const c = createPhaseClaims({ now: () => t })
  return { c, advance: ms => { t += ms } }
}

test('C1: a claim lease auto-expires — a crashed owner no longer blocks the phase forever', () => {
  const { c, advance } = withClock()
  const first = c.claim('startTomatoTime:111')
  assert.equal(first.won, true)
  // within the lease window the CAS still holds (a live owner is protected)
  advance(CLAIM_TTL_MS - 1000)
  assert.equal(c.claim('startTomatoTime:111').won, false, 'live lease still excludes contenders')
  assert.equal(c.isClaimed('startTomatoTime:111'), true)
  // past the TTL the lease is gone: a new claimer wins (crash self-heal)
  advance(2000)
  assert.equal(c.isClaimed('startTomatoTime:111'), false, 'expired lease reads as not-claimed')
  const second = c.claim('startTomatoTime:111')
  assert.equal(second.won, true, 'red before the fix: the stuck claim blocked completion forever')
  assert.notEqual(second.token, first.token)
})

test('C1: release after expiry is a harmless false; owner release within the window is unchanged', () => {
  const { c, advance } = withClock()
  const { token } = c.claim('startRestTime:222')
  assert.equal(c.release('startRestTime:222', token), true, 'owner release inside the window works')
  const { token: t2 } = c.claim('startRestTime:223')
  advance(CLAIM_TTL_MS + 1)
  assert.equal(c.release('startRestTime:223', t2), false, 'expired lease: release reports false (already gone)')
  assert.equal(c.isClaimed('startRestTime:223'), false)
})

test('C9: non-legitimate phase shapes are rejected and never enter the Map (unbounded-growth fix)', () => {
  const { c } = withClock()
  for (const bad of ['junk', 'singleton:1', 'startTomatoTime', 'startTomatoTime:', 'startTomatoTime:abc',
    'startTomatoTime:1:2', 'startRestTime:nan', 'startFooTime:123', '', null, 42]) {
    assert.equal(c.claim(bad).won, false, `rejected: ${String(bad)}`)
    assert.equal(c.isClaimed(bad), false)
  }
  // exactly the two renderer funnel shapes win
  assert.equal(c.claim('startTomatoTime:1700000000000').won, true)
  assert.equal(c.claim('startRestTime:1700000000001').won, true)
})

test('C9: a rejected shape cannot be used to release or squat on a live lease', () => {
  const { c } = withClock()
  const { token } = c.claim('startTomatoTime:555')
  assert.equal(c.claim('startTomatoTime:555').won, false)
  assert.equal(c.release('junk', token), false)
  assert.equal(c.isClaimed('startTomatoTime:555'), true, 'live lease untouched by rejected shapes')
})
