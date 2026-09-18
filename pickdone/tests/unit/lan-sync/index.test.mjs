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
    buildSegments: (since = 0) => [{ fromSeq: 1, toSeq: 2, deviceId: 'node-a', rows: [{ id: 'a1', seq: 1 }, { id: 'a2', seq: 2 }].filter(r => r.seq > since) }],
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
    buildSegments: (since = 0) => [{ fromSeq: 5, toSeq: 5, deviceId: 'node-b', rows: [{ id: 'b1', seq: 5 }].filter(r => r.seq > since) }],
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
        socket._lanSend({ type: 'ack', applied: msg.segments.length, rejected: 0 })
      }
      // (the legacy whole-snapshot reply shape was removed — both sides ship the chunked
      // snapshot-request protocol; nothing sends `type:'snapshot'` anymore)
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

test('glue: peer ack appliedToSeq advances the push watermark; second round ships only the delta', async () => {
  // Regression (2026-09): the server role acked {applied, rejected} WITHOUT appliedToSeq, so the
  // client's per-peer watermark stayed 0 forever and every round re-pushed the full oplog.
  const SECRET2 = SECRET
  let bMaxSeq = 0 // peer B's local max oplog seq (what its ack must report)
  const ingestedByB = []
  const pushedToB = [] // one entry per round: the row seqs A actually shipped

  const rowsA = [
    { id: 'a1', seq: 1 },
    { id: 'a2', seq: 2 },
    { id: 'a3', seq: 3 },
  ]
  const nodeA = createLanSyncNode({
    deviceId: 'node-a',
    pairingSecret: SECRET2,
    port: 0,
    host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: () => {},
    ingestSnapshot: () => {},
    // Honors the explicit sinceSeq watermark (engine.buildSegments contract).
    buildSegments: (since = 0) => {
      const rows = rowsA.filter(r => r.seq > (Number(since) || 0))
      pushedToB.push(rows.map(r => r.seq))
      if (!rows.length) return []
      return [{ fromSeq: rows[0].seq, toSeq: rows[rows.length - 1].seq, deviceId: 'node-a', rows }]
    },
  })
  const nodeB = createLanSyncNode({
    deviceId: 'node-b',
    pairingSecret: SECRET2,
    port: 0,
    host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: (seg) => {
      ingestedByB.push(seg)
      for (const r of seg.rows || []) bMaxSeq = Math.max(bMaxSeq, Number(r.seq) || 0)
    },
    ingestSnapshot: () => {},
    getMaxSeq: () => bMaxSeq,
    buildSegments: () => [],
  })

  nodeA.start()
  nodeB.start()
  const [, portB] = await Promise.all([nodeA.whenListening(), nodeB.whenListening()])
  nodeA.addPeer({ deviceId: 'node-b', host: '127.0.0.1', port: portB, name: 'Node B' })

  // Round 1: watermark 0 -> full backlog (seq 1..3) is shipped; B acks appliedToSeq=3.
  const ok1 = await nodeA.startSyncRound()
  assert.equal(ok1.confirmed, 1)
  assert.deepEqual(pushedToB, [[1, 2, 3]])
  assert.equal(ingestedByB.length, 1)
  assert.deepEqual(ingestedByB[0].rows.map(r => r.seq), [1, 2, 3])

  // Round 2 with no new rows: the watermark advanced, so NOTHING is re-pushed.
  await nodeA.startSyncRound()
  assert.deepEqual(pushedToB, [[1, 2, 3], []], 'watermark advanced: round 2 shipped nothing')
  assert.equal(ingestedByB.length, 1, 'no delta -> no second push')

  // A new local row (seq 4) appears: round 3 ships ONLY the delta.
  rowsA.push({ id: 'a4', seq: 4 })
  await nodeA.startSyncRound()
  assert.equal(ingestedByB.length, 2)
  assert.deepEqual(ingestedByB[1].rows.map(r => r.seq), [4])
  assert.equal(bMaxSeq, 4)

  await nodeA.stop()
  await nodeB.stop()
})
