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

// Post-auth replies MUST go through the encrypted send path (socket._lanSend is attached
// by transport.js and frames under the session key); raw plaintext writes are refused.
function line(socket, obj) { socket._lanSend(obj) }

// P1-3 (2026-09-19): failed rounds arm a per-peer dial window (startSyncRound respects it),
// so tests dial explicitly via dialRound (forceDial) instead of waiting out the window.
const FAST_DIAL = { dialFailureBudget: 1000, hibernateBackoffMs: 50 }
// Every explicit round goes through forceDial: a FAILED round arms a retry timer + dial window
// (P1-3), which would make the next startSyncRound skip the peer. forceDial = deterministic dial.
async function dialRound (node) { node.forceDial('peer'); return node.startSyncRound() }

/** Raw peer server: counts snapshot-requests, scriptable per-request behavior. */
function rawPeerServer({ ack = { appliedToSeq: 100, oldestSeq: 50 }, onRequest, buildSegmentsRows = [] }) {
  const seen = { snapshotRequests: 0, rounds: 0 }
  const server = createLanServer({
    port: 0,
    host: '127.0.0.1',
    deviceId: 'peer',
    pairingSecret: SECRET,
    getHandler: () => (msg, socket) => {
      if (msg.type === 'segments-chunk') {
        seen.rounds += 1
        line(socket, { type: 'segments-chunk', segments: buildSegmentsRows })
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
      requests.push(n)
      line(socket, { type: 'snapshot-chunk', index: 0, totalChunks: 2, schemaVersion: 1, rows: [snapRows[0]] })
      line(socket, { type: 'snapshot-chunk', index: 1, totalChunks: 2, schemaVersion: 1, rows: [snapRows[1]] })
      line(socket, { type: 'snapshot-end', totalRows: 2, cursor: 100, schemaVersion: 1 })
    },
  })
  const port = await listen(server)

  const appliedSnapshots = []
  const requests = [] // assertion lives OUTSIDE the socket handler (mirrored by server.seen)
  const node = makeNode({
    ingestSnapshot: (snap) => { appliedSnapshots.push(snap); return { rows: snap.rows.length } },
  })
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port })

  // Round 1: stalled (applied 0) + oldestSeq(50) > pullWatermark(0)+1 -> trigger arms.
  const r1 = await dialRound(node)
  assert.equal(r1.confirmed, 1)
  assert.equal(server.seen.snapshotRequests, 0, 'round 1 is plain incremental: the trigger fires AFTER it')
  assert.equal(appliedSnapshots.length, 0)
  assert.equal(node.getStatus().peers[0].pullWatermark, null)

  // Round 2: opens with snapshot-request; chunks applied; watermark jumps to the sender cursor.
  const snapEvents = []
  node.on('snapshot-sync', (info) => snapEvents.push(info))
  const r2 = await dialRound(node)
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
  await dialRound(node)
  assert.equal(server.seen.snapshotRequests, 1, 'no snapshot spam once the watermark is current')
  assert.deepEqual(requests, [1], 'exactly one snapshot-request (mirrors the seen counter)')

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
  // Round-3 review: the snapshot "sent" recent entry carries a locale-neutral STRING detail —
  // the renderer interpolates it verbatim into the Device Center feed.
  assert.ok(typeof sentEntry.detail === 'string', 'detail is a plain string (rendered verbatim)')
  assert.equal(sentEntry.detail, 'snapshot: 3000 rows')
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

  const node = makeNode({ ...FAST_DIAL, ingestSnapshot: (snap) => { appliedSnapshots.push(snap); return { rows: snap.rows.length } } })
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port })

  await dialRound(node) // arms the trigger
  const r2 = await dialRound(node) // partial transfer: the round FAILS
  assert.equal(r2.confirmed, 0, 'a truncated snapshot fails its round')
  assert.equal(node.getStatus().peers[0].pullWatermark, null, 'watermark NEVER advances on a partial snapshot')

  const r3 = await dialRound(node) // re-requests and completes
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
    const r = await dialRound(node)
    assert.equal(r.confirmed, 1)
  }
  assert.equal(appliedSegs, 6, 'increments flowed every round')
  assert.equal(server.seen.snapshotRequests, 0, 'progressing watermark suppresses the snapshot trigger')

  await node.stop()
  await server.close()
})

