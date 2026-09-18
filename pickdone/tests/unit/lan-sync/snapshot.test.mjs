/**
 * Snapshot-request protocol regression tests (2026-09-18): a peer offline longer than the
 * oplog ring window could never converge (the pruned increments are gone forever). The
 * protocol: on a stalled round where the peer's oldest RETAINED seq is past my pull
 * watermark, the next round opens with `snapshot-request`; the peer streams bounded
 * `snapshot-chunk` messages + `snapshot-end {totalRows, cursor}`; the pull watermark
 * advances ONLY on a complete snapshot.
 *
 * Real TCP on 127.0.0.1 ephemeral ports, injected (fake) discovery — no mDNS, no Electron.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')
const { createLanServer } = require('../../../src/main/lan-sync/transport.js')
const { chunkSnapshot, SNAPSHOT_CHUNK_BYTES } = require('../../../src/main/lan-sync/snapshot.js')

const SECRET = 'snapshot-secret-1'

function fakeDiscovery() {
  return { startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] }
}

function line(socket, obj) { socket.write(JSON.stringify(obj) + '\n') }

/** Raw peer server: counts snapshot-requests, scriptable per-request behavior. */
function rawPeerServer({ ack = { appliedToSeq: 100, oldestSeq: 50 }, onRequest, buildSegmentsRows = [] }) {
  const seen = { snapshotRequests: 0, rounds: 0 }
  const server = createLanServer({
    port: 0,
    host: '127.0.0.1',
    deviceId: 'peer',
    pairingSecret: SECRET,
    getHandler: () => (msg, socket) => {
      if (msg.type === 'segments') {
        seen.rounds += 1
        line(socket, { type: 'segments', segments: buildSegmentsRows })
        line(socket, { type: 'ack', applied: msg.segments.length, rejected: 0, ...ack })
      } else if (msg.type === 'snapshot-request') {
        seen.snapshotRequests += 1
        if (onRequest) onRequest(seen.snapshotRequests, socket)
      }
    },
  })
  server.seen = seen
  return server
}

async function listen(server) {
  await new Promise((resolve) => server.on('listening', resolve))
  return server.port
}

function makeNode(extra = {}) {
  return createLanSyncNode({
    deviceId: 'me',
    name: 'Me',
    pairingSecret: SECRET,
    port: 0,
    host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: () => ({ applied: 0, rejected: 0 }),
    ingestSnapshot: () => {},
    buildSegments: () => [],
    ...extra,
  })
}

/* ---------- chunkSnapshot unit ---------- */

test('chunkSnapshot: splits rows into bounded chunks and reports totals', () => {
  const rows = []
  for (let i = 0; i < 500; i++) rows.push({ entity: 'todo', id: 't' + i, updatedAt: i, data: { taskId: 't' + i, pad: 'x'.repeat(4000) } })
  const r = chunkSnapshot({ schemaVersion: 1, rows }, { cursor: 7 })
  assert.equal(r.totalRows, 500)
  assert.equal(r.cursor, 7)
  assert.equal(r.schemaVersion, 1)
  assert.ok(r.chunks.length > 1, '500 x ~4KB rows must exceed one 1MB chunk')
  for (const c of r.chunks) {
    const bytes = Buffer.byteLength(JSON.stringify({ rows: c.rows }), 'utf8')
    assert.ok(bytes <= SNAPSHOT_CHUNK_BYTES, 'every chunk stays under the budget')
  }
  assert.deepEqual(r.chunks.flatMap(c => c.rows).map(x => x.id), rows.map(x => x.id), 'chunks tile all rows in order')
  assert.deepEqual(r.chunks.map(c => c.index), r.chunks.map((_, i) => i))
})

/* ---------- trigger + end-to-end over TCP ---------- */

