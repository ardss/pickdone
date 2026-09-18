/**
 * Self-dial regression tests (2026-09-18 real-machine incident): two packaged beta.14
 * machines with MATCHING pairing secrets mutually logged "auth rejected by peer" while each
 * server's rejection log named the RECEIVER's OWN deviceId. Root cause: manual peer entries
 * whose host routes back to the node itself (multi-homed machines, stale DHCP IPs) make the
 * node dial ITSELF; its hello carries its own deviceId, and the server's self-guard
 * (transport.js `claimed === deviceId`) rejects — forever, with reconnect backoff.
 *
 * Covered:
 *   1. Baseline: two nodes, DIFFERENT deviceIds, PRE-PERSISTED shared secret (no fresh
 *      pairing), manual peers pointing at each other -> rounds authenticate and confirm.
 *   2. A manual peer entry whose host:port is the node's OWN server: the round must fail
 *      with a distinct 'self-connection' reason and the bogus peer entry must be REMOVED
 *      (no endless retry loop). Before the fix this retried forever with a generic
 *      'auth rejected by peer'.
 *   3. addPeer proactively refuses a peer whose host is one of the node's own
 *      non-loopback addresses (injectable via opts.ownHosts — the real-machine case of a
 *      second NIC IP landing in the manual peer list).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')

const SECRET = 'self-dial-shared-secret'

const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)))

const fakeDiscovery = () => ({ startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] })

function makeNode(deviceId, extra = {}) {
  return createLanSyncNode({
    deviceId,
    name: deviceId,
    pairingSecret: SECRET,
    port: 0,
    host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: () => ({ applied: 0 }),
    buildSegments: () => [{ fromSeq: 1, toSeq: 1, deviceId, rows: [{ id: 'r1', seq: 1 }] }],
    ...extra,
  })
}

async function start(node) {
  node.start()
  await node.whenListening()
  return node.getStatus().port
}

test('self-dial: two pre-persisted peers with different deviceIds and one shared secret authenticate', async () => {
  const a = makeNode('device-a')
  const b = makeNode('device-b')
  try {
    const portA = await start(a)
    const portB = await start(b)
    // Pre-persisted topology: manual entries keyed by host:port, NOT fresh pairing.
    a.addPeer({ deviceId: 'manual-b', host: '127.0.0.1', port: portB })
    b.addPeer({ deviceId: 'manual-a', host: '127.0.0.1', port: portA })
    const ra = await a.startSyncRound()
    const rb = await b.startSyncRound()
    assert.equal(ra.confirmed, 1, 'A authenticates against B with the shared secret')
    assert.equal(rb.confirmed, 1, 'B authenticates against A with the shared secret')
  } finally {
    await a.stop()
    await b.stop()
  }
})

test('self-dial: a manual peer pointing at our own server is rejected as self-connection and removed', async () => {
  const a = makeNode('device-a')
  try {
    const portA = await start(a)
    const errors = []
    a.on('round-error', (info) => errors.push(String(info.error)))
    // The real-machine topology: a stale manual entry whose host routes back to ourselves.
    a.addPeer({ deviceId: 'manual-127.0.0.1:' + portA, host: '127.0.0.1', port: portA })
    const r = await a.startSyncRound()
    assert.equal(r.confirmed, 0, 'a self-dialing round must not confirm')
    assert.ok(
      errors.some((e) => e.includes('self-connection')),
      'round must fail with the distinct self-connection reason, got: ' + errors.join('; ')
    )
    await settle()
    // The bogus entry must be gone: no endless retry loop against ourselves.
    const ids = a.getStatus().peers.map((p) => p.deviceId)
    assert.ok(!ids.includes('manual-127.0.0.1:' + portA), 'self-referential peer entry must be removed, still present: ' + ids.join(','))
  } finally {
    await a.stop()
  }
})

test('self-dial: addPeer refuses a peer whose host is one of our own non-loopback addresses', async () => {
  const a = makeNode('device-a', { ownHosts: ['192.168.31.31', '192.168.31.232'] })
  try {
    await start(a)
    const stored = a.addPeer({ deviceId: 'manual-own-ip', host: '192.168.31.31', port: 58471 })
    assert.equal(stored, undefined, 'a peer entry pointing at our own address must be refused')
    assert.ok(!a.getStatus().peers.some((p) => p.deviceId === 'manual-own-ip'), 'own-address peer must not enter the peer table')
  } finally {
    await a.stop()
  }
})