/* ---------- 2026-09-18 review fixes ---------- */

test('snapshot: a full-window segment jump over a pruned gap does NOT advance the pull watermark and still arms the trigger', async () => {
  // Regression: the pull watermark jumped to seg.toSeq unconditionally, so a segment whose
  // fromSeq was past our watermark+1 (the rows in between were PRUNED on the peer) marked the
  // gap "received" and the oldest > wm+1 trigger could never fire — permanent divergence.
  const server = rawPeerServer({
    ack: { appliedToSeq: 100, oldestSeq: 50 },
    // full-window push: fromSeq 50 while our watermark is 0 -> a pruned hole, not contiguous
    buildSegmentsRows: [{ fromSeq: 50, toSeq: 51, deviceId: 'peer', rows: [{ entity: 'todo', id: 'late', seq: 50 }, { entity: 'todo', id: 'late2', seq: 51 }] }],
    onRequest: (n, socket) => {
      line(socket, { type: 'snapshot-chunk', index: 0, totalChunks: 1, schemaVersion: 1, rows: [{ entity: 'todo', id: 'full', seq: 1 }] })
      line(socket, { type: 'snapshot-end', totalChunks: 1, totalRows: 1, cursor: 100, schemaVersion: 1 })
    },
  })
  const port = await listen(server)
  const node = makeNode() // ingestSegment applies 0 rows -> the round is stalled
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port })

  // Round 1: the pushed segment jumps 0 -> 51. The watermark must STAY put (hole), and the
  // trigger must arm (oldest 50 > wm 0 + 1, nothing applied).
  await dialRound(node)
  assert.equal(node.getStatus().peers[0].pullWatermark, null, 'non-contiguous segment must not advance the pull watermark')
  // Round 2: snapshot-request fires (the trigger armed) and the snapshot converges.
  const r2 = await dialRound(node)
  assert.equal(r2.confirmed, 1)
  assert.equal(server.seen.snapshotRequests, 1, 'the pruned-gap jump armed the snapshot trigger')
  assert.equal(node.getStatus().peers[0].pullWatermark, 100)

  await node.stop()
  await server.close()
})