test('snapshot: stalled round with pruned peer history triggers snapshot-request next round; watermark advances only at snapshot-end', async () => {
  const snapRows = [
    { entity: 'todo', id: 'r1', updatedAt: 5, deleted: false, deletedAt: 0, data: { taskId: 'r1', taskContent: 'from snapshot' } },
    { entity: 'todo', id: 'r2', updatedAt: 6, deleted: true, deletedAt: 6, data: null },
  ]
  const server = rawPeerServer({
    ack: { appliedToSeq: 100, oldestSeq: 50 },
    // request 1: full valid transfer in two chunks; request 2 must never happen
    onRequest: (n, socket) => {
      assert.equal(n, 1, 'exactly one snapshot-request: after success the round is incremental')
      line(socket, { type: 'snapshot-chunk', index: 0, totalChunks: 2, schemaVersion: 1, rows: [snapRows[0]] })
      line(socket, { type: 'snapshot-chunk', index: 1, totalChunks: 2, schemaVersion: 1, rows: [snapRows[1]] })
      line(socket, { type: 'snapshot-end', totalRows: 2, cursor: 100, schemaVersion: 1 })
    },
  })
  const port = await listen(server)

  const appliedSnapshots = []
  const node = makeNode({
    ingestSnapshot: (snap) => { appliedSnapshots.push(snap); return { rows: snap.rows.length } },
  })
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port })

  // Round 1: stalled (applied 0) + oldestSeq(50) > pullWatermark(0)+1 -> trigger arms.
  const r1 = await node.startSyncRound()
  assert.equal(r1.confirmed, 1)
  assert.equal(server.seen.snapshotRequests, 0, 'round 1 is plain incremental: the trigger fires AFTER it')
  assert.equal(appliedSnapshots.length, 0)
  assert.equal(node.getStatus().peers[0].pullWatermark, null)

  // Round 2: opens with snapshot-request; chunks applied; watermark jumps to the sender cursor.
  const snapEvents = []
  node.on('snapshot-sync', (info) => snapEvents.push(info))
  const r2 = await node.startSyncRound()
  assert.equal(r2.confirmed, 1, 'round completes at snapshot-end, not at the ack')
  assert.equal(server.seen.snapshotRequests, 1)
  assert.equal(appliedSnapshots.length, 1)
  assert.equal(appliedSnapshots[0].deviceId, 'peer')
  assert.equal(appliedSnapshots[0].rows.length, 2, 'both chunks assembled in order')
  assert.deepEqual(appliedSnapshots[0].rows.map(x => x.id), ['r1', 'r2'])
  assert.equal(node.getStatus().peers[0].pullWatermark, 100, 'watermark = sender cursor, set only at snapshot-end')
  assert.deepEqual(snapEvents, [{ peer: 'peer', direction: 'received', rows: 2, cursor: 100 }])
  const recvEntry = node.getStatus().recent.find(e => e.kind === 'snapshot')
  assert.ok(recvEntry, 'receiver-side snapshot recorded into the recent ring')

  // Round 3: caught up (watermark == peer max seq) -> plain incremental again, no re-request.
  await node.startSyncRound()
  assert.equal(server.seen.snapshotRequests, 1, 'no snapshot spam once the watermark is current')

  await node.stop()
  await server.close()
})

test('snapshot: sender side streams bounded chunks + end trailer over TCP and never re-serves concurrently', async () => {
  // Big live state: 3000 x ~600B rows = ~1.8MB -> at least 2 chunk messages, each far under 16MB.
  const bigRows = []
  for (let i = 0; i < 3000; i++) bigRows.push({ entity: 'todo', id: 'b' + i, updatedAt: i, deleted: false, deletedAt: 0, data: { taskId: 'b' + i, taskContent: 'row-' + i, pad: 'y'.repeat(500) } })

  const receivedByA = []
  const nodeA = makeNode({
    deviceId: 'node-a',
    ingestSegment: () => ({ applied: 0, rejected: 0 }),
    ingestSnapshot: (snap) => { receivedByA.push(snap); return { rows: snap.rows.length } },
    // nothing progressing from B's side
    buildSegments: () => [],
  })
  const nodeB = makeNode({
    deviceId: 'node-b',
    getMaxSeq: () => 1000,
    getOldestSeq: () => 500,
    ingestSegment: () => ({ applied: 0, rejected: 0 }),
    buildSegments: () => [],
    buildSnapshot: () => JSON.stringify({ schemaVersion: 1, deviceId: 'node-b', rows: bigRows }),
  })
  nodeA.start()
  nodeB.start()
  const [, portB] = await Promise.all([nodeA.whenListening(), nodeB.whenListening()])
  nodeA.addPeer({ deviceId: 'node-b', host: '127.0.0.1', port: portB, name: 'Node B' })

  const sentEvents = []
  nodeB.on('snapshot-sync', (info) => sentEvents.push(info))

  // Round 1: stalled; B advertises oldestSeq=500 > A's pullWatermark(0)+1 -> trigger arms.
  await nodeA.startSyncRound()
  assert.equal(receivedByA.length, 0)
  // Round 2: snapshot flows.
  await nodeA.startSyncRound()
  assert.equal(receivedByA.length, 1)
  assert.equal(receivedByA[0].rows.length, 3000)
  assert.equal(nodeA.getStatus().peers[0].pullWatermark, 1000, 'A records B\'s cursor (max seq) as its pull watermark')

  const sentEntry = nodeB.getStatus().recent.find(e => e.kind === 'snapshot')
  assert.ok(sentEntry && sentEntry.detail.direction === 'sent')
  assert.equal(sentEntry.detail.rows, 3000)
  assert.ok(sentEntry.detail.label.includes('对端请求全量快照'), 'Device Center label present')
  assert.deepEqual(sentEvents, [{ peer: 'node-a', direction: 'sent', rows: 3000, cursor: 1000 }])

  // Round 3: incremental, no second snapshot.
  await nodeA.startSyncRound()
  assert.equal(receivedByA.length, 1)

  await nodeA.stop()
  await nodeB.stop()
})

