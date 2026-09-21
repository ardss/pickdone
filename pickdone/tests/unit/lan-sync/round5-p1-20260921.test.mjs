/* QC Round-5 P1 regression tests (2026-09-21, fix/round5-p0):
 *   F2a Dial-target validation joins the dial-failure budget: an invalid host/port on a persisted
 *       peer used to emit round-error WITHOUT touching failStreakBy/dialNotBefore/scheduleRetry,
 *       so the periodic trigger re-fired the same doomed round every tick with a fresh error
 *       fan-out — forever. Now the failure counts, hibernate applies, and the budget window
 *       suppresses re-firing.
 *   F2b Manual peer entry (syncAddPeer) is gated by discovery.isPlausibleHost: the old loose
 *       /^[.:\w-]+$/ accepted undialable junk ("...", "a..b", link-local IPs).
 *   F3  Transport confirmTimer cleanup on early socket close (see transport.js).
 *
 * Run: node --test tests/unit/lan-sync/round5-p1-20260921.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')
const { isPlausibleHost } = require('../../../src/main/lan-sync/discovery.js')

const sleep = ms => new Promise(r => setTimeout(r, ms))

function makeNode (over = {}) {
  return createLanSyncNode({
    deviceId: 'self-r5', pairingSecret: 's3cret', port: 0, host: '127.0.0.1',
    discoverFn: { startAdvertising () {}, discover () {}, stop () {}, getPeers: () => [] },
    ingestSegment: () => ({ applied: 0 }),
    ingestSnapshot: () => {},
    buildSegments: () => [],
    ...over,
  })
}

test('F2a: an invalid persisted peer counts toward the dial budget — no per-round error fan-out', async () => {
  const errors = []
  const node = makeNode()
  node.on('round-error', (e) => errors.push(e))

  // "..." passes nothing sane: a persisted/corrupt announce target that can never dial.
  node.addPeer({ deviceId: 'peer-bad', host: '...', port: 58471 })
  const r1 = await node.startSyncRound()
  assert.equal(r1.confirmed, 0, 'the bad-target round fails')
  assert.equal(errors.length, 1, 'exactly one round-error surfaced (within budget)')

  // Immediately re-run the periodic round: dialNotBefore (armed by scheduleRetry) must keep the
  // peer in its backoff window — pre-fix, this re-fired round-error every round forever.
  const r2 = await node.startSyncRound()
  assert.equal(r2.confirmed, 0)
  assert.equal(errors.length, 1, 'no re-fire while the dial-budget window is open')

  await sleep(30)
  await node.stop()
})

test('F2a: the failure streak accumulates and hibernates (broadcast suppressed past the budget)', async () => {
  const errors = []
  const node = makeNode({ dialFailureBudget: 2, backoffBaseMs: 5, backoffMaxMs: 10, hibernateBackoffMs: 500 })
  node.on('round-error', (e) => errors.push(e))

  node.addPeer({ deviceId: 'peer-bad2', host: '...', port: 58471 })
  // Round 1 fails through the validator (streak 1). Rounds 2..n only run after the (5-10ms)
  // backoff window opens; each re-fire of the doomed target still counts the streak.
  await node.startSyncRound()
  await sleep(20)
  await node.startSyncRound()
  await sleep(20)
  await node.startSyncRound()
  assert.ok(errors.length <= 2,
    `broadcast suppressed once hibernating (got ${errors.length} errors, budget 2)`)
  // Device Center observes the hibernating state:
  const status = node.getStatus()
  const entry = status.peers.find(p => p.deviceId === 'peer-bad2')
  assert.ok(entry, 'the peer is listed')
  assert.equal(entry.peerState, 'hibernating', 'the bad peer reaches hibernate (was: permanent per-round errors)')
  await node.stop()
})

test('F2b: isPlausibleHost rejects undialable junk and accepts real targets', () => {
  assert.equal(isPlausibleHost('...'), false, 'dot junk rejected')
  assert.equal(isPlausibleHost('a..b'), false, 'empty label rejected')
  assert.equal(isPlausibleHost('-'), false, 'bare dash rejected')
  assert.equal(isPlausibleHost(''), false, 'empty rejected')
  assert.equal(isPlausibleHost('169.254.1.2'), false, 'link-local IPv4 rejected')
  assert.equal(isPlausibleHost('fe80::1'), false, 'scope-less link-local IPv6 rejected')
  assert.equal(isPlausibleHost('192.168.1.20'), true, 'plain IPv4 accepted')
  assert.equal(isPlausibleHost('my-nas.local'), true, 'hostname accepted')
  assert.equal(isPlausibleHost('MyServer'), true, 'single-label hostname accepted')
  assert.equal(isPlausibleHost('fd00::5'), true, 'global IPv6 accepted')
})
