/* Wave-B regression tests (2026-09-21, fix/wave-b):
 *   P1   flushFailed force-arms the snapshot trigger and the arm SURVIVES a same-round
 *        roundApplied > 0 (poison-segment infinite re-push loop fix).
 *   P2-1 authenticated-phase idle timeout: wireConnection re-arms the socket idle timer
 *        (longer auth budget) at hello-ack instead of disarming it entirely — a vanished
 *        peer can no longer hold a maxSockets slot forever.
 *   P2-2 duplicate att-meta reuses the open receive session (no double budget reservation,
 *        no assembly reset); a duplicate after completion is ignored.
 *   P2-3 discovery upsertPeer: a lower-scored (UDP-learned) address can no longer overwrite
 *        a better stored host (multi-NIC flapping fix).
 *   P2-4 packSegmentChunks refuses a single segment over the wire cap with a tagged error
 *        (.oversizedSegment) so the round ends in a terminal, diagnosable peer state.
 *
 * Run: node --test tests/unit/lan-sync/wave-b-20260921.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')
const { createLanServer, wireConnection, AUTH_IDLE_TIMEOUT_MS } = require('../../../src/main/lan-sync/transport.js')
const { packSegmentChunks, WIRE_CAP_BYTES } = require('../../../src/main/lan-sync/segments-chunk.js')
const { createDiscovery } = require('../../../src/main/lan-sync/discovery.js')
const { createAttachmentPuller } = require('../../../src/main/lan-sync/att-transfer.js')
const { deriveAuthCode } = require('../../../src/main/lan-sync/pairing.js')
const cipher = require('../../../src/main/lan-sync/cipher.js')

const SECRET = 'wave-b-secret-1'

function fakeDiscovery () {
  return { startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] }
}

const listen = server => new Promise(resolve => { server.on('listening', () => resolve(server.port)) })

function makeNode (extra = {}) {
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
    dialFailureBudget: 1000,
    ...extra,
  })
}

/* ---------------- P1: poison-segment snapshot escape survives partial progress ---------------- */

test('P1: pull-side flushFailed + same-round partial apply still force-arms the snapshot request', async () => {
  const seen = { requests: 0, snapshots: 0 }
  let poison = true
  const server = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: 'peer', pairingSecret: SECRET,
    getHandler: () => (msg, socket) => {
      if (msg.type === 'segments-chunk') {
        // Push TWO chunks back: the first applies cleanly (roundApplied > 0), the second is the
        // poison segment (flushFailed). The old evaluateSnapshotTrigger cancelled the armed
        // snapshot in the SAME round because roundApplied > 0 — the poison segment was then
        // re-pushed and re-dropped forever.
        const send = m => socket._lanSend(m)
        send({ type: 'segments-chunk', segments: [{ body: 'ok', fromSeq: 1, toSeq: 2 }], final: false })
        send({ type: 'segments-chunk', segments: [{ body: poison ? 'poison' : 'ok', fromSeq: 3, toSeq: 4 }], final: true })
        send({ type: 'ack', applied: 1, rejected: 0, appliedToSeq: 0, oldestSeq: 1 })
      } else if (msg.type === 'snapshot-request') {
        seen.requests += 1
        socket._lanSend({ type: 'snapshot-end', totalChunks: 0, totalRows: 0, cursor: 4, schemaVersion: 1 })
      }
    },
  })
  server.on('error', () => {})
  const port = await listen(server)
  const node = makeNode({
    ingestSegment: seg => (seg.body === 'poison'
      ? { applied: 0, rejected: 0, flushFailed: true }
      : { applied: 1, rejected: 0 }),
  })
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port })

  await node.startSyncRound() // partial apply + flushFailed in the SAME round
  assert.equal(seen.requests, 0, 'no snapshot mid-round')
  // The peer's data is healthy from here on: the armed force is the ONLY reason round 2 opens
  // with a snapshot-request (roundApplied > 0 in round 1 would have cancelled it under the old
  // logic).
  poison = false
  await node.startSyncRound() // must open with a snapshot-request despite roundApplied > 0
  assert.equal(seen.requests, 1, 'the force-armed snapshot survives the same-round progress')
  await node.startSyncRound() // consumed: the recovered round pushes increments again
  assert.equal(seen.requests, 1, 'the force-arm is consumed by the snapshot-request')
  await node.stop()
  await server.close()
})