test('snapshot: mutual busy — the server role serves while the same peer is busy as a client (no 120s deadlock)', async () => {
  // Regression: ONE shared per-device busy set meant a node whose CLIENT role awaited a
  // snapshot from peer P silently dropped P's snapshot-request to its SERVER role (same key)
  // — both sides then burned the full 120s round deadline. Roles now have separate flags.
  const stallServer = rawPeerServer({
    ack: { appliedToSeq: 100, oldestSeq: 50 },
    onRequest: () => { /* never reply: keeps node-b's client role busy on 'peer-a' */ },
  })
  const stallPort = await listen(stallServer)

  const nodeB = makeNode({
    deviceId: 'node-b',
    getMaxSeq: () => 10,
    getOldestSeq: () => 1,
    buildSnapshot: () => JSON.stringify({ schemaVersion: 1, deviceId: 'node-b', rows: [{ entity: 'todo', id: 'b1', updatedAt: 1, deleted: false, deletedAt: 0, data: { taskId: 'b1' } }] }),
  })
  nodeB.start()
  await nodeB.whenListening()

  // Round 1: arms node-b's trigger (stalled round, oldestSeq 50 > wm 0 + 1).
  nodeB.addPeer({ deviceId: 'peer-a', host: '127.0.0.1', port: stallPort })
  await nodeB.startSyncRound()
  // Round 2: node-b's CLIENT role opens with snapshot-request and stalls (no reply ever).
  const stalledRound = nodeB.startSyncRound()
  await new Promise((r) => setTimeout(r, 150)) // let the request land
  assert.equal(stallServer.seen.snapshotRequests, 1)

  // While node-b's client role is busy on 'peer-a', the SAME peer id hits node-b's SERVER
  // role with a snapshot-request (the mutual-collision shape). It must be SERVED.
  const auth = require('../../../src/main/lan-sync/pairing.js')
  const cipher = require('../../../src/main/lan-sync/cipher.js')
  const net = await import('node:net')
  const sock = net.createConnection({ host: '127.0.0.1', port: nodeB.getStatus().port })
  await new Promise((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject) })
  const msgs = []
  let buf = ''
  let wake = null
  const salt = cipher.randomToken()
  let sessionKey = null
  sock.setEncoding('utf8')
  sock.on('data', (d) => {
    buf += d
    let i
    while ((i = buf.indexOf('\n')) !== -1) {
      const raw = JSON.parse(buf.slice(0, i))
      buf = buf.slice(i + 1)
      try {
        // hello-ack is plaintext; everything after is an AES-GCM frame under the session key.
        msgs.push(sessionKey && cipher.isEncFrame(raw) ? cipher.decryptFrame(sessionKey, raw) : raw)
      } catch { msgs.push(raw) }
    }
    if (wake) { const w = wake; wake = null; w() }
  })
  const nextMsg = (ms = 4000) => new Promise((resolve) => { if (msgs.length) return resolve(msgs.shift()); wake = () => resolve(msgs.length ? msgs.shift() : null); setTimeout(() => resolve(null), ms).unref?.() })
  sock.write(JSON.stringify({ type: 'hello', deviceId: 'peer-a', protoVer: 2, authCode: auth.deriveAuthCode(SECRET, 'peer-a'), enc: 1, salt }) + '\n')
  const helloAck = await nextMsg()
  assert.equal(helloAck && helloAck.ok, true)
  sessionKey = cipher.deriveSessionKey(SECRET, salt)
  sock.write(cipher.encryptFrame(sessionKey, { type: 'snapshot-request' }, 0) + '\n')
  const c1 = await nextMsg()
  assert.equal(c1 && c1.type, 'snapshot-chunk', 'server role served despite the client role being busy (old code dropped silently)')
  const end = await nextMsg()
  assert.equal(end && end.type, 'snapshot-end', 'the full transfer completed within the round')
  sock.destroy()

  stallServer.close() // frees node-b's stalled client round (connection close -> round fails)
  nodeB.stop()
  await stalledRound.catch(() => {})
})

test('snapshot: snapshot-busy reply ends the round as a clean retry-later (re-arms, small backoff)', async () => {
  const server = rawPeerServer({
    ack: { appliedToSeq: 100, oldestSeq: 50 },
    onRequest: (n, socket) => {
      if (n === 1) line(socket, { type: 'snapshot-busy' })
      else {
        line(socket, { type: 'snapshot-chunk', index: 0, totalChunks: 1, schemaVersion: 1, rows: [{ entity: 'todo', id: 'ok', seq: 1 }] })
        line(socket, { type: 'snapshot-end', totalChunks: 1, totalRows: 1, cursor: 100, schemaVersion: 1 })
      }
    },
  })
  const port = await listen(server)
  const node = makeNode(FAST_DIAL)
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port })

  await dialRound(node) // arms the trigger
  const r2 = await dialRound(node) // snapshot-busy: retry-later
  // P2-d (2026-09-19): busy counts as a round FAILURE for lastError/backoff so Device Center
  // does not show healthy-while-diverging; the trigger re-arms and the retry dials again.
  assert.equal(r2.confirmed, 0, 'snapshot-busy is a failure terminal, not a healthy round')
  const errs = node.getStatus().recent.filter((e) => e.kind === 'error')
  assert.equal(errs.length, 1, 'exactly one error entry for the busy terminal')
  assert.ok(node.getStatus().lastError, 'lastError set so the UI does not show healthy')
  assert.equal(node.getStatus().peers[0].pullWatermark, null, 'busy transfer never advanced the watermark')

  // The trigger re-armed (retry-later): the next round re-requests and converges.
  const r3 = await dialRound(node)
  assert.equal(r3.confirmed, 1)
  assert.equal(server.seen.snapshotRequests, 2)
  assert.equal(node.getStatus().peers[0].pullWatermark, 100)

  await node.stop()
  await server.close()
})

