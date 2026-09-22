/* Fix-round regression tests (2026-09-22, fix/dw-lan-sync) — lan-sync domain:
 *   R1  att-missing joins the requestedBatch gate (P2-a parity): an unsolicited att-missing
 *       must not poison the 24h session failed-set nor cancel an in-flight transfer.
 *   R2  markFailed refunds/cancels ONLY the failing id: an interleaved att-missing for a
 *       DIFFERENT id must not drop the file being received; a refund re-frees the budget.
 *   R3  notifyUnpaired reports wire delivery honestly; the live-server-socket entry is
 *       dropped when the socket closes (destroyed sockets no longer "succeed").
 *   R4  stop() closes the client sockets of in-flight rounds (graceful exit is not held
 *       for up to the 120s round deadline).
 *   R5  Peer oplog reset (same deviceId, sequence rollback): low peer seqs arm the snapshot
 *       trigger and a full snapshot carrying a cursor BELOW the recorded pull watermark
 *       adopts the new epoch instead of wedging the peer forever.
 *   R6  snapshot-busy does not advance the dial-failure streak (mutual-snapshot collisions
 *       can no longer hibernate a healthy peer).
 *   R7  The invalid host/port early-exit dial path re-resolves through discovery.
 *   R8  att-server per-peer request bookkeeping is reclaimable (forget()).
 *   R9  Client close() flushes buffered frames before destroy (round-end acks arrive).
 *   R10 A single segment over the chunk budget fails the pack loudly (no silent oversize chunk).
 *
 * Run: node --test tests/unit/lan-sync/fixround-20260922.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'

const require = createRequire(import.meta.url)
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')
const { createLanServer, connect } = require('../../../src/main/lan-sync/transport.js')
const att = require('../../../src/main/lan-sync/att-transfer.js')
const { packSegmentChunks, SEGMENT_CHUNK_BYTES, WIRE_CAP_BYTES } = require('../../../src/main/lan-sync/segments-chunk.js')
const { deriveAuthCode } = require('../../../src/main/lan-sync/pairing.js')

const sha = buf => createHash('sha256').update(buf).digest('hex')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function fakeDiscovery () {
  return { startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] }
}

async function listen (server) {
  await new Promise((resolve, reject) => {
    server.once('listening', resolve)
    server.once('error', reject)
  })
  return server.port
}

function makePullerDeps () {
  const written = []
  return {
    deps: {
      exists: () => false,
      size: () => 0,
      read: () => Buffer.alloc(0),
      writeAtomic: (key, buf) => { written.push({ key, buf }); return true },
    },
    written,
  }
}

/* ---------------- R1: unsolicited att-missing is rejected ---------------- */

test('R1: an att-missing for an id outside the requested batch never enters the failed-set', () => {
  const { deps } = makePullerDeps()
  const session = { failed: new Map(), requests: new Map() }
  let sentIds = null
  const puller = att.createAttachmentPuller({ deps, session, peerId: 'p1', send: m => { sentIds = m.ids }, getKeys: () => ['k1'] })
  assert.equal(puller.maybeStart(() => {}, () => {}), true, 'the att-req went out')
  assert.ok(sentIds && sentIds.length === 1, 'one id requested')
  // A buggy/compromised peer answers with a missing frame for an id we NEVER asked for.
  assert.equal(puller.onMessage({ type: 'att-missing', id: 'poisoned-key' }), true)
  assert.equal(session.failed.has('poisoned-key'), false, 'the foreign id must not be poisoned into the 24h failed-set')
  // The genuinely requested id still obeys the old semantics.
  const requested = String(sentIds[0])
  assert.equal(puller.onMessage({ type: 'att-missing', id: requested }), true)
  assert.equal(session.failed.has(requested), true, 'requested ids still mark failed')
})

