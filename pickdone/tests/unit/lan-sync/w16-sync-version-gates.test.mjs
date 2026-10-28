/**
 * W16 (2026-10-28) sync version-compatibility gates — regression tests:
 *   1. protoVer ENFORCEMENT, server side: hello outside [MIN_PROTO_VER, PROTO_VER] is refused
 *      with a DISTINCT reason ('peer too new' / 'peer too old'); the structured code rides the
 *      existing onUnauthorized face. A legacy hello with NO protoVer counts as too old.
 *   2. protoVer ENFORCEMENT, dialer side: a hello-ack echoing an out-of-window protoVer is
 *      refused BEFORE any data flows, with the same structured codes.
 *   3. hello appVersion: the dialer advertises its app build; the server stores it on
 *      state.peer and delivers it through onPeer.
 *   4. snapshot schemaVersion REJECT gate: a snapshot whose schemaVersion exceeds the local
 *      SYNC_SCHEMA_VERSION rejects the WHOLE round — streaming chunks and the assembled
 *      snapshot-end path both refuse before anything reaches ingest.
 *
 * Real TCP loopback + real crypto, same harness shape as encryption.test.mjs.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanServer, connect, PROTO_VER, MIN_PROTO_VER } = require('../../../src/main/lan-sync/transport.js')
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')
const { deriveAuthCode } = require('../../../src/main/lan-sync/pairing.js')
const cipher = require('../../../src/main/lan-sync/cipher.js')

const SECRET = 'w16-version-gate-secret'
const SERVER_DEVICE = 'w16-server'
const CLIENT_DEVICE = 'w16-client'

const listen = (server) => new Promise((resolve) => server.on('listening', resolve))
/** Deterministic quiesce: two setImmediate drains let cross-socket events settle. */
const settle = () => new Promise((r) => setImmediate(() => setImmediate(r)))

/** Raw-socket client: manual hello, returns the parsed hello-ack. */
async function openRaw (port, authCode, helloExtra = {}) {
  const sock = net.createConnection({ host: '127.0.0.1', port })
  await new Promise((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject) })
  const ackText = await new Promise((resolve) => {
    let buf = ''
    sock.setEncoding('utf8')
    const onData = (d) => {
      buf += d
      const i = buf.indexOf('\n')
      if (i !== -1) { sock.off('data', onData); resolve(buf.slice(0, i)) }
    }
    sock.on('data', onData)
    sock.write(JSON.stringify({ type: 'hello', deviceId: CLIENT_DEVICE, protoVer: 2, authCode, enc: 1, salt: cipher.randomToken(), ...helloExtra }) + '\n')
  })
  let ack = null
  try { ack = JSON.parse(ackText) } catch { /* leave null */ }
  const closed = new Promise((resolve) => sock.once('close', resolve))
  return { sock, ack, closed }
}

/** Fake peer server: answers EVERY hello line with the given ack object. */
async function fakeAckServer (ack) {
  const server = net.createServer((sock) => {
    let buf = ''
    sock.on('data', (d) => {
      buf += d.toString('utf8')
      const i = buf.indexOf('\n')
      if (i !== -1) sock.write(JSON.stringify(ack) + '\n')
    })
  })
  const listening = listen(server)
  server.listen(0, '127.0.0.1')
  await listening
  const port = server.address().port
  return { server, port, close: () => new Promise((r) => server.close(r)) }
}

const row = (id) => ({ entity: 'todo', id, updatedAt: 1, deleted: false, deletedAt: 0, data: { taskId: id, taskContent: 'w16 ' + id } })