test('snapshot: EMPTY live state (totalChunks 0 / totalRows 0) is a valid terminal — converges once, no re-arm loop', async () => {
  const server = rawPeerServer({
    ack: { appliedToSeq: 100, oldestSeq: 50 },
    onRequest: (n, socket) => {
      // nothing to send: the peer's live state is empty; only the end trailer rides
      line(socket, { type: 'snapshot-end', totalChunks: 0, totalRows: 0, cursor: 100, schemaVersion: 1 })
    },
  })
  const port = await listen(server)
  let snapCount = 0
  const node = makeNode({ ingestSnapshot: () => { snapCount += 1 } })
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port })

  await dialRound(node) // arms the trigger
  const r2 = await dialRound(node) // empty snapshot: VALID terminal
  assert.equal(r2.confirmed, 1, 'empty snapshot completes the round')
  assert.equal(snapCount, 1, 'ingestSnapshot ran once with zero rows')
  assert.equal(node.getStatus().peers[0].pullWatermark, 100, 'watermark = cursor even for an empty snapshot')
  await dialRound(node)
  assert.equal(server.seen.snapshotRequests, 1, 'no infinite re-arm loop on empty snapshots')

  await node.stop()
  await server.close()
})

test('snapshot: snapshot-end with cursor 0 must NOT regress an already-advanced pull watermark', async () => {
  // Regression: the cursor was assigned unconditionally, so a bogus/absent cursor on a later
  // snapshot-end reset the watermark and caused a needless full re-sync.
  let ack = { appliedToSeq: 100, oldestSeq: 50 }
  let cursor = 100
  const server = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: 'peer', pairingSecret: SECRET,
    getHandler: () => (msg, socket) => {
      if (msg.type === 'segments-chunk') {
        line(socket, { type: 'segments-chunk', segments: [] })
        line(socket, { type: 'ack', applied: 0, rejected: 0, ...ack })
      } else if (msg.type === 'snapshot-request') {
        line(socket, { type: 'snapshot-chunk', index: 0, totalChunks: 1, schemaVersion: 1, rows: [{ entity: 'todo', id: 'a', seq: 1 }] })
        line(socket, { type: 'snapshot-end', totalChunks: 1, totalRows: 1, cursor, schemaVersion: 1 })
      }
    },
  })
  server.on('error', () => {})
  const port = await listen(server)
  const node = makeNode()
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port })

  await dialRound(node) // arms the trigger
  await dialRound(node) // snapshot with cursor 100
  assert.equal(node.getStatus().peers[0].pullWatermark, 100)

  // Peer advances and re-prunes: trigger re-arms, but the next snapshot-end carries cursor 0.
  ack = { appliedToSeq: 200, oldestSeq: 150 }
  cursor = 0
  const r = await dialRound(node) // ack 200/150 -> stalled -> arms
  assert.equal(r.confirmed, 1)
  const r2 = await dialRound(node) // snapshot with bogus cursor 0
  assert.equal(r2.confirmed, 1)
  assert.equal(node.getStatus().peers[0].pullWatermark, 100, 'cursor 0 must not reset the watermark to 0')

  await node.stop()
  await server.close()
})

test('snapshot: unsolicited snapshot-end (no request in flight) fails the round', async () => {
  const server = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: 'peer', pairingSecret: SECRET,
    getHandler: () => (msg, socket) => {
      if (msg.type === 'segments-chunk') {
        line(socket, { type: 'segments-chunk', segments: [] })
        line(socket, { type: 'snapshot-end', totalChunks: 0, totalRows: 0, cursor: 100, schemaVersion: 1 }) // NEVER requested
        line(socket, { type: 'ack', applied: 1, rejected: 0 })
      }
    },
  })
  server.on('error', () => {})
  const port = await listen(server)
  const node = makeNode()
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port })

  const r = await dialRound(node)
  assert.equal(r.confirmed, 0, 'an unsolicited snapshot-end must fail the round')
  assert.equal(node.getStatus().peers[0].pullWatermark, null, 'and never advance the watermark')

  await node.stop()
  await server.close()
})