test('R1b: an unsolicited att-missing does not cancel the in-flight transfer', () => {
  const { deps, written } = makePullerDeps()
  const session = { failed: new Map(), requests: new Map() }
  let sentIds = null
  const puller = att.createAttachmentPuller({ deps, session, peerId: 'p1', send: m => { sentIds = m.ids }, getKeys: () => ['k1'] })
  puller.maybeStart(() => {}, () => {})
  const reqId = String(sentIds[0])
  const payload = Buffer.from('hello-world')
  assert.equal(puller.onMessage({ type: 'att-meta', id: reqId, size: payload.length, hash: sha(payload) }), true)
  // Foreign-id missing frame arrives mid-transfer.
  puller.onMessage({ type: 'att-missing', id: 'somewhere-else' })
  assert.equal(puller.onMessage({ type: 'att-chunk', id: reqId, index: 0, data: payload.toString('base64'), final: true }), true)
  assert.equal(written.length, 1, 'the in-flight file still landed')
})

/* ---------------- R2: markFailed refunds only the failing id ---------------- */

test('R2: an att-missing for a different id neither drops the current file nor refunds its bytes', () => {
  const { deps, written } = makePullerDeps()
  const session = { failed: new Map(), requests: new Map() }
  let sentIds = null
  const puller = att.createAttachmentPuller({ deps, session, peerId: 'p1', maxBytes: 1500, send: m => { sentIds = m.ids }, getKeys: () => ['k1', 'k2'] })
  puller.maybeStart(() => {}, () => {})
  const [k1, k2] = sentIds.map(String)
  const payload = Buffer.alloc(1000).fill(7)
  assert.equal(puller.onMessage({ type: 'att-meta', id: k1, size: 1000, hash: sha(payload) }), true, 'k1 reserved 1000B')
  // The peer reports k2 missing WHILE k1 is in flight: k1 must survive, untouched.
  assert.equal(puller.onMessage({ type: 'att-missing', id: k2 }), true)
  assert.equal(session.failed.has(k2), true, 'the requested-and-missing id is failed normally')
  assert.equal(puller.onMessage({ type: 'att-chunk', id: k1, index: 0, data: payload.toString('base64'), final: true }), true)
  assert.equal(written.length, 1, 'k1 completed despite the interleaved missing frame')
  assert.equal(written[0].key, k1)
})

test('R2b: a failed in-flight id refunds its reserved budget for later files', () => {
  const { deps, written } = makePullerDeps()
  const session = { failed: new Map(), requests: new Map() }
  let sentIds = null
  const puller = att.createAttachmentPuller({ deps, session, peerId: 'p1', maxBytes: 1500, send: m => { sentIds = m.ids }, getKeys: () => ['k1', 'k2'] })
  puller.maybeStart(() => {}, () => {})
  const [k1, k2] = sentIds.map(String)
  const payload = Buffer.alloc(1000).fill(9)
  assert.equal(puller.onMessage({ type: 'att-meta', id: k1, size: 1000, hash: sha(payload) }), true)
  // k1 itself fails (peer says missing): refund its 1000B...
  assert.equal(puller.onMessage({ type: 'att-missing', id: k1 }), true)
  assert.equal(session.failed.has(k1), true)
  // ...so k2's 1000B still fits inside the 1500B round budget.
  assert.equal(puller.onMessage({ type: 'att-meta', id: k2, size: 1000, hash: sha(payload) }), true, 'k2 accepted after the refund')
  assert.equal(puller.onMessage({ type: 'att-chunk', id: k2, index: 0, data: payload.toString('base64'), final: true }), true)
  assert.equal(written.length, 1)
  assert.equal(written[0].key, k2, 'k2 landed')
})

/* ---------------- R3: notifyUnpaired honesty + live-socket cleanup ---------------- */

test('R3: notifyUnpaired returns false for a dead socket; the live entry clears on close', async () => {
  const node = createLanSyncNode({
    deviceId: 'self-r3', pairingSecret: 's3cret', port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: () => ({ applied: 0 }),
    buildSegments: () => [],
  })
  node.start()
  const port = await node.whenListening()
  // Unknown peer: no live socket -> false.
  assert.equal(node.notifyUnpaired('nobody'), false)

  // Establish a live authenticated server socket on OUR server via a raw client.
  const client = connect('127.0.0.1', port, {
    deviceId: 'peer-r3', authCode: deriveAuthCode('s3cret', 'peer-r3'),
    pairingSecret: 's3cret', timeoutMs: 5000,
  })
  await new Promise((resolve, reject) => { client.on('ready', resolve); client.on('error', reject) })
  client.send({ type: 'segments-chunk', segments: [], final: true })
  await sleep(150)
  assert.equal(node.notifyUnpaired('peer-r3'), true, 'live authenticated socket: control message went to the wire')

  // Kill the client socket: our server-side entry must clear, and notify must stop lying.
  await client.close()
  await sleep(150)
  assert.equal(node.notifyUnpaired('peer-r3'), false, 'a closed socket is no longer reported as notified')
  await node.stop()
})