test('W16: server refuses hello with protoVer ABOVE its own (peer-too-new), distinct reason + structured code', async () => {
  const unauthorized = []
  const server = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: SERVER_DEVICE, pairingSecret: SECRET,
    getHandler: () => () => {},
    onUnauthorized: (info) => unauthorized.push(info),
  })
  const port = await listen(server)
  try {
    const raw = await openRaw(port, deriveAuthCode(SECRET, CLIENT_DEVICE), { protoVer: PROTO_VER + 1 })
    assert.equal(raw.ack && raw.ack.ok, false, 'handshake refused')
    assert.equal(raw.ack.error, 'peer too new', 'distinct wire reason')
    await raw.closed
    await settle()
    assert.equal(unauthorized.length, 1, 'onUnauthorized fired exactly once')
    assert.equal(unauthorized[0].code, 'peer-too-new')
    assert.equal(unauthorized[0].peerProtoVer, PROTO_VER + 1)
    assert.equal(unauthorized[0].deviceId, CLIENT_DEVICE)
  } finally { await server.close() }
})

test('W16: server refuses hello with protoVer BELOW MIN_PROTO_VER, and a MISSING protoVer (legacy shape) counts as too old', async () => {
  const unauthorized = []
  const server = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: SERVER_DEVICE, pairingSecret: SECRET,
    getHandler: () => () => {},
    onUnauthorized: (info) => unauthorized.push(info),
  })
  const port = await listen(server)
  try {
    const old = await openRaw(port, deriveAuthCode(SECRET, CLIENT_DEVICE), { protoVer: MIN_PROTO_VER - 1 })
    assert.equal(old.ack && old.ack.ok, false)
    assert.equal(old.ack.error, 'peer too old')
    await old.closed

    const legacy = await openRaw(port, deriveAuthCode(SECRET, CLIENT_DEVICE), { protoVer: undefined })
    assert.equal(legacy.ack && legacy.ack.ok, false, 'hello without protoVer refused')
    assert.equal(legacy.ack.error, 'peer too old', 'legacy no-protoVer hello = below MIN_PROTO_VER')
    await legacy.closed
    await settle()
    assert.deepEqual(unauthorized.map((u) => u.code), ['peer-too-old', 'peer-too-old'])
    assert.equal(unauthorized[1].peerProtoVer, null, 'absent protoVer reported as null')
  } finally { await server.close() }
})

test('W16: control — a peer AT the current protoVer still completes the encrypted handshake', async () => {
  const unauthorized = []
  const server = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: SERVER_DEVICE, pairingSecret: SECRET,
    getHandler: () => () => {},
    onUnauthorized: (info) => unauthorized.push(info),
  })
  const port = await listen(server)
  try {
    const raw = await openRaw(port, deriveAuthCode(SECRET, CLIENT_DEVICE))
    assert.equal(raw.ack && raw.ack.ok, true, 'current-version peer accepted')
    await settle()
    assert.equal(unauthorized.length, 0, 'no unauthorized for a current-version peer')
  } finally { await server.close() }
})

test('W16: dialer refuses a hello-ack whose echoed protoVer is out of window (too new / too old), structured code + no ready', async () => {
  const cases = [
    { ack: { type: 'hello-ack', ok: true, protoVer: PROTO_VER + 1, enc: 1 }, code: 'peer-too-new' },
    { ack: { type: 'hello-ack', ok: true, protoVer: MIN_PROTO_VER - 1, enc: 1 }, code: 'peer-too-old' },
    { ack: { type: 'hello-ack', ok: true, enc: 1 }, code: 'peer-too-old' }, // legacy ack, no protoVer
  ]
  for (const c of cases) {
    const fake = await fakeAckServer(c.ack)
    const rejected = []
    const unauthorized = []
    const ready = []
    try {
      const em = connect('127.0.0.1', fake.port, {
        deviceId: CLIENT_DEVICE, authCode: deriveAuthCode(SECRET, CLIENT_DEVICE), pairingSecret: SECRET,
        onUnauthorized: (info) => unauthorized.push(info),
      })
      em.on('ready', (m) => ready.push(m))
      em.on('rejected', (m) => rejected.push(m))
      await new Promise((resolve) => em.on('close', resolve))
      assert.equal(ready.length, 0, 'no ready for out-of-window peer ack')
      assert.equal(rejected.length, 1)
      assert.equal(rejected[0].code, c.code, `structured code for ack protoVer ${c.ack.protoVer}`)
      assert.equal(unauthorized.length, 1, 'onUnauthorized fired with the code')
      assert.equal(unauthorized[0].code, c.code)
    } finally { await fake.close() }
  }
})