test('snapshot: snapshot-error is a clean terminal — logged, and immediate re-arm is suppressed (cooldown + budget)', async () => {
  const server = rawPeerServer({
    ack: { appliedToSeq: 100, oldestSeq: 50 },
    onRequest: (n, socket) => line(socket, { type: 'snapshot-error', reason: 'chunkSnapshot: single row exceeds chunk budget' }),
  })
  const port = await listen(server)
  const node = makeNode(FAST_DIAL)
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port })

  await dialRound(node) // arm
  const r2 = await dialRound(node) // snapshot-error
  // P2-d: the terminal counts as a FAILURE (lastError/backoff) - not a healthy round end.
  assert.equal(r2.confirmed, 0, 'snapshot-error fails the round (honest Device Center state)')
  const errEntry = node.getStatus().recent.find((e) => e.kind === 'error' && String(e.detail && e.detail.error).includes('snapshot-error'))
  assert.ok(errEntry, 'snapshot-error logged into the recent ring')
  assert.ok(node.getStatus().lastError, 'lastError set so the UI does not show healthy')

  const r3 = await dialRound(node)
  assert.equal(r3.confirmed, 1)
  assert.equal(server.seen.snapshotRequests, 1, 'no IMMEDIATE re-arm after a snapshot-error terminal (cooldown)')

  await node.stop()
  await server.close()
})

test('snapshot: snapshot-error retry budget — a transient failure recovers without restart', async () => {
  // The peer answers snapshot-error for the first 2 requests, then serves a valid transfer.
  // Old behavior: the FIRST error permanently blocked recovery until app restart.
  let valid = false
  const server = rawPeerServer({
    ack: { appliedToSeq: 100, oldestSeq: 50 },
    onRequest: (n, socket) => {
      if (!valid) {
        line(socket, { type: 'snapshot-error', reason: 'transient' })
        if (n >= 2) valid = true
        return
      }
      line(socket, { type: 'snapshot-chunk', index: 0, totalChunks: 1, schemaVersion: 1, rows: [{ entity: 'todo', id: 'ok', seq: 1 }] })
      line(socket, { type: 'snapshot-end', totalChunks: 1, totalRows: 1, cursor: 100, schemaVersion: 1 })
    },
  })
  const port = await listen(server)
  const node = makeNode(FAST_DIAL)
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port })

  await dialRound(node) // arm
  await dialRound(node) // request 1 -> error (attempt 1, round FAILS)
  // cooldown: after an error the trigger waits 2 stalled rounds, then arms; the REQUEST itself
  // fires on the following round. P1-3: each failed round arms the dial window -> wait it out.
  node.forceDial('peer')
  await dialRound(node) // cooldown 1
  await dialRound(node) // cooldown 2
  await dialRound(node) // re-arms (cooldown elapsed)
  node.forceDial('peer')
  const r6 = await dialRound(node) // request 2 -> error (attempt 2)
  assert.equal(server.seen.snapshotRequests, 2)
  assert.equal(r6.confirmed, 0, 'the errored snapshot round fails (P2-d honesty)')
  // cooldown again, then re-arm -> request 3 -> VALID transfer
  node.forceDial('peer')
  await dialRound(node)
  await dialRound(node)
  await dialRound(node)
  node.forceDial('peer')
  const r = await dialRound(node)
  assert.equal(server.seen.snapshotRequests, 3)
  assert.equal(r.confirmed, 1)
  assert.equal(node.getStatus().peers[0].pullWatermark, 100, 'the recovered transfer advances the watermark')

  await node.stop()
  await server.close()
})