/* ---------------- R4: stop() closes in-flight round clients ---------------- */

test('R4: stop() resolves promptly while a round is stalled on a silent peer', async () => {
  // A peer that accepts the connection but NEVER answers: the round hangs until its deadline.
  const conns = new Set()
  const blackHole = net.createServer(c => { conns.add(c); c.once('close', () => conns.delete(c)) })
  await new Promise(r => blackHole.listen(0, '127.0.0.1', r))
  const port = blackHole.address().port
  const node = createLanSyncNode({
    deviceId: 'self-r4', pairingSecret: 's3cret', port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: () => ({ applied: 0 }),
    buildSegments: () => [{ fromSeq: 1, toSeq: 1, deviceId: 'self-r4', rows: [{ id: 'a', seq: 1 }] }],
    roundTimeoutMs: 120000, roundProgressMs: 45000,
  })
  node.addPeer({ deviceId: 'peer-r4', host: '127.0.0.1', port })
  const round = node.startSyncRound()
  await sleep(200) // the client socket is now connected and stalling
  const t0 = Date.now()
  await node.stop()
  const stopMs = Date.now() - t0
  assert.ok(stopMs < 10000, `stop() must not be held by the stalled round (took ${stopMs}ms; pre-fix it waited for the 120s round deadline)`)
  await round // settles (as a failure) through the normal connection-close path
  // Teardown: this host's half-open stall sockets hold server.close()'s callback forever —
  // destroy the accepted connections and DON'T await the close callback.
  blackHole.closeAllConnections?.()
  for (const c of conns) c.destroy()
  blackHole.close()
  blackHole.unref()
})

/* ---------------- R5: peer oplog rollback recovers ---------------- */

test('R5: a rollback peer (low seqs, lower cursor) re-syncs instead of wedging forever', async () => {
  // Scripted peer lifecycle:
  //   round 1: pruned oplog (oldestSeq 50 >> wm+1) -> arms the snapshot trigger
  //   round 2: serves a full snapshot, cursor 100 -> client pull watermark = 100
  //   round 3: the peer RESET its oplog — its "new" push carries seqs 2..3 (< wm 100)
  //   round 4: serves the reset-epoch snapshot, cursor 7 -> the client must ADOPT 7
  let phase = 0
  const fakePeer = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: 'peer-r5', pairingSecret: 's3cret',
    getHandler: () => (msg, socket) => {
      if (msg.type === 'segments-chunk') {
        phase += 1
        if (phase === 3) {
          // Post-reset increments: seqs strictly below the client's recorded watermark.
          socket._lanSend({ type: 'segments-chunk', segments: [{ fromSeq: 2, toSeq: 3 }], final: true })
        }
        const oldestSeq = phase >= 3 ? 1 : 50
        setTimeout(() => socket._lanSend({ type: 'ack', applied: msg.segments.length, rejected: 0, oldestSeq }), 20)
      } else if (msg.type === 'snapshot-request') {
        const cursor = phase >= 4 ? 7 : 100
        socket._lanSend({ type: 'snapshot-chunk', index: 0, totalChunks: 1, rows: [{ id: 'r1', seq: 1 }] })
        socket._lanSend({ type: 'snapshot-end', totalChunks: 1, totalRows: 1, cursor })
      }
    },
  })
  const port = await listen(fakePeer)

  const snapshots = []
  const node = createLanSyncNode({
    deviceId: 'self-r5', pairingSecret: 's3cret', port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: () => ({ applied: 0 }),
    ingestSnapshot: (snap) => snapshots.push(snap),
    buildSegments: () => [],
  })
  node.addPeer({ deviceId: 'peer-r5', host: '127.0.0.1', port })

  const wm = () => node.getStatus().peers.find(p => p.deviceId === 'peer-r5').pullWatermark
  await node.startSyncRound() // round 1: prune arms the trigger
  await node.startSyncRound() // round 2: snapshot at cursor 100
  assert.equal(snapshots.length, 1, 'the pre-reset snapshot applied')
  assert.equal(wm(), 100, 'watermark followed the peer cursor to 100')
  await node.startSyncRound() // round 3: low seqs 2..3 arrive (pre-fix: judged "caught up")
  await node.startSyncRound() // round 4: the trigger re-armed -> reset-epoch snapshot, cursor 7
  assert.equal(snapshots.length, 2, 'the reset-epoch snapshot was requested and applied')
  assert.equal(wm(), 7, 'the LOWER cursor was adopted as the new epoch (pre-fix: max() kept 100 -> wedged)')
  await node.stop()
  await fakePeer.close()
})

