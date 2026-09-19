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
      if (msg.type === 'segments-chunk') {
        serverIngested.push(...msg.segments)
        socket._lanSend({ type: 'ack', applied: msg.segments.length, rejected: 0 })
      }
      // (the legacy whole-snapshot reply shape was removed — both sides ship the chunked
      // snapshot-request protocol; nothing sends `type:'snapshot'` anymore)
    },
  })
  // Reject on 'error' too: awaiting the bare 'listening' event on a failed bind (e.g. a CI-only
  // EACCES/EADDRNOTAVAIL) used to hang the suite forever with no failure named.
  await new Promise((resolve, reject) => {
    serverNode.once('listening', resolve)
    serverNode.once('error', reject)
  })

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

test('watermark: ack stays in the SENDER seq space even when the receiver oplog runs far ahead (relay overshoot)', async () => {
  // Regression (2026-09-18, P1): the receiver acked its OWN local max oplog seq, but the sender
  // feeds appliedToSeq into buildSegments(fromSeq) against the SENDER's oplog. A receiver that
  // relayed another peer's high-seq rows (>=3 devices) pushed the sender's cursor past its own
  // fresh rows — they were skipped EVERY round, permanently (watermark persisted).
  const rowsA = [
    { id: 'a1', seq: 1 },
    { id: 'a2', seq: 2 },
    { id: 'a3', seq: 3 },
  ]
  const pushedToA = []
  const ingestedByB = []
  const nodeA = createLanSyncNode({
    deviceId: 'node-a',
    pairingSecret: SECRET,
    port: 0,
    host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: () => {},
    ingestSnapshot: () => {},
    buildSegments: (since = 0) => {
      const rows = rowsA.filter(r => r.seq > (Number(since) || 0))
      pushedToA.push(rows.map(r => r.seq))
      if (!rows.length) return []
      return [{ fromSeq: rows[0].seq, toSeq: rows[rows.length - 1].seq, deviceId: 'node-a', rows }]
    },
  })
  const nodeB = createLanSyncNode({
    deviceId: 'node-b',
    pairingSecret: SECRET,
    port: 0,
    host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    // B's local oplog is FAR ahead (it relayed peer C's rows up to seq 1000).
    getMaxSeq: () => 1000,
    ingestSegment: (seg) => ingestedByB.push(seg),
    ingestSnapshot: () => {},
    buildSegments: () => [],
  })

  nodeA.start()
  nodeB.start()
  const [, portB] = await Promise.all([nodeA.whenListening(), nodeB.whenListening()])
  nodeA.addPeer({ deviceId: 'node-b', host: '127.0.0.1', port: portB, name: 'Node B' })

  await nodeA.startSyncRound()
  assert.equal(ingestedByB.length, 1)
  // The ack must report 3 (max seq among A's delivered rows), NEVER 1000 (B's local max).
  assert.equal(nodeA.getStatus().peers[0].watermark, 3, 'watermark = sender-space seq of applied rows')

  await nodeA.startSyncRound()
  assert.deepEqual(pushedToA, [[1, 2, 3], []], 'no overshoot: round 2 re-ships nothing')

  rowsA.push({ id: 'a4', seq: 4 })
  await nodeA.startSyncRound()
  assert.deepEqual(pushedToA, [[1, 2, 3], [], [4]], 'fresh sender rows are never skipped by an overshot cursor')

  await nodeA.stop()
  await nodeB.stop()
})

