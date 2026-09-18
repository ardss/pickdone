/**
 * Per-peer push watermark regression tests (2026-09-19: live two-machine rounds
 * took 7-18s (later 70-220s) because `sync.peerWatermarks.v2` stayed "{}" on
 * BOTH machines — every round re-pushed the entire retained oplog window).
 *
 * Root cause pinned here: the wire envelope is {body, fromSeq, toSeq} — the rows
 * travel INSIDE the packed body, so `seg.rows` never exists. Both ack-path
 * accumulators (server-role.js acc.maxSeq for the push ack; index.js pullAckSeq
 * for the client's ack of the peer's push) iterated `seg.rows` and collected
 * nothing, so every ack omitted appliedToSeq, peerProgress/serverPullAck never
 * advanced, and rounds degenerated to full-window re-pushes.
 *
 * Invariants under test (REAL packed wire shape, not hand-built row arrays):
 *   1. round-1 ack populates the injected peerProgress map (sender seq space)
 *   2. round 2's push carries ONLY rows added since round 1 (incremental)
 *   3. the client's ack of the peer's push carries appliedToSeq (pull side)
 *   4. persistPeerWatermarks/createTrackedWatermarks round-trip through
 *      settings_rows 'sync.peerWatermarks.v2' (restart survival)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')
const bootstrap = require('../../../src/main/lan-sync-bootstrap.js')
const { pack, unpack } = await import('../../../shared/sync-core/segment.mjs')

const SECRET = 'wm-secret-1'

function fakeDiscovery() {
  return { startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] }
}

/**
 * Oplog-backed buildSegments emitting the REAL wire shape: rows packed into the
 * body, envelope {body, fromSeq, toSeq} (engine.buildSegments contract).
 */
function makeBuilder(oplog, deviceId) {
  return (since = 0) => {
    const rows = oplog.filter(r => r.seq > since)
    if (!rows.length) return []
    const maxSeq = Math.max(...rows.map(r => r.seq))
    const body = pack(rows, { fromSeq: since + 1, toSeq: maxSeq, deviceId })
    return [{ body, fromSeq: since + 1, toSeq: maxSeq }]
  }
}

test('watermark: round-1 ack populates the injected peerProgress map (packed-body wire shape)', async () => {
  const oplogA = [{ id: 'a1', seq: 1, content: 'x' }, { id: 'a2', seq: 2, content: 'y' }]
  const oplogB = [{ id: 'b1', seq: 10, content: 'z' }]
  const watermarks = new Map() // the SAME Map the bootstrap persists after each round

  const nodeA = createLanSyncNode({
    deviceId: 'node-a', name: 'Node A', pairingSecret: SECRET, port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    peerProgress: watermarks,
    ingestSegment: () => ({ applied: 0, rejected: 0 }),
    ingestSnapshot: () => {},
    buildSegments: makeBuilder(oplogA, 'node-a'),
  })
  const nodeB = createLanSyncNode({
    deviceId: 'node-b', name: 'Node B', pairingSecret: SECRET, port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: (seg) => { void unpack(typeof seg === 'object' && typeof seg.body === 'string' ? seg.body : seg) ; return { applied: 2, rejected: 0 } },
    ingestSnapshot: () => {},
    buildSegments: makeBuilder(oplogB, 'node-b'),
  })
  nodeA.start(); nodeB.start()
  const [portA, portB] = await Promise.all([nodeA.whenListening(), nodeB.whenListening()])
  nodeA.addPeer({ deviceId: 'node-b', host: '127.0.0.1', port: portB, name: 'Node B' })
  nodeB.addPeer({ deviceId: 'node-a', host: '127.0.0.1', port: portA, name: 'Node A' })

  const ok = await nodeA.startSyncRound()
  assert.ok(ok, 'round must be acked')
  assert.equal(watermarks.get('node-b'), 2, 'peerProgress must hold the acked appliedToSeq (sender seq space) despite the packed body having no seg.rows')

  await nodeA.stop(); await nodeB.stop()
})

test('watermark: round 2 pushes ONLY the incremental delta, not the full window', async () => {
  const oplogA = [{ id: 'a1', seq: 1, content: 'x' }, { id: 'a2', seq: 2, content: 'y' }]
  const oplogB = [{ id: 'b1', seq: 10, content: 'z' }]
  const watermarks = new Map()
  const pushedRounds = [] // per round: row ids node-b unpacked from node-a's push

  const ingestB = (seg) => {
    const env = unpack(typeof seg === 'object' && typeof seg.body === 'string' ? seg.body : seg)
    roundBIngest.push(...env.rows.map(r => r.id))
    return { applied: env.rows.length, rejected: 0 }
  }
  let roundBIngest = []

  const nodeA = createLanSyncNode({
    deviceId: 'node-a', name: 'Node A', pairingSecret: SECRET, port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    peerProgress: watermarks,
    ingestSegment: () => ({ applied: 0, rejected: 0 }),
    ingestSnapshot: () => {},
    buildSegments: makeBuilder(oplogA, 'node-a'),
  })
  const nodeB = createLanSyncNode({
    deviceId: 'node-b', name: 'Node B', pairingSecret: SECRET, port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: ingestB,
    ingestSnapshot: () => {},
    buildSegments: makeBuilder(oplogB, 'node-b'),
  })
  nodeA.start(); nodeB.start()
  const [portA, portB] = await Promise.all([nodeA.whenListening(), nodeB.whenListening()])
  nodeA.addPeer({ deviceId: 'node-b', host: '127.0.0.1', port: portB, name: 'Node B' })
  nodeB.addPeer({ deviceId: 'node-a', host: '127.0.0.1', port: portA, name: 'Node A' })

  await nodeA.startSyncRound()
  pushedRounds.push(roundBIngest); roundBIngest = []
  assert.deepEqual(pushedRounds[0].sort(), ['a1', 'a2'], 'round 1 carries the full window')

  // New local edit on A between rounds.
  oplogA.push({ id: 'a3', seq: 3, content: 'w' })
  const ok = await nodeA.startSyncRound()
  assert.ok(ok, 'round 2 must be acked')
  pushedRounds.push(roundBIngest); roundBIngest = []
  assert.deepEqual(pushedRounds[1], ['a3'], 'round 2 must push ONLY rows added since round 1 (watermark-gated)')

  await nodeA.stop(); await nodeB.stop()
})