/* ---------------- R6: snapshot-busy is exempt from the dial-failure streak ---------------- */

test('R6: repeated snapshot-busy never drives the peer into hibernate', async () => {
  const fakePeer = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: 'peer-r6', pairingSecret: 's3cret',
    getHandler: () => (msg, socket) => {
      if (msg.type === 'snapshot-request') {
        socket._lanSend({ type: 'snapshot-busy' })
      } else if (msg.type === 'segments-chunk') {
        setTimeout(() => socket._lanSend({ type: 'ack', applied: msg.segments.length, rejected: 0, oldestSeq: 10 }), 20)
      }
    },
  })
  const port = await listen(fakePeer)

  const node = createLanSyncNode({
    deviceId: 'self-r6', pairingSecret: 's3cret', port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: () => ({ applied: 0 }),
    ingestSnapshot: () => {},
    buildSegments: () => [],
    // Short budget/backoff so a streak leak is observable within the test: if busy collided
    // into the streak, the backoff jumps to hibernateBackoffMs (10min) after 3 busy rounds.
    dialFailureBudget: 3, hibernateBackoffMs: 10 * 60 * 1000, backoffBaseMs: 20, backoffMaxMs: 50,
  })
  node.addPeer({ deviceId: 'peer-r6', host: '127.0.0.1', port })
  for (let i = 0; i < 8; i++) {
    await node.startSyncRound() // oldestSeq 10 > wm+1 arms the snapshot trigger every round
    node.forceDial('peer-r6')
  }
  const st = node.getStatus().peers.find(p => p.deviceId === 'peer-r6')
  assert.notEqual(st.peerState, 'hibernating', `pure scheduling collisions must not hibernate the peer (state=${st.peerState})`)
  const nextIn = (st.nextDialAt || 0) - Date.now()
  assert.ok(nextIn < 5000, `retry stays on the short backoff, not the hibernate window (nextIn=${nextIn}ms)`)
  await node.stop()
  await fakePeer.close()
})

/* ---------------- R7: the invalid-target early exit re-resolves discovery ---------------- */

test('R7: a corrupted stored port is re-fixed from discovery before the failure is counted', async () => {
  const goodPeer = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: 'peer-r7', pairingSecret: 's3cret',
    getHandler: () => (msg, socket) => {
      if (msg.type === 'segments-chunk') setTimeout(() => socket._lanSend({ type: 'ack', applied: msg.segments.length, rejected: 0 }), 20)
    },
  })
  const goodPort = await listen(goodPeer)
  // Discovery knows the truth; the stored record has a corrupted port.
  const node = createLanSyncNode({
    deviceId: 'self-r7', pairingSecret: 's3cret', port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    resolvePeer: () => ({ deviceId: 'peer-r7', host: '127.0.0.1', port: goodPort }),
    ingestSegment: () => ({ applied: 0 }),
    buildSegments: () => [],
  })
  node.addPeer({ deviceId: 'peer-r7', host: '127.0.0.1', port: 99999 }) // invalid port
  const first = await node.startSyncRound() // fails, but re-fixes the address
  assert.equal(first.confirmed, 0)
  const stored = node.getStatus().peers.find(p => p.deviceId === 'peer-r7')
  assert.equal(stored.port, goodPort, 'the stored record now carries the discovery-resolved port')
  // The next round dials the GOOD target and confirms.
  node.forceDial('peer-r7')
  const second = await node.startSyncRound()
  assert.equal(second.confirmed, 1, 'the re-fixed target rounds successfully')
  await node.stop()
  await goodPeer.close()
})

