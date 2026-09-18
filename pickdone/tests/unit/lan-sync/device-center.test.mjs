/**
 * Device Center regression tests (main-process half): enriched getStatus peers
 * (online / watermark / pendingCount), the recent + security rings, and the
 * two-way confirmed pairing flow (pair-request -> accept / reject / timeout,
 * plus pair-throttled surfacing into the security ring).
 *
 * Real TCP on 127.0.0.1 ephemeral ports, injected (fake) discovery — no mDNS,
 * no Electron. Follows the existing lan-sync test style (stub db/state not
 * needed here: these layers are pure Node).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')
const { createLanServer, connect } = require('../../../src/main/lan-sync/transport.js')

const SECRET = 'device-center-secret'

function fakeDiscovery() {
  return { startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] }
}

function makeNode(extra = {}) {
  return createLanSyncNode({
    deviceId: 'node-x',
    name: 'Node X',
    pairingSecret: SECRET,
    port: 0,
    host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: () => {},
    ingestSnapshot: () => {},
    buildSegments: () => [],
    ...extra,
  })
}

async function listen(server) {
  await new Promise((resolve) => server.on('listening', resolve))
  return server.port
}

test('device-center: getStatus exposes watermark + pendingCount + online per peer', async () => {
  // Peer server acks appliedToSeq=4 (its local max oplog seq after ingest).
  const peerServer = createLanServer({
    port: 0,
    host: '127.0.0.1',
    deviceId: 'peer',
    pairingSecret: SECRET,
    getHandler: () => (msg, socket) => {
      if (msg.type === 'segments') {
        socket.write(JSON.stringify({ type: 'ack', applied: msg.segments.length, rejected: 0, appliedToSeq: 4 }) + '\n')
      }
    },
  })
  const port = await listen(peerServer)

  const node = makeNode({
    deviceId: 'me',
    getMaxSeq: () => 10, // my local max oplog seq (bootstrap injects readMaxOplogSeq)
    buildSegments: () => [{ fromSeq: 1, toSeq: 1, deviceId: 'me', rows: [{ id: 'r1', seq: 1 }] }],
  })
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port, name: 'Peer' })

  const ok = await node.startSyncRound()
  assert.equal(ok.confirmed, 1)

  const st = node.getStatus()
  assert.equal(st.peers.length, 1)
  const p = st.peers[0]
  assert.equal(p.deviceId, 'peer')
  assert.equal(p.online, true, 'freshly discovered peer is online')
  assert.ok(p.lastRoundAt, 'lastRoundAt recorded')
  assert.equal(p.lastError, null)
  assert.equal(p.watermark, 4, 'watermark = peer acked appliedToSeq')
  assert.equal(p.pendingCount, 6, 'pendingCount = myMaxSeq(10) - watermark(4)')
  assert.equal(st.self.deviceId, 'me')
  assert.equal(st.self.deviceName, 'Node X')
  assert.equal(st.self.port, node.getStatus().port)
  assert.ok(Array.isArray(st.recent) && Array.isArray(st.security))

  // The confirmed round also landed in the recent ring with the ack count.
  const entry = st.recent.find(r => r.kind === 'push' && r.peer === 'peer')
  assert.ok(entry, 'round-done recorded into recent ring')
  assert.equal(entry.detail.applied, 1)

  await node.stop()
  await peerServer.close()
})

test('device-center: pendingCount is null without getMaxSeq injector', async () => {
  const node = makeNode()
  node.addPeer({ deviceId: 'ghost-peer', host: '127.0.0.1', port: 59999 })
  const p = node.getStatus().peers[0]
  assert.equal(p.pendingCount, null, 'no local max seq source -> honest null')
  assert.equal(p.watermark, null)
  await node.stop()
})

test('device-center: two-way pair-request -> accept completes pairing and rounds authenticate', async () => {
  const serverNode = makeNode({ deviceId: 'server-side', name: 'Server Side' })
  const pairedInbound = []
  serverNode.on('pair-request', (info) => {
    info.respond(true) // the human accepts
  })
  serverNode.on('paired-inbound', (info) => pairedInbound.push(info))
  serverNode.start()
  const serverPort = await serverNode.whenListening()

  const clientNode = makeNode({ deviceId: 'client-side', name: 'Client Side' })
  clientNode.start()

  const r = await clientNode.requestPair('127.0.0.1', serverPort)
  assert.equal(r.secret, SECRET, 'accept hands out the persisted pairing secret')

  // The server saw a confirmed inbound pairing and rang it up.
  assert.ok(pairedInbound.length === 1 && pairedInbound[0].confirmed === true)
  const pairEntry = serverNode.getStatus().recent.find(e => e.kind === 'pair')
  assert.ok(pairEntry, 'pairing recorded into recent ring')

  // With the adopted secret, a normal authenticated round succeeds (authCode derived
  // from the secret exactly as in the manual 6-digit flow).
  clientNode.addPeer({ deviceId: 'server-side', host: '127.0.0.1', port: serverPort, name: 'Server Side' })
  const ok = await clientNode.startSyncRound()
  assert.equal(ok.confirmed, 1, 'post-pairing round authenticates with the derived authCode')

  await clientNode.stop()
  await serverNode.stop()
})

test('device-center: pair-request reject closes the connection and surfaces pair-rejected', async () => {
  const serverNode = makeNode({ deviceId: 'server-side', name: 'Server Side' })
  serverNode.on('pair-request', (info) => info.respond(false))
  const rejectedEvents = []
  serverNode.on('pair-rejected', () => {}) // server side never emits this; client does
  serverNode.start()
  const serverPort = await serverNode.whenListening()

  const clientNode = makeNode({ deviceId: 'client-side', name: 'Client Side' })
  clientNode.on('pair-rejected', (info) => rejectedEvents.push(info))
  clientNode.start()

  await assert.rejects(() => clientNode.requestPair('127.0.0.1', serverPort), /pairing rejected/)
  assert.equal(rejectedEvents.length, 1)
  assert.equal(rejectedEvents[0].reason, 'rejected')
  assert.equal(rejectedEvents[0].host, '127.0.0.1')

  await clientNode.stop()
  await serverNode.stop()
})

test('device-center: unanswered pair-request auto-rejects after the confirm window', async () => {
  const serverNode = makeNode({ deviceId: 'server-side', name: 'Server Side', pairConfirmTimeoutMs: 60 })
  serverNode.start() // no pair-request listener accepts: transport owns the auto-reject timer
  const serverPort = await serverNode.whenListening()

  const clientNode = makeNode({ deviceId: 'client-side', name: 'Client Side' })
  clientNode.start()
  await assert.rejects(() => clientNode.requestPair('127.0.0.1', serverPort), /pairing rejected/)
  await clientNode.stop()
  await serverNode.stop()
})

test('device-center: pair-throttled surfaces into the security ring', async () => {
  const serverNode = makeNode({ deviceId: 'server-side', name: 'Server Side' })
  const throttled = []
  serverNode.on('pair-throttled', (info) => throttled.push(info))
  serverNode.start()
  const serverPort = await serverNode.whenListening()

  // Six manual-code attempts (always wrong: no verifyPairingCode configured) from one IP;
  // the sliding window allows 5, the 6th must be throttled server-side.
  for (let i = 0; i < 6; i++) {
    await new Promise((resolve) => {
      const client = connect('127.0.0.1', serverPort, { deviceId: 'guesser', pairCode: '000000', timeoutMs: 3000 })
      client.on('rejected', () => resolve())
      client.on('error', () => resolve())
      client.on('close', () => resolve())
    })
  }

  const sec = serverNode.getStatus().security
  assert.equal(throttled.length, 1, 'exactly the over-limit attempt is throttled')
  const entry = sec.find(s => s.reason === 'pair-throttled')
  assert.ok(entry, 'throttle recorded into security ring')
  assert.equal(entry.ip, '127.0.0.1')

  await serverNode.stop()
})

test('device-center: recent ring is capped at 50 entries', async () => {
  const node = makeNode()
  node.start()
  await node.whenListening()
  // Dead port: every round errors immediately (ECONNREFUSED on loopback) and pushes
  // one 'error' entry into the recent ring.
  node.addPeer({ deviceId: 'dead', host: '127.0.0.1', port: 1 })
  for (let i = 0; i < 55; i++) await node.startSyncRound()

  const st = node.getStatus()
  assert.equal(st.recent.length, 50, 'ring keeps exactly the last 50')
  assert.ok(st.recent.every(e => e.kind === 'error' && e.peer === 'dead'))
  assert.equal(st.security.length, 0, 'round errors are activity, not security events')

  await node.stop()
})