test('snapshot: fatal budget exhausts after 3 errors and stops the re-arm/error spam', async () => {
  const server = rawPeerServer({
    ack: { appliedToSeq: 100, oldestSeq: 50 },
    onRequest: (n, socket) => line(socket, { type: 'snapshot-error', reason: 'boom' }),
  })
  const port = await listen(server)
  const node = makeNode(FAST_DIAL)
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port })

  // Burn the whole budget: arm + (2 cooldown rounds + request round) x 3 = attempts 3.
  await dialRound(node) // arm
  for (let i = 0; i < 3; i++) {
    await dialRound(node)
    await dialRound(node)
      await dialRound(node) // this one re-arms and collects the error
    node.forceDial('peer')
  }
  assert.equal(server.seen.snapshotRequests, 3, 'exactly the 3 budget attempts were made')
  // Budget exhausted: further stalled rounds never re-arm again (no error spam).
  for (let i = 0; i < 5; i++) await dialRound(node)
  assert.equal(server.seen.snapshotRequests, 3, 'no re-arm after the budget is exhausted')

  await node.stop()
  await server.close()
})

test('snapshot: streaming receiver applies + flushes per chunk and never buffers rows', async () => {
  // ingestSnapshotChunk present -> streaming mode: each chunk is applied on ARRIVAL (before
  // snapshot-end), the pull watermark still advances only at snapshot-end.
  const snapRows = [
    { entity: 'todo', id: 's1', updatedAt: 1, deleted: false, deletedAt: 0, data: { taskId: 's1' } },
    { entity: 'todo', id: 's2', updatedAt: 2, deleted: false, deletedAt: 0, data: { taskId: 's2' } },
    { entity: 'todo', id: 's3', updatedAt: 3, deleted: false, deletedAt: 0, data: { taskId: 's3' } },
  ]
  const server = rawPeerServer({
    ack: { appliedToSeq: 100, oldestSeq: 50 },
    onRequest: (n, socket) => {
      line(socket, { type: 'snapshot-chunk', index: 0, totalChunks: 2, schemaVersion: 1, rows: [snapRows[0]] })
      line(socket, { type: 'snapshot-chunk', index: 1, totalChunks: 2, schemaVersion: 1, rows: snapRows.slice(1) })
      line(socket, { type: 'snapshot-end', totalChunks: 2, totalRows: 3, cursor: 100, schemaVersion: 1 })
    },
  })
  const port = await listen(server)
  const chunkApplications = []
  let endApplied = 0
  const node = makeNode({
    ingestSnapshotChunk: ({ rows }) => { chunkApplications.push(rows.map(r => r.id)) },
    ingestSnapshot: () => { endApplied += 1 },
  })
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port })

  await dialRound(node) // arm
  const r = await dialRound(node) // streaming transfer
  assert.equal(r.confirmed, 1)
  assert.deepEqual(chunkApplications, [['s1'], ['s2', 's3']], 'each chunk was applied on arrival, in order')
  assert.equal(endApplied, 0, 'the assembled-ingest fallback is NOT used in streaming mode')
  assert.equal(node.getStatus().peers[0].pullWatermark, 100, 'watermark advances at snapshot-end only')

  await node.stop()
  await server.close()
})

test('snapshot: sender streams chunks directly from the rows array (buildSnapshotRows path)', async () => {
  const rows = [
    { entity: 'todo', id: 'b', updatedAt: 2, deleted: false, deletedAt: 0, data: { taskId: 'b' } },
    { entity: 'todo', id: 'a', updatedAt: 1, deleted: false, deletedAt: 0, data: { taskId: 'a' } },
    { entity: 'todo', id: 'c', updatedAt: 3, deleted: false, deletedAt: 0, data: { taskId: 'c' } },
  ]
  const receivedIds = []
  const nodeA = makeNode({
    deviceId: 'node-a',
    ingestSnapshot: (snap) => { receivedIds.push(...snap.rows.map(r => r.id)); return { rows: snap.rows.length } },
  })
  const nodeB = makeNode({
    deviceId: 'node-b',
    getMaxSeq: () => 42,
    getOldestSeq: () => 30, // pruned past A's watermark: arms the snapshot trigger
    ingestSegment: () => ({ applied: 0, rejected: 0 }),
    // Array path: no buildSnapshot JSON string is ever produced.
    buildSnapshotRows: () => rows.slice(),
    snapshotSchemaVersion: 7,
  })
  nodeA.start()
  nodeB.start()
  const [, portB] = await Promise.all([nodeA.whenListening(), nodeB.whenListening()])
  nodeA.addPeer({ deviceId: 'node-b', host: '127.0.0.1', port: portB, name: 'Node B' })

  await nodeA.startSyncRound() // arm (stalled + oldest > wm+1)
  const r = await nodeA.startSyncRound() // snapshot flows
  assert.equal(r.confirmed, 1)
  assert.deepEqual(receivedIds, ['a', 'b', 'c'], 'rows streamed sorted by id, tiled across chunks')
  assert.equal(nodeA.getStatus().peers[0].pullWatermark, 42, 'cursor recorded as pull watermark')

  await nodeA.stop()
  await nodeB.stop()
})