/* ---------------- R8: att-server per-peer bookkeeping is reclaimable ---------------- */

test('R8: forget() clears the per-peer served-request counter', () => {
  const server = att.createAttachmentServer({
    deps: { exists: () => true, size: () => 1, read: () => Buffer.alloc(1) },
    perPeerCap: 2,
  })
  const send = () => true
  server.serve({ deviceId: 'px' }, { ids: ['a'] }, send)
  server.serve({ deviceId: 'px' }, { ids: ['a'] }, send)
  assert.equal(server.requestsFor('px'), 2)
  server.serve({ deviceId: 'px' }, { ids: ['a'] }, send) // capped
  assert.equal(server.requestsFor('px'), 2, 'cap holds')
  server.forget('px')
  assert.equal(server.requestsFor('px'), 0, 'the counter is reclaimable (forgetPeer wires this)')
  server.serve({ deviceId: 'px' }, { ids: ['a'] }, send)
  assert.equal(server.requestsFor('px'), 1, 'a returning peer starts fresh')
})

/* ---------------- R9: client close() flushes buffered frames ---------------- */

test('R9: a large frame sent right before close() still reaches the peer', async () => {
  const received = []
  const server = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: 'peer-r9', pairingSecret: 's3cret',
    getHandler: () => (msg) => { if (msg.type === 'ack') received.push(msg) },
  })
  const port = await listen(server)
  const client = connect('127.0.0.1', port, {
    deviceId: 'self-r9', authCode: deriveAuthCode('s3cret', 'self-r9'),
    pairingSecret: 's3cret', timeoutMs: 5000,
  })
  await new Promise((resolve, reject) => { client.on('ready', resolve); client.on('error', reject) })
  // 3MB of payload: far past the socket's kernel send buffer, so the frame MUST sit in the
  // write buffer when close() is called. Pre-fix end()+destroy() in the same tick discarded it.
  const noteLen = 3 * 1024 * 1024
  client.send({ type: 'ack', applied: 7, rejected: 0, note: 'x'.repeat(noteLen) })
  await client.close()
  await sleep(300)
  assert.equal(received.length, 1, 'the peer received the pre-close frame (no silent discard)')
  assert.equal(received[0].note.length, noteLen)
  await server.close()
})

/* ---------------- R10: an oversize single segment fails loudly ---------------- */

test('R10: a single segment past the wire cap throws instead of shipping an oversize chunk', () => {
  const big = { fromSeq: 1, toSeq: 2, body: 'x'.repeat(WIRE_CAP_BYTES + 1) }
  assert.throws(() => packSegmentChunks([big]), /exceeds the .*-byte wire cap/,
    'an un-splittable over-cap segment must be rejected, not packed as an over-cap chunk')
  // Budget-busting but wire-safe (the real oplog shape, ~1.1MB envelope): ships alone, no throw.
  const chunky = { fromSeq: 1, toSeq: 2, body: 'x'.repeat(SEGMENT_CHUNK_BYTES + 100 * 1024) }
  const own = packSegmentChunks([chunky])
  assert.equal(own.length, 1, 'an over-budget single segment ships as its own (terminal) chunk')
  assert.equal(own[0].segments.length, 1)
  assert.equal(own[0].final, true)
  // Exactly at the hard cap (minus the 2 JSON quote bytes) still packs.
  const edge = { fromSeq: 1, toSeq: 2, body: 'x'.repeat(WIRE_CAP_BYTES - 2) }
  const chunks = packSegmentChunks([edge])
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].final, true)
  // Normal small segments still pack and terminate.
  const normal = packSegmentChunks([{ fromSeq: 1, toSeq: 1, body: 'a' }, { fromSeq: 2, toSeq: 2, body: 'b' }])
  assert.equal(normal.length, 1)
  assert.equal(normal[0].segments.length, 2)
})