test('watermark: 3-node chain A -> B -> C, B relays — A cursor never overshoots and C converges', async () => {
  // B's oplog already holds rows relayed from C (in B's OWN seq space: real relaying re-captures
  // through B's oplog). A then joins with low seqs; the old receiver-local-max ack would report
  // B's oplog max and overshoot A's cursor.
  const rowsA = [
    { id: 'a1', seq: 1 },
    { id: 'a2', seq: 2 },
  ]
  let bSeq = 99 // B's own oplog assigns fresh seqs to everything it ingests
  const bRows = [{ id: 'c1', seq: bSeq }] // already relayed from C
  const receivedByC = [] // row ids
  const pushedToA = []

  const nodeA = createLanSyncNode({
    deviceId: 'node-a',
    pairingSecret: SECRET,
    port: 0,
    host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: () => {},
    ingestSnapshot: () => {},
    buildSegments: (since = 0) => {
      const rows = rowsA.filter(r => r.seq > (Number(since) || 0))
      pushedToA.push(rows.map(r => r.seq))
      if (!rows.length) return []
      return [{ fromSeq: rows[0].seq, toSeq: rows[rows.length - 1].seq, deviceId: 'node-a', rows }]
    },
  })
  const nodeB = createLanSyncNode({
    deviceId: 'node-b',
    pairingSecret: SECRET,
    port: 0,
    host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    getMaxSeq: () => bRows.reduce((m, r) => Math.max(m, r.seq), 0),
    getOldestSeq: () => 1,
    ingestSegment: (seg) => {
      // Re-capture into B's oplog: new B-space seq per row (real engine behavior).
      const fresh = []
      for (const r of seg.rows || []) {
        if (bRows.some(x => x.id === r.id)) continue
        const row = { id: r.id, seq: ++bSeq }
        bRows.push(row)
        fresh.push(row)
      }
      return { applied: fresh.length, rejected: 0 }
    },
    ingestSnapshot: () => {},
    buildSegments: (since = 0) => {
      const rows = bRows.filter(r => r.seq > (Number(since) || 0))
      if (!rows.length) return []
      return [{ fromSeq: rows[0].seq, toSeq: rows[rows.length - 1].seq, deviceId: 'node-b', rows }]
    },
  })
  const nodeC = createLanSyncNode({
    deviceId: 'node-c',
    pairingSecret: SECRET,
    port: 0,
    host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    getMaxSeq: () => 500,
    ingestSegment: (seg) => {
      for (const r of seg.rows || []) receivedByC.push(r.id)
      return { applied: (seg.rows || []).length, rejected: 0 }
    },
    ingestSnapshot: () => {},
    buildSegments: () => [],
  })

  nodeA.start()
  nodeB.start()
  nodeC.start()
  const [, portB, portC] = await Promise.all([nodeA.whenListening(), nodeB.whenListening(), nodeC.whenListening()])
  nodeA.addPeer({ deviceId: 'node-b', host: '127.0.0.1', port: portB, name: 'Node B' })
  nodeB.addPeer({ deviceId: 'node-c', host: '127.0.0.1', port: portC, name: 'Node C' })

  // B relays its backlog (C's earlier rows) to C.
  await nodeB.startSyncRound()
  assert.ok(receivedByC.includes('c1'), "C got B's relayed backlog")

  // A joins: pushes seq 1..2 to B; B's ack must stay in A's space (2), not jump to B's own max.
  await nodeA.startSyncRound()
  assert.equal(nodeA.getStatus().peers[0].watermark, 2, "A's cursor advanced to exactly its own max seq")

  // B relays A's rows to C.
  await nodeB.startSyncRound()
  assert.ok(receivedByC.includes('a1') && receivedByC.includes('a2'), 'C received the relayed A rows')

  // A's fresh row: the next round ships exactly the delta — no overshoot hole, no full re-push.
  rowsA.push({ id: 'a3', seq: 3 })
  await nodeA.startSyncRound()
  await nodeB.startSyncRound()
  assert.deepEqual(pushedToA, [[1, 2], [3]], "A's push history never overshoots its own oplog")
  assert.ok(receivedByC.includes('a3'), 'the fresh row reached C through the chain')

  await nodeA.stop()
  await nodeB.stop()
  await nodeC.stop()
})