test('snapshot: progress-based round deadline — a slow-drip transfer outlives a short base deadline', async () => {
  // Base deadline 400ms, progress extension 300ms. The peer sends 5 chunks, one every 150ms
  // (total 750ms+): a fixed deadline shorter than the transfer would kill it mid-flight; the
  // progress-based deadline stays alive because every chunk re-arms the timer.
  const server = rawPeerServer({
    ack: { appliedToSeq: 100, oldestSeq: 50 },
    onRequest: async (n, socket) => {
      for (let i = 0; i < 5; i++) {
        await new Promise((r2) => setTimeout(r2, 300))
        line(socket, { type: 'snapshot-chunk', index: i, totalChunks: 5, schemaVersion: 1, rows: [{ entity: 'todo', id: 'drip' + i }] })
      }
      line(socket, { type: 'snapshot-end', totalChunks: 5, totalRows: 5, cursor: 100, schemaVersion: 1 })
    },
  })
  const port = await listen(server)
  const node = makeNode({ roundTimeoutMs: 500, roundProgressMs: 1500 })
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port })

  await dialRound(node) // arm
  const r = await dialRound(node) // slow-drip snapshot: total > base deadline
  assert.equal(r.confirmed, 1, 'a moving transfer completes despite exceeding the base deadline')
  assert.equal(node.getStatus().peers[0].pullWatermark, 100)

  await node.stop()
  await server.close()
})

test('snapshot: idle timeout — a silent peer still fails the round at the (short) deadline', async () => {
  const server = rawPeerServer({
    ack: { appliedToSeq: 100, oldestSeq: 50 },
    onRequest: () => { /* never reply */ },
  })
  const port = await listen(server)
  const node = makeNode({ roundTimeoutMs: 250, roundProgressMs: 200 })
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port })

  await dialRound(node) // arm
  const t0 = Date.now()
  const r = await dialRound(node) // no progress at all
  const elapsed = Date.now() - t0
  assert.equal(r.confirmed, 0, 'a silent peer fails its round')
  assert.ok(elapsed >= 200 && elapsed < 5000, `idle timeout fired near the deadline (took ${elapsed}ms)`)
  assert.equal(node.getStatus().peers[0].pullWatermark, null)
  assert.match(node.getStatus().lastError || '', /timed out/)

  await node.stop()
  server.close()
})

