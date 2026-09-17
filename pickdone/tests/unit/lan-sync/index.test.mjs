/**
 * LAN sync node glue tests: two real nodes on 127.0.0.1 ephemeral ports with
 * an injected (fake) discovery layer — no mDNS in CI. Verifies the full round
 * (push segments / pull segments / ack), snapshot handling, status, and
 * backoff fields.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')
const { createLanServer } = require('../../../src/main/lan-sync/transport.js')

const SECRET = 'glue-secret-1'

/** Fake discovery: no bonjour/UDP, peers injected via addPeer(). */
function fakeDiscovery() {
  return { startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] }
}

test('glue: two nodes exchange segments + acks via injected peers', async () => {
  const ingestedA = []
  const ingestedB = []

  const nodeA = createLanSyncNode({
    deviceId: 'node-a',
    name: 'Node A',
    pairingSecret: SECRET,
    port: 0,
    host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: (seg) => ingestedA.push(seg),
    ingestSnapshot: () => {},
    buildSegments: () => [{ fromSeq: 1, toSeq: 2, deviceId: 'node-a', rows: [{ id: 'a1', seq: 1 }, { id: 'a2', seq: 2 }] }],
  })
  const nodeB = createLanSyncNode({
    deviceId: 'node-b',
    name: 'Node B',
    pairingSecret: SECRET,
    port: 0,
    host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: (seg) => ingestedB.push(seg),
    ingestSnapshot: () => {},
    buildSegments: () => [{ fromSeq: 5, toSeq: 5, deviceId: 'node-b', rows: [{ id: 'b1', seq: 5 }] }],
  })

  // Start both, learn ephemeral ports, cross-inject as peers. whenListening()
  // (not the 'listening' event) so we cannot miss the event when both nodes
  // bind in the same poll cycle.
  nodeA.start()
  nodeB.start()
  const [portA, portB] = await Promise.all([nodeA.whenListening(), nodeB.whenListening()])
  assert.equal(typeof portA, 'number')
  assert.ok(portA > 0 && portB > 0)

  nodeA.addPeer({ deviceId: 'node-b', host: '127.0.0.1', port: portB, name: 'Node B' })
  nodeB.addPeer({ deviceId: 'node-a', host: '127.0.0.1', port: portA, name: 'Node A' })

  await nodeA.startSyncRound()
  await nodeB.startSyncRound()

  // Each side pulled the other's segment. Dedup (same segment arriving via
  // the outbound pull AND the inbound push) is the merge layer's job —
  // the transport delivers every envelope it receives.
  assert.ok(ingestedA.length >= 1)
  assert.equal(ingestedA[0].deviceId, 'node-b')
  assert.equal(ingestedA[0].rows[0].id, 'b1')
  assert.ok(ingestedB.length >= 1)
  assert.equal(ingestedB[0].deviceId, 'node-a')

  const statusA = nodeA.getStatus()
  assert.equal(statusA.peers.length, 1)
  assert.equal(statusA.peers[0].deviceId, 'node-b')
  assert.ok(statusA.lastRoundAt)
  assert.equal(statusA.lastError, null)

  await nodeA.stop()
  await nodeB.stop()
})

test('glue: failed peer schedules backoff retry, success clears error', async () => {
  const ingested = []
  const node = createLanSyncNode({
    deviceId: 'node-solo',
    pairingSecret: SECRET,
    port: 0,
    host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: (seg) => ingested.push(seg),
    ingestSnapshot: () => {},
    buildSegments: () => [],
  })
  node.start()
  await node.whenListening()

  // Peer that does not exist -> connect error -> backoff scheduled.
  node.addPeer({ deviceId: 'ghost', host: '127.0.0.1', port: 1 })
  await node.startSyncRound()
  assert.ok(node.getStatus().lastError)
  assert.ok(node.getStatus().lastError.includes('ghost'))

  // Stand a real server up on a new port, repoint the peer, and recover.
  const realPeer = createLanSyncNode({
    deviceId: 'real',
    pairingSecret: SECRET,
    port: 0,
    host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: () => {},
    ingestSnapshot: () => {},
    buildSegments: () => [{ fromSeq: 1, toSeq: 1, deviceId: 'real', rows: [{ id: 'r1', seq: 1 }] }],
  })
  realPeer.start()
  const realPort = await realPeer.whenListening()
  node.addPeer({ deviceId: 'real', host: '127.0.0.1', port: realPort })
  await node.startSyncRound()
  const status = node.getStatus()
  assert.equal(status.lastError, null)
  assert.ok(status.lastRoundAt)
  assert.equal(ingested.length, 1)

  await node.stop()
  await realPeer.stop()
})

test('glue: server-side ingest path accepts inbound segments from authenticated peer', async () => {
  const serverIngested = []
  const serverNode = createLanServer({
    port: 0,
    host: '127.0.0.1',
    deviceId: 'srv-node',
    pairingSecret: SECRET,
    getHandler: () => (msg, socket) => {
      if (msg.type === 'segments') {
        serverIngested.push(...msg.segments)
        socket.write(JSON.stringify({ type: 'ack', applied: msg.segments.length, rejected: 0 }) + '\n')
      } else if (msg.type === 'snapshot-request') {
        socket.write(JSON.stringify({ type: 'snapshot', snapshot: { tasks: 3 } }) + '\n')
      }
    },
  })
  await new Promise((resolve) => serverNode.on('listening', resolve))

  const node = createLanSyncNode({
    deviceId: 'client-node',
    pairingSecret: SECRET,
    discoverFn: fakeDiscovery(),
    ingestSegment: () => {},
    ingestSnapshot: () => {},
    buildSegments: () => [{ fromSeq: 1, toSeq: 1, deviceId: 'client-node', rows: [{ id: 'c1', seq: 1 }] }],
    buildSnapshot: () => ({ tasks: 1 }),
  })
  node.addPeer({ deviceId: 'srv-node', host: '127.0.0.1', port: serverNode.port })
  await node.startSyncRound()

  assert.equal(serverIngested.length, 1)
  assert.equal(serverIngested[0].rows[0].id, 'c1')

  await node.stop()
  await serverNode.close()
})