test('glue: attachment pull rides the encrypted round via the raw socket (regression 2026-09-19)', async () => {
  // Regression: the puller used to be wired `send: (m) => sendVia(client, m)` where `client`
  // is the transport EventEmitter — sendVia dispatches through socket._lanSend, which lives on
  // the RAW SOCKET (em._socket). Every att-req then threw and failed the WHOLE sync round, so
  // any missing attachment blocked all syncing until the file appeared. The round must now
  // confirm AND deliver the file.
  const fileBytes = Buffer.from('attachment payload for the drill'.repeat(8))
  const shaHex = (() => { const h = require('node:crypto').createHash('sha256'); h.update(fileBytes); return h.digest('hex') })()
  const senderFiles = { 'pic.png': fileBytes }
  const serverReqs = []
  const writtenOnA = []

  const nodeA = createLanSyncNode({
    deviceId: 'att-client',
    pairingSecret: SECRET,
    port: 0,
    host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: () => ({ applied: 0, rejected: 0 }),
    ingestSnapshot: () => {},
    buildSegments: () => [],
    getMissingAttachmentKeys: () => ['pic.png'],
    attachmentPullerDeps: {
      exists: key => writtenOnA.some(w => w.key === key),
      size: key => (writtenOnA.find(w => w.key === key) || {}).buf ? writtenOnA.find(w => w.key === key).buf.length : 0,
      read: () => Buffer.alloc(0),
      writeAtomic: (key, buf) => { writtenOnA.push({ key, buf }); return true },
      hashFn: buf => { const h = require('node:crypto').createHash('sha256'); h.update(buf); return h.digest('hex') },
    },
  })
  const nodeB = createLanSyncNode({
    deviceId: 'att-server',
    pairingSecret: SECRET,
    port: 0,
    host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: () => ({ applied: 0, rejected: 0 }),
    ingestSnapshot: () => {},
    buildSegments: () => [],
    attachmentServerDeps: {
      exists: key => key in senderFiles,
      size: key => (senderFiles[key] || Buffer.alloc(0)).length,
      read: (key, start, end) => (senderFiles[key] || Buffer.alloc(0)).slice(start, end + 1),
    },
  })
  // Observe the inbound att-req on the server role (its handler receives the raw socket).
  const origB = nodeB
  void origB

  nodeA.start(); nodeB.start()
  const [, portB] = await Promise.all([nodeA.whenListening(), nodeB.whenListening()])
  nodeA.addPeer({ deviceId: 'att-server', host: '127.0.0.1', port: portB })

  await nodeA.startSyncRound()

  const status = nodeA.getStatus()
  assert.equal(status.lastError, null, 'the round must confirm even though an attachment pull happened')
  assert.ok(status.lastRoundAt, 'round completed')
  assert.equal(writtenOnA.length, 1, 'the attachment file was pulled and written')
  assert.equal(writtenOnA[0].key, 'pic.png')
  const h = require('node:crypto').createHash('sha256'); h.update(writtenOnA[0].buf)
  assert.equal(h.digest('hex'), shaHex, 'pulled bytes match the source hash')

  await nodeA.stop(); void serverReqs
  await nodeB.stop()
})

test('glue: a missing-on-peer attachment must NOT fail the sync round (round isolation)', async () => {
  // The peer has NEITHER the metadata-declared file nor a copy: it answers att-missing and the
  // round must still confirm cleanly (pull cursor / lastRoundAt advance, no round error).
  const nodeA = createLanSyncNode({
    deviceId: 'att-miss-client',
    pairingSecret: SECRET,
    port: 0,
    host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: () => ({ applied: 0, rejected: 0 }),
    ingestSnapshot: () => {},
    buildSegments: () => [],
    getMissingAttachmentKeys: () => ['gone.bin'],
    attachmentPullerDeps: {
      exists: () => false, size: () => 0, read: () => Buffer.alloc(0), writeAtomic: () => true,
    },
  })
  const nodeB = createLanSyncNode({
    deviceId: 'att-miss-server',
    pairingSecret: SECRET,
    port: 0,
    host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: () => ({ applied: 0, rejected: 0 }),
    ingestSnapshot: () => {},
    buildSegments: () => [],
    attachmentServerDeps: { exists: () => false, size: () => 0, read: () => Buffer.alloc(0) },
  })
  nodeA.start(); nodeB.start()
  const [, portB] = await Promise.all([nodeA.whenListening(), nodeB.whenListening()])
  nodeA.addPeer({ deviceId: 'att-miss-server', host: '127.0.0.1', port: portB })

  await nodeA.startSyncRound()

  const status = nodeA.getStatus()
  assert.equal(status.lastError, null, 'a missing attachment must not poison the round')
  assert.ok(status.lastRoundAt, 'round confirmed despite the missing attachment')

  await nodeA.stop()
  await nodeB.stop()
})