test('snapshot: adversarial chunk streams (missing/duplicate index, totalRows mismatch, chunks-less end) fail the round without advancing the watermark', async () => {
  const variants = [
    // 1. missing chunk index: 0 and 2 of totalChunks 3
    (socket) => {
      line(socket, { type: 'snapshot-chunk', index: 0, totalChunks: 3, schemaVersion: 1, rows: [{ entity: 'todo', id: 'a' }] })
      line(socket, { type: 'snapshot-chunk', index: 2, totalChunks: 3, schemaVersion: 1, rows: [{ entity: 'todo', id: 'c' }] })
      line(socket, { type: 'snapshot-end', totalChunks: 3, totalRows: 3, cursor: 100, schemaVersion: 1 })
    },
    // 2. duplicate index
    (socket) => {
      line(socket, { type: 'snapshot-chunk', index: 0, totalChunks: 2, schemaVersion: 1, rows: [{ entity: 'todo', id: 'a' }] })
      line(socket, { type: 'snapshot-chunk', index: 0, totalChunks: 2, schemaVersion: 1, rows: [{ entity: 'todo', id: 'a2' }] })
      line(socket, { type: 'snapshot-end', totalChunks: 2, totalRows: 2, cursor: 100, schemaVersion: 1 })
    },
    // 3. totalRows mismatch (chunks tile fine but claim 5 rows)
    (socket) => {
      line(socket, { type: 'snapshot-chunk', index: 0, totalChunks: 2, schemaVersion: 1, rows: [{ entity: 'todo', id: 'a' }] })
      line(socket, { type: 'snapshot-chunk', index: 1, totalChunks: 2, schemaVersion: 1, rows: [{ entity: 'todo', id: 'b' }] })
      line(socket, { type: 'snapshot-end', totalChunks: 2, totalRows: 5, cursor: 100, schemaVersion: 1 })
    },
    // 4. snapshot-end claiming rows with NO chunks at all
    (socket) => {
      line(socket, { type: 'snapshot-end', totalChunks: 2, totalRows: 2, cursor: 100, schemaVersion: 1 })
    },
  ]
  const server = rawPeerServer({
    ack: { appliedToSeq: 100, oldestSeq: 50 },
    onRequest: (n, socket) => {
      if (n <= variants.length) variants[n - 1](socket)
      else {
        line(socket, { type: 'snapshot-chunk', index: 0, totalChunks: 1, schemaVersion: 1, rows: [{ entity: 'todo', id: 'good' }] })
        line(socket, { type: 'snapshot-end', totalChunks: 1, totalRows: 1, cursor: 100, schemaVersion: 1 })
      }
    },
  })
  const port = await listen(server)
  const node = makeNode(FAST_DIAL)
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port })

  await dialRound(node) // arms the trigger
  for (let i = 0; i < variants.length; i++) {
      const r = await dialRound(node)
    assert.equal(r.confirmed, 0, `adversarial variant ${i + 1} must fail the round`)
    assert.equal(node.getStatus().peers[0].pullWatermark, null, `variant ${i + 1} must not advance the watermark`)
  }
  node.forceDial('peer')
  const rOk = await dialRound(node)
  assert.equal(rOk.confirmed, 1, 'a valid transfer still converges after the adversarial ones')
  assert.equal(node.getStatus().peers[0].pullWatermark, 100)

  await node.stop()
  await server.close()
})

test('chunkSnapshot: 50k-row scale — chunk count scales linearly, byte budget and tiling hold (2026-09-25 gap: chunking was only proven at 500 rows)', () => {
  const N = 50000
  const rows = []
  for (let i = 0; i < N; i++) rows.push({ entity: 'todo', id: 's' + i, updatedAt: i, data: { taskId: 's' + i, pad: 'y'.repeat(200) } })
  const r = chunkSnapshot({ schemaVersion: 1, rows }, { cursor: 42 })
  assert.equal(r.totalRows, N)
  assert.equal(r.cursor, 42)
  assert.equal(r.chunks.flatMap(c => c.rows).length, N, 'every row lands in exactly one chunk')
  for (let i = 1; i < r.chunks.length; i++) {
    assert.ok(r.chunks[i - 1].rows.at(-1).id < r.chunks[i].rows[0].id, 'chunks tile in order without overlap')
  }
  for (const c of r.chunks) {
    const bytes = Buffer.byteLength(JSON.stringify({ rows: c.rows }), 'utf8')
    assert.ok(bytes <= SNAPSHOT_CHUNK_BYTES, 'every chunk stays under the budget')
  }
  // linear scaling sanity: ~200B/row rows against a 1MB budget must produce tens of chunks, not thousands
  assert.ok(r.chunks.length >= 5 && r.chunks.length <= 400, 'chunk count within linear band: ' + r.chunks.length)
})