test('watermark: client acks the peer\'s push with appliedToSeq so serverPullAck advances (pull side)', async () => {
  // nodeB records the appliedToSeq of every ack it receives (that value is what its
  // server role feeds back as serverPullAck on the NEXT round's pull response).
  const oplogA = [{ id: 'a1', seq: 1, content: 'x' }]
  const oplogB = [{ id: 'b1', seq: 41, content: 'z' }, { id: 'b2', seq: 42, content: 'w' }]
  const ackedFromA = []
  const ingestA = (seg) => {
    const env = unpack(typeof seg === 'object' && typeof seg.body === 'string' ? seg.body : seg)
    return { applied: env.rows.length, rejected: 0 }
  }
  // Wrap B's builder to record the `since` cursor its server role feeds each pull response:
  // round 1 must use the full window (unknown peer), round 2 must start past the acked seq.
  const buildCalls = []
  const origBuild = makeBuilder(oplogB, 'node-b')
  const wrappedBuild = (since) => { buildCalls.push(since); return origBuild(since) }
  const nodeB2 = createLanSyncNode({
    deviceId: 'node-b', name: 'Node B', pairingSecret: SECRET, port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: () => ({ applied: 0, rejected: 0 }),
    ingestSnapshot: () => {},
    buildSegments: wrappedBuild,
    getMaxSeq: () => 42, // B's oplog max (the defensive clamp needs it to trust the ack)
  })
  const nodeA = createLanSyncNode({
    deviceId: 'node-a', name: 'Node A', pairingSecret: SECRET, port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: ingestA,
    ingestSnapshot: () => {},
    buildSegments: makeBuilder(oplogA, 'node-a'),
  })
  nodeA.start(); nodeB2.start()
  const [portA, portB] = await Promise.all([nodeA.whenListening(), nodeB2.whenListening()])
  nodeA.addPeer({ deviceId: 'node-b', host: '127.0.0.1', port: portB, name: 'Node B' })
  nodeB2.addPeer({ deviceId: 'node-a', host: '127.0.0.1', port: portA, name: 'Node A' })

  await nodeA.startSyncRound()
  // Round 1: nodeB2's server pulls with no cursor (unknown peer) -> since undefined.
  const round1Since = buildCalls.at(-1)
  assert.equal(round1Since, undefined, 'round 1 pull starts from the full window (unknown peer)')

  // Round 2: nodeA acked nodeB2's push with appliedToSeq=42 (its rows' max seq, from the
  // packed envelope's toSeq). serverPullAck must now gate the pull response.
  await nodeA.startSyncRound()
  const round2Since = buildCalls.at(-1)
  assert.equal(round2Since, 42, 'round 2 pull must start past the acked appliedToSeq (42), not re-send the full window')
  void ackedFromA

  await nodeA.stop(); await nodeB2.stop()
})

test('watermark: persistPeerWatermarks writes the live map to settings_rows v2 key', () => {
  const settings = new Map()
  const db = {
    call (op, params) {
      if (op === 'settingsRowPut') { settings.set(params.key, params.value); return null }
      if (op === 'settingsRowsAll') {
        return [...settings.entries()].map(([key, value]) => ({ key, value, deleted: false }))
      }
      return null
    },
  }
  const watermarks = bootstrap.__test.createTrackedWatermarks()
  watermarks.set('peer-x', 42)
  bootstrap.__test.setState({ db, peerWatermarks: watermarks, node: null, timers: [] })
  bootstrap.__test.persistPeerWatermarks()
  assert.equal(settings.get('sync.peerWatermarks.v2'), JSON.stringify({ 'peer-x': 42 }))
})

test('watermark: createTrackedWatermarks seeds from persisted settings (restart survival)', () => {
  const settings = new Map([['sync.peerWatermarks.v2', JSON.stringify({ 'peer-y': 7 })]])
  const db = {
    call (op) {
      if (op === 'settingsRowsAll') {
        return [...settings.entries()].map(([key, value]) => ({ key, value, deleted: false }))
      }
      return null
    },
  }
  bootstrap.__test.setState({ db, peerWatermarks: new Map(), node: null, timers: [] })
  const seeded = bootstrap.__test.createTrackedWatermarks()
  assert.equal(seeded.get('peer-y'), 7, 'a restart must resume from the persisted per-peer watermark')
  assert.equal(typeof seeded.raw, 'function', 'the seeded map must expose raw() for persistence')
})
