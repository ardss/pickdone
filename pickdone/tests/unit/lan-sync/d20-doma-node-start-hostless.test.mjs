/**
 * D20-DOM-A regressions in lan-sync/index.js:
 *   C5  — start() is idempotent: a second start() must NOT orphan the first listening server
 *         (pre-fix the replacement server left the first port open with nobody to close it).
 *   C15 — a peer with NO dialable host is treated as awaiting-discovery, not failure: the
 *         round sweep skips it instead of billing failStreak toward hibernate every round.
 * Run: node --test tests/unit/lan-sync/d20-doma-node-start-hostless.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')

const SECRET = 'd20-node-secret'

function fakeDiscovery () {
  return { startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] }
}

function probePort (port) {
  return new Promise((resolve) => {
    const s = net.connect(port, '127.0.0.1')
    s.setTimeout(1500)
    s.on('connect', () => { s.destroy(); resolve('open') })
    s.on('error', () => resolve('refused'))
    s.on('timeout', () => { s.destroy(); resolve('timeout') })
  })
}

test('C5: a second start() is a no-op — stop() leaves NO orphaned listening port behind', async () => {
  const node = createLanSyncNode({
    deviceId: 'd20-c5', name: 'C5', pairingSecret: SECRET,
    port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: () => ({}),
    ingestSnapshot: () => {},
    buildSegments: () => [],
  })
  node.start()
  const port1 = await node.whenListening()
  assert.equal(typeof port1, 'number', 'first start bound a port')
  node.start() // pre-fix: created a SECOND server, orphaning the first listening handle
  await new Promise((r) => setTimeout(r, 250))
  await node.stop()
  assert.equal(await probePort(port1), 'refused', 'red before the fix: the first server stayed listening forever (orphaned handle)')
})

test('C15: a host-less peer is skipped as awaiting-discovery — no dial, no failure billing', async () => {
  const node = createLanSyncNode({
    deviceId: 'd20-c15', name: 'C15', pairingSecret: SECRET,
    port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: () => ({}),
    ingestSnapshot: () => {},
    buildSegments: () => [],
  })
  node.start()
  try {
    node.addPeer({ deviceId: 'ghost-peer', name: 'Ghost', port: 58471 }) // NO host: never dialable
    const result = await node.startSyncRound()
    assert.equal(result.peers, 0, 'the host-less peer is not dialed')
    const st = node.getStatus().peers.find((p) => p.deviceId === 'ghost-peer')
    assert.ok(st, 'the peer is still tracked')
    assert.equal(st.peerState, 'ok', 'red before the fix: the failed dial billed failStreak/error state every round')
    assert.equal(st.lastError, null, 'no error recorded for a merely undiscovered peer')
    assert.equal(st.nextDialAt, null, 'no retry window armed')
  } finally {
    await node.stop()
  }
})