test('P1: push-side flushFailed ack + same-round pull progress still force-arms the snapshot request', async () => {
  const seen = { requests: 0 }
  const server = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: 'peer', pairingSecret: SECRET,
    getHandler: () => (msg, socket) => {
      if (msg.type === 'segments-chunk') {
        // The peer ALSO pushes data that applies cleanly (roundApplied > 0), then acks OUR push
        // with flushFailed (its bulk flush dropped our rows).
        socket._lanSend({ type: 'segments-chunk', segments: [{ body: 'ok', fromSeq: 1, toSeq: 2 }], final: true })
        socket._lanSend({ type: 'ack', applied: 1, rejected: 0, appliedToSeq: 4, flushFailed: true, oldestSeq: 1 })
      } else if (msg.type === 'snapshot-request') {
        seen.requests += 1
        socket._lanSend({ type: 'snapshot-end', totalChunks: 0, totalRows: 0, cursor: 9, schemaVersion: 1 })
      }
    },
  })
  server.on('error', () => {})
  const port = await listen(server)
  const peerProgress = new Map()
  const node = makeNode({ getMaxSeq: () => 20, peerProgress })
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port })

  await node.startSyncRound()
  await node.startSyncRound()
  assert.equal(seen.requests, 1, 'snapshot requested on the round after the flushFailed ack despite pull progress')
  await node.stop()
  await server.close()
})

/* ---------------- P2-1: authenticated-phase idle timeout ---------------- */

function fakeSocket () {
  const listeners = {}
  const sock = {
    remoteAddress: '127.0.0.1',
    destroyed: false,
    writes: [],
    timeouts: [],
    on (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn) },
    emit (ev, ...args) { for (const fn of listeners[ev] || []) fn(...args) },
    setEncoding () {},
    setTimeout (ms) { sock.timeouts.push(ms) },
    write (s) { sock.writes.push(s); return true },
    destroy () { sock.destroyed = true },
  }
  return sock
}

test('P2-1: hello-ack re-arms the idle timer with the authenticated budget (not 0)', () => {
  const sock = fakeSocket()
  wireConnection(sock, { deviceId: 'self', pairingSecret: SECRET })
  assert.deepEqual(sock.timeouts, [], 'nothing armed before any message')
  const code = deriveAuthCode(SECRET, 'peer-1')
  const salt = cipher.randomToken()
  sock.emit('data', JSON.stringify({ type: 'hello', deviceId: 'peer-1', protoVer: 2, authCode: code, enc: 1, salt }) + '\n')
  assert.equal(sock.timeouts.length, 1, 'timer re-armed at auth')
  assert.equal(sock.timeouts[0], AUTH_IDLE_TIMEOUT_MS, 'authenticated-phase budget armed (zombie sockets now expire)')
  assert.notEqual(sock.timeouts[0], 0, 'the pre-auth timer must NOT simply be disarmed anymore')
})

test('P2-1: authIdleMs <= 0 opts out (legacy disarm behavior, injectable for tests)', () => {
  const sock = fakeSocket()
  wireConnection(sock, { deviceId: 'self', pairingSecret: SECRET, authIdleMs: 0 })
  const code = deriveAuthCode(SECRET, 'peer-1')
  sock.emit('data', JSON.stringify({ type: 'hello', deviceId: 'peer-1', protoVer: 2, authCode: code, enc: 1, salt: cipher.randomToken() }) + '\n')
  assert.deepEqual(sock.timeouts, [0], 'opt-out disarms the timer entirely')
})

test('P2-1: a custom authIdleMs is honored (server-level injection)', () => {
  const sock = fakeSocket()
  wireConnection(sock, { deviceId: 'self', pairingSecret: SECRET, authIdleMs: 5000 })
  const code = deriveAuthCode(SECRET, 'peer-1')
  sock.emit('data', JSON.stringify({ type: 'hello', deviceId: 'peer-1', protoVer: 2, authCode: code, enc: 1, salt: cipher.randomToken() }) + '\n')
  assert.deepEqual(sock.timeouts, [5000])
})

/* ---------------- P2-2: duplicate att-meta dedupe ---------------- */

function makePuller (extra = {}) {
  const writes = []
  const sent = []
  const puller = createAttachmentPuller({
    maxBytes: 15, // tiny round budget so double reservation would visibly overflow
    deps: { exists: () => false, size: () => 0, read: () => Buffer.alloc(0), writeAtomic: (k, b) => { writes.push({ k, b }); return true }, hashFn: () => 'h1' },
    send: m => { sent.push(m); return true },
    getKeys: () => ['a.txt'],
    onArrived: () => {},
    ...extra,
  })
  return { puller, writes, sent }
}

test('P2-2: duplicate att-meta mid-transfer reuses the open session (budget reserved once)', () => {
  const { puller, writes } = makePuller()
  assert.equal(puller.maybeStart(() => {}, () => {}), true, 'att-req sent')
  puller.onMessage({ type: 'att-meta', id: 'a.txt', size: 10, hash: 'h1' })
  puller.onMessage({ type: 'att-chunk', id: 'a.txt', index: 0, data: Buffer.from('hello').toString('base64') })
  // duplicate meta for the in-flight file: the OLD path re-opened the session (re-reserved 10 of
  // the 15-byte budget and wiped the assembly map); the new path must be a no-op.
  puller.onMessage({ type: 'att-meta', id: 'a.txt', size: 10, hash: 'h1' })
  puller.onMessage({ type: 'att-chunk', id: 'a.txt', index: 1, data: Buffer.from('world').toString('base64'), final: true })
  assert.equal(writes.length, 1, 'file written exactly once')
  assert.equal(writes[0].b.toString(), 'helloworld', 'assembly NOT reset by the duplicate meta (chunks survived)')
})

