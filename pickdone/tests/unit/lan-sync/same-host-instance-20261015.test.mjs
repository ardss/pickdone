/**
 * Same-host multi-instance regression (2026-10-15 two-instance walkthrough): with
 * TODO_SYNC_PORT per-instance debugging, discovery advertises BOTH instances under the same
 * LAN IP. The self-dial guard (ownHosts) blanket-dropped any peer on our own address, so a
 * same-machine peer stayed invisible to rememberPeer even after a half-successful pairing
 * handshake: discovery listed it, syncGetStatus.discovered showed it, but the peers map never
 * admitted it — sync never ran, nothing errored.
 *
 * Covered:
 *   1. TODO_SYNC_PORT set + peer on our own host but a DIFFERENT port → admitted (both sides
 *      authenticate and confirm a round — the full same-host debug topology works).
 *   2. No TODO_SYNC_PORT (production posture) → own-address peer still refused (the 2026-09-18
 *      stale-DHCP protection is unchanged).
 *   3. TODO_SYNC_PORT set but the peer's port equals OUR listen port → still refused (true
 *      self-dial stays blocked even in debug mode).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')

const SECRET = 'same-host-shared-secret'
// Own address must come from a live local interface: a hardcoded dev-LAN IP dialed into the
// void on every other network (CI runners included) and only passed on the author's machine
const OWN = (Object.values(os.networkInterfaces()).flat().find((i) => i && !i.internal && i.family === 'IPv4') || {}).address || '127.0.0.1'

const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)))
const fakeDiscovery = () => ({ startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] })

function makeNode (deviceId, extra = {}) {
  return createLanSyncNode({
    deviceId,
    name: deviceId,
    pairingSecret: SECRET,
    port: 0,
    host: '0.0.0.0', // dialable via the OWN LAN IP the guard exception admits
    discoverFn: fakeDiscovery(),
    ingestSegment: () => ({ applied: 0 }),
    buildSegments: () => [{ fromSeq: 1, toSeq: 1, deviceId, rows: [{ id: 'r1', seq: 1 }] }],
    ownHosts: [OWN],
    ...extra,
  })
}

async function start (node) {
  node.start()
  await node.whenListening()
  return node.getStatus().port
}

test('same-host instances (TODO_SYNC_PORT, different port) are admitted and sync', async () => {
  process.env.TODO_SYNC_PORT = '59999'
  const a = makeNode('device-a')
  const b = makeNode('device-b')
  try {
    const portA = await start(a)
    const portB = await start(b)
    assert.notEqual(portA, portB)
    // discovery hands both sides entries on the SAME own-host IP with the OTHER's port
    a.addPeer({ deviceId: 'peer-b', host: OWN, port: portB })
    b.addPeer({ deviceId: 'peer-a', host: OWN, port: portA })
    assert.ok(a.getStatus().peers.some((p) => p.deviceId === 'peer-b'), 'same-host different-port peer must enter the peers map')
    const ra = await a.startSyncRound()
    assert.equal(ra.confirmed, 1, 'A authenticates and confirms against same-host B')
    const rb = await b.startSyncRound()
    assert.equal(rb.confirmed, 1, 'B authenticates and confirms against same-host A')
  } finally {
    delete process.env.TODO_SYNC_PORT
    await a.stop()
    await b.stop()
  }
})

test('without TODO_SYNC_PORT an own-address peer is still refused (stale-DHCP protection intact)', async () => {
  delete process.env.TODO_SYNC_PORT
  const a = makeNode('device-a')
  try {
    await start(a)
    a.addPeer({ deviceId: 'manual-own-ip', host: OWN, port: 58471 })
    await settle()
    assert.ok(!a.getStatus().peers.some((p) => p.deviceId === 'manual-own-ip'), 'own-address peer must not enter the peers map')
  } finally {
    await a.stop()
  }
})

test('TODO_SYNC_PORT set but peer port equals our listen port → true self-dial still refused', async () => {
  process.env.TODO_SYNC_PORT = '59998'
  const a = makeNode('device-a')
  try {
    const portA = await start(a)
    a.addPeer({ deviceId: 'self-clone', host: OWN, port: portA })
    await settle()
    assert.ok(!a.getStatus().peers.some((p) => p.deviceId === 'self-clone'), 'same-port own-address peer must not enter the peers map')
  } finally {
    delete process.env.TODO_SYNC_PORT
    await a.stop()
  }
})