test('W16: hello advertises appVersion; the peer-connected surface carries it', async () => {
  let peerSeen = null
  // The full node: index.js wires onPeer -> em 'peer-connected' — the app-facing peer-info face.
  const serverNode = createLanSyncNode({
    deviceId: SERVER_DEVICE, name: 'W16AV', pairingSecret: SECRET, port: 0, host: '127.0.0.1',
    discoverFn: { startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] },
    ingestSegment: () => ({ applied: 0, rejected: 0 }),
    ingestSnapshot: () => {},
    buildSegments: () => [],
  })
  serverNode.on('peer-connected', (p) => { peerSeen = p })
  serverNode.start()
  const port = await serverNode.whenListening()
  try {
    const em = connect('127.0.0.1', port, {
      deviceId: CLIENT_DEVICE, authCode: deriveAuthCode(SECRET, CLIENT_DEVICE), pairingSecret: SECRET,
    })
    await new Promise((resolve, reject) => { em.once('ready', resolve); em.once('close', () => reject(new Error('closed before ready'))) })
    const pkgVersion = String(require('../../../package.json').version || '')
    await em.close()
    await settle()
    assert.ok(peerSeen, 'peer-connected delivered the peer record')
    assert.equal(peerSeen.appVersion, pkgVersion, 'hello carried our app version; state.peer stores it')
    assert.equal(peerSeen.protoVer, PROTO_VER)
  } finally { await serverNode.stop() }
})

/** Scripted fake peer (same style as fix-20261009-snapshot-empty-epoch-reset.test.mjs):
 *  round 1: ack advertises oldestSeq > wm+1 -> arms the snapshot trigger
 *  round 2: on snapshot-request serve the scripted chunk/end messages. */
function scriptedPeer ({ chunkSchema, endSchema, rows }) {
  let phase = 0
  const server = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: SERVER_DEVICE, pairingSecret: SECRET,
    getHandler: () => (msg, socket) => {
      if (msg.type === 'segments-chunk') {
        phase += 1
        socket._lanSend({ type: 'ack', applied: 0, rejected: 0, oldestSeq: 50 })
      } else if (msg.type === 'snapshot-request' && phase >= 1) {
        phase += 1
        for (let i = 0; i < rows.length; i += 1) {
          socket._lanSend({ type: 'snapshot-chunk', index: i, totalChunks: rows.length, schemaVersion: chunkSchema, rows: [rows[i]] })
        }
        socket._lanSend({ type: 'snapshot-end', totalChunks: rows.length, totalRows: rows.length, cursor: 100, schemaVersion: endSchema })
      }
    },
  })
  return server
}

test('W16: snapshot with schemaVersion GREATER than local SYNC_SCHEMA_VERSION rejects the round — streaming path ingests nothing', async () => {
  const ingestedChunks = []
  const roundErrors = []
  const peer = scriptedPeer({ chunkSchema: 2, endSchema: 2, rows: [row('s1'), row('s2')] })
  const peerPort = await listen(peer)

  const clientNode = createLanSyncNode({
    deviceId: CLIENT_DEVICE, name: 'W16C', pairingSecret: SECRET, port: 0, host: '127.0.0.1',
    discoverFn: { startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] },
    ingestSegment: (seg) => ({ applied: seg.rows ? seg.rows.length : 0, rejected: 0 }),
    ingestSnapshot: () => {},
    // Streaming receiver: chunks flow through ingestSnapshotChunk — the gate must fire there.
    ingestSnapshotChunk: (chunk) => { ingestedChunks.push(chunk) },
    buildSegments: () => [],
  })
  clientNode.on('round-error', (e) => roundErrors.push(e))
  clientNode.start()
  await clientNode.whenListening()
  clientNode.addPeer({ deviceId: SERVER_DEVICE, host: '127.0.0.1', port: peerPort, secret: SECRET })
  try {
    await clientNode.startSyncRound() // round 1: arms the snapshot trigger (oldestSeq 50)
    const r = await clientNode.startSyncRound() // round 2: snapshot with a FUTURE schema
    assert.equal(r.confirmed, 0, 'round NOT confirmed')
    assert.equal(ingestedChunks.length, 0, 'NO chunk reached ingestSnapshotChunk')
    assert.ok(roundErrors.length >= 1, 'round-error emitted')
    assert.equal(roundErrors[roundErrors.length - 1].code, 'snapshot-schema-too-new', 'structured code on the round-error payload')
  } finally {
    await clientNode.stop()
    await peer.close()
  }
})