test('snapshot: partial transfer (socket death before snapshot-end) never advances the watermark and re-requests next round', async () => {
  const appliedSnapshots = []
  const server = rawPeerServer({
    ack: { appliedToSeq: 100, oldestSeq: 50 },
    onRequest: (n, socket) => {
      if (n === 1) {
        line(socket, { type: 'snapshot-chunk', index: 0, totalChunks: 2, schemaVersion: 1, rows: [{ entity: 'todo', id: 'only' }] })
        socket.destroy() // truncated: no chunk 1, no snapshot-end
      } else {
        line(socket, { type: 'snapshot-chunk', index: 0, totalChunks: 1, schemaVersion: 1, rows: [{ entity: 'todo', id: 'full' }] })
        line(socket, { type: 'snapshot-end', totalRows: 1, cursor: 100, schemaVersion: 1 })
      }
    },
  })
  const port = await listen(server)

  const node = makeNode({
    ingestSnapshot: (snap) => { appliedSnapshots.push(snap); return { rows: snap.rows.length } },
  })
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port })

  await node.startSyncRound() // arms the trigger
  const r2 = await node.startSyncRound() // partial transfer: the round FAILS
  assert.equal(r2.confirmed, 0, 'a truncated snapshot fails its round')
  assert.equal(node.getStatus().peers[0].pullWatermark, null, 'watermark NEVER advances on a partial snapshot')

  const r3 = await node.startSyncRound() // re-requests and completes
  assert.equal(r3.confirmed, 1)
  assert.equal(server.seen.snapshotRequests, 2, 'exactly one retry after the failure')
  assert.equal(appliedSnapshots.length, 1, 'the truncated transfer never reached ingestSnapshot as complete')
  assert.equal(node.getStatus().peers[0].pullWatermark, 100)

  await node.stop()
  await server.close()
})

test('snapshot: a progressing peer is never snapshot-requested despite pruned history', async () => {
  const server = rawPeerServer({
    ack: { appliedToSeq: 5000, oldestSeq: 4000 },
    // the peer's segments DO apply: my state is progressing, no snapshot needed
    buildSegmentsRows: [{ fromSeq: 4000, toSeq: 4001, deviceId: 'peer', rows: [{ entity: 'todo', id: 'live', seq: 4000 }, { entity: 'todo', id: 'live2', seq: 4001 }] }],
  })
  const port = await listen(server)

  let appliedSegs = 0
  const node = makeNode({
    ingestSegment: (seg) => { appliedSegs += seg.rows.length; return { applied: seg.rows.length, rejected: 0 } },
  })
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port })

  for (let i = 0; i < 3; i++) {
    const r = await node.startSyncRound()
    assert.equal(r.confirmed, 1)
  }
  assert.equal(appliedSegs, 6, 'increments flowed every round')
  assert.equal(server.seen.snapshotRequests, 0, 'progressing watermark suppresses the snapshot trigger')

  await node.stop()
  await server.close()
})