test('P2-2: duplicate att-meta after completion is ignored (no second write / re-reservation)', () => {
  const { puller, writes } = makePuller()
  puller.maybeStart(() => {}, () => {})
  puller.onMessage({ type: 'att-meta', id: 'a.txt', size: 10, hash: 'h1' })
  puller.onMessage({ type: 'att-chunk', id: 'a.txt', index: 0, data: Buffer.from('helloworld'), final: true })
  assert.equal(writes.length, 1)
  // a second meta after completion would re-open + re-reserve under the old logic
  puller.onMessage({ type: 'att-meta', id: 'a.txt', size: 10, hash: 'h1' })
  puller.onMessage({ type: 'att-chunk', id: 'a.txt', index: 0, data: Buffer.from('helloworld'), final: true })
  assert.equal(writes.length, 1, 'still exactly one write — the duplicate was ignored')
})

/* ---------------- P2-3: UDP-learned addresses cannot outflank mDNS scoring ---------------- */

test('P2-3: a lower/equal-scored UDP announce keeps the stored host instead of flapping it', () => {
  const d = createDiscovery()
  // mDNS sighting with an address list (pickAdvertisedAddress picks 192.168.5.10)
  d._upsertPeer({ deviceId: 'p1', name: 'P1', port: 58471, host: 'mdns.example.lan', addresses: ['192.168.5.10'] })
  const first = d.getPeers()[0]
  assert.equal(first.host, '192.168.5.10')
  // UDP sighting (no addresses, rinfo.address only) — a scoped link-local IPv6 always scores 1
  // (lowest dialable), so this cannot win regardless of the machine's NICs; it must NOT overwrite
  // the stored host (the old code flapped the address on every 2s announce).
  d._upsertPeer({ deviceId: 'p1', name: 'P1', port: 58471, host: 'fe80::1234%eth1' })
  const second = d.getPeers()[0]
  assert.equal(second.host, '192.168.5.10', 'address unchanged by the UDP announcement')
  assert.ok(second.lastSeen >= first.lastSeen, 'the sighting still refreshed lastSeen')
})

/* ---------------- P2-4: over-cap segment is a terminal, diagnosable error ---------------- */

test('P2-4: packSegmentChunks refuses a single segment over the wire cap with a tagged error', () => {
  const big = { body: 'x'.repeat(100), fromSeq: 1, toSeq: 2 }
  try {
    packSegmentChunks([big], { maxSegmentBytes: 10 })
    assert.fail('must throw')
  } catch (err) {
    assert.equal(err.oversizedSegment, true, 'error carries the terminal tag the round maps to a peer error')
    assert.ok(/wire cap/.test(err.message), 'the message names the wire cap (diagnosable)')
  }
  // normal chunking untouched
  const chunks = packSegmentChunks([{ body: 'a', fromSeq: 1, toSeq: 1 }, { body: 'b', fromSeq: 2, toSeq: 2 }], { maxSegmentBytes: 10 })
  assert.equal(chunks.length, 1)
  assert.equal(chunks[0].final, true)
  assert.equal(WIRE_CAP_BYTES, 32 * 1024 * 1024)
})

test('P2-4: a real over-cap backlog fails the round terminally (no retry storm, clear peer error)', async () => {
  const server = createLanServer({ port: 0, host: '127.0.0.1', deviceId: 'peer', pairingSecret: SECRET, getHandler: () => {} })
  server.on('error', () => {})
  const port = await listen(server)
  const node = makeNode({
    buildSegments: () => [{ body: 'x'.repeat(33 * 1024 * 1024), fromSeq: 1, toSeq: 2 }], // > 32MB
  })
  const terminals = []
  node.on('round-error', e => { if (e.terminal) terminals.push(e.terminal) })
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port })

  await node.startSyncRound()
  assert.deepEqual(terminals, ['oversized-segment'], 'the round ends with the terminal oversized-segment tag')
  const st = node.getStatus()
  assert.ok(/wire cap/.test(st.peers[0].lastError || ''), 'Device Center lastError names the wire cap')
  assert.equal(st.peers[0].peerState, 'oversized-segment', 'structured terminal peer state')
  // The retry loop is STOPPED: a further startSyncRound does not even dial (no round-error, no storm).
  const before = terminals.length
  await node.startSyncRound()
  assert.equal(terminals.length, before, 'no new round attempted while the backlog still carries the oversized segment')
  await node.stop()
  await server.close()
})