test('W16: snapshot-end with schemaVersion GREATER than local rejects BEFORE finalize — assembled path ingests nothing', async () => {
  const ingestedSnapshots = []
  const roundErrors = []
  const peer = scriptedPeer({ chunkSchema: 1, endSchema: 99, rows: [row('f1')] })
  const peerPort = await listen(peer)

  const clientNode = createLanSyncNode({
    deviceId: CLIENT_DEVICE, name: 'W16C2', pairingSecret: SECRET, port: 0, host: '127.0.0.1',
    discoverFn: { startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] },
    ingestSegment: (seg) => ({ applied: seg.rows ? seg.rows.length : 0, rejected: 0 }),
    // NO ingestSnapshotChunk: fallback assembly path — the gate must fire at snapshot-end.
    ingestSnapshot: (snap) => { ingestedSnapshots.push(snap) },
    buildSegments: () => [],
  })
  clientNode.on('round-error', (e) => roundErrors.push(e))
  clientNode.start()
  await clientNode.whenListening()
  clientNode.addPeer({ deviceId: SERVER_DEVICE, host: '127.0.0.1', port: peerPort, secret: SECRET })
  try {
    await clientNode.startSyncRound() // round 1: arms the snapshot trigger
    const r = await clientNode.startSyncRound() // round 2: snapshot-end with a FUTURE schema
    assert.equal(r.confirmed, 0, 'round NOT confirmed')
    assert.equal(ingestedSnapshots.length, 0, 'NO assembled snapshot reached ingestSnapshot')
    assert.ok(roundErrors.length >= 1)
    assert.equal(roundErrors[roundErrors.length - 1].code, 'snapshot-schema-too-new')
  } finally {
    await clientNode.stop()
    await peer.close()
  }
})

test('W16: control — a CURRENT-schemaVersion snapshot still completes the round end-to-end', async () => {
  const ingestedChunks = []
  const roundErrors = []
  const peer = scriptedPeer({ chunkSchema: 1, endSchema: 1, rows: [row('ok1'), row('ok2')] })
  const peerPort = await listen(peer)

  const clientNode = createLanSyncNode({
    deviceId: CLIENT_DEVICE, name: 'W16C3', pairingSecret: SECRET, port: 0, host: '127.0.0.1',
    discoverFn: { startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] },
    ingestSegment: (seg) => ({ applied: seg.rows ? seg.rows.length : 0, rejected: 0 }),
    ingestSnapshot: () => {},
    ingestSnapshotChunk: (chunk) => { ingestedChunks.push(chunk) },
    buildSegments: () => [],
  })
  clientNode.on('round-error', (e) => roundErrors.push(e))
  clientNode.start()
  await clientNode.whenListening()
  clientNode.addPeer({ deviceId: SERVER_DEVICE, host: '127.0.0.1', port: peerPort, secret: SECRET })
  try {
    await clientNode.startSyncRound() // round 1: arms the snapshot trigger
    const r = await clientNode.startSyncRound() // round 2: current-schema snapshot flows
    assert.equal(r.confirmed, 1, 'current-schema snapshot round confirmed')
    assert.equal(ingestedChunks.length, 2, 'both chunk rows ingested')
    assert.equal(roundErrors.length, 0, 'no round-error')
  } finally {
    await clientNode.stop()
    await peer.close()
  }
})
