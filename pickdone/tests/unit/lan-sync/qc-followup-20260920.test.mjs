/* QC follow-up round (branch fix/qc-followup-main, 2026-09-20) — lan-sync fixes:
 *   M-2 pairWith: a requested deviceId absent from discovery rejects with a structured
 *       PEER_NOT_FOUND error and NEVER dials a random peer;
 *   M-5 server-role: snapshot-request with NO builder replies snapshot-error 'no-builder'
 *       (fail fast) instead of a silent drop that burned the peer's 120s round deadline;
 *   M-6 transport: finish() re-entry guard — error+close emits 'peer-closed' exactly once;
 *   M-7 pair-nonce flood: FIFO eviction (oldest entry dropped) instead of clear() — the
 *       original nonce stays replay-rejected after 4096+ forged nonces;
 *   M-8 att-transfer: hash-mismatch/write-failure REFUNDS the round byte budget.
 * Run: node --test tests/unit/lan-sync/qc-followup-20260920.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')
const transport = require('../../../src/main/lan-sync/transport.js')
const cipher = require('../../../src/main/lan-sync/cipher.js')
const { deriveAuthCode } = require('../../../src/main/lan-sync/pairing.js')
const att = require('../../../src/main/lan-sync/att-transfer.js')
const { createServerRoleHandler } = require('../../../src/main/lan-sync/server-role.js')

const SECRET = 'qc-followup-secret'

function fakeDiscovery () {
  return { startAdvertising () {}, discover () {}, stop () {}, getPeers: () => [] }
}

test('M-2: pairWith with an undiscovered deviceId rejects structured and dials nothing', async () => {
  const node = createLanSyncNode({
    deviceId: 'qc-a', pairingSecret: SECRET, port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(), ingestSegment: () => {}, ingestSnapshot: () => {}, buildSegments: () => [],
  })
  node.start()
  await node.whenListening()
  // Only 'present-peer' is discovered — requesting 'ghost' must NOT fall back to dialing it.
  node.addPeer({ deviceId: 'present-peer', host: '127.0.0.1', port: 1 })
  // The rejection is SYNCHRONOUS and structured: a random-peer dial (the old fallback) would
  // instead attempt a TCP connect to the discovered peer and fail with a connect error.
  await assert.rejects(() => node.pairWith('ghost', '123456'), err => {
    assert.equal(err.code, 'PEER_NOT_FOUND')
    assert.equal(err.deviceId, 'ghost')
    return true
  })
  await node.stop()
})

test('M-2: pairWith still dials an EXACTLY matched peer (regression guard)', async () => {
  const node = createLanSyncNode({
    deviceId: 'qc-a2', pairingSecret: SECRET, port: 0, host: '127.0.0.1',
    discoverFn: fakeDiscovery(), ingestSegment: () => {}, ingestSnapshot: () => {}, buildSegments: () => [],
  })
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'exact', host: '127.0.0.1', port: 1 }) // nothing listens here → dial fails, but a dial HAPPENED
  await assert.rejects(() => node.pairWith('exact', '123456'), err => {
    assert.notEqual(err.code, 'PEER_NOT_FOUND')
    return true
  })
  await node.stop()
})

function fakeSocket () {
  const s = new EventEmitter()
  s.sent = []
  s.writable = true
  s.setEncoding = () => {}
  s.destroy = () => { s.destroyed = true }
  s.remoteAddress = '203.0.113.7'
  s.write = (chunk) => { s.sent.push(String(chunk)); return true }
  return s
}

const peerMsg = (over = {}) => ({ deviceId: 'srv', pairingSecret: SECRET, verifyPairingCode: () => false, ...over })

test('M-5: snapshot-request with no builder answers snapshot-error no-builder (no silent drop)', () => {
  const handle = createServerRoleHandler({
    ingestSegment: () => ({ applied: 0, rejected: 0 }),
    buildSegments: () => [],
    // buildSnapshot / buildSnapshotRows deliberately ABSENT (the M-5 scenario)
    serverSnapshotBusy: new Set(),
    serverPullAck: new Map(),
    pushRecent: () => {},
    onSnapshotError: () => {},
    onSnapshotSync: () => {},
    onServerError: () => {},
  })
  const socket = fakeSocket()
  const sent = []
  handle({ deviceId: 'p1' }, { type: 'snapshot-request' }, socket, (s, m) => sent.push(m)) // sendVia contract: (socket, msg)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].type, 'snapshot-error')
  assert.equal(sent[0].reason, 'no-builder')
})

test('M-6: wireConnection finish is re-entry safe — peer-closed fires exactly once', () => {
  const socket = fakeSocket()
  const closed = []
  socket.on('peer-closed', p => closed.push(p))
  transport.wireConnection(socket, peerMsg({
    deviceId: 'srv',
    onPeer: () => {},
  }))
  const hello = {
    type: 'hello', enc: 1, salt: cipher.randomToken(),
    deviceId: 'client-1', authCode: deriveAuthCode(SECRET, 'client-1'),
  }
  socket.emit('data', Buffer.from(JSON.stringify(hello) + '\n', 'utf8'))
  socket.emit('error', new Error('boom'))
  socket.emit('close')
  socket.emit('close')
  assert.equal(closed.length, 1, 'error+close+close must yield exactly one peer-closed (was 2 before the guard)')
  assert.equal(closed[0].deviceId, 'client-1')
})

test('M-7: 4096 forged pair nonces no longer clear the replay set — the original nonce stays rejected', () => {
  const seenPairNonces = new Map()
  const verifyCalls = []
  const common = peerMsg({
    seenPairNonces,
    verifyPairingCode: (code) => { verifyCalls.push(code); return false }, // never accepts: observation only
  })
  const originalNonce = cipher.randomToken()
  // 1) the original (capture-worthy) request: nonce is recorded, verify is reached
  const s0 = fakeSocket()
  transport.wireConnection(s0, common)
  s0.emit('data', Buffer.from(JSON.stringify({ type: 'pair-request', code: '000000', nonce: originalNonce, pub: 'ep' }) + '\n', 'utf8'))
  assert.equal(verifyCalls.length, 1, 'first request passes the nonce gate')

  // 2) flood with 4096 forged nonces (old code: size>=4096 → clear() → original lost)
  for (let i = 0; i < 4096; i++) {
    const s = fakeSocket()
    transport.wireConnection(s, common)
    s.emit('data', Buffer.from(JSON.stringify({ type: 'pair-request', code: '000000', nonce: cipher.randomToken(), pub: 'ep' }) + '\n', 'utf8'))
  }
  assert.equal(seenPairNonces.size, 4097, 'bounded memory: capped, and the ORIGINAL nonce is still inside the window')

  // 3) replay the ORIGINAL nonce: must be rejected at the nonce gate (verify NOT reached again)
  const verifyBeforeReplay = verifyCalls.length
  const sr = fakeSocket()
  transport.wireConnection(sr, common)
  sr.emit('data', Buffer.from(JSON.stringify({ type: 'pair-request', code: '000000', nonce: originalNonce, pub: 'ep' }) + '\n', 'utf8'))
  assert.equal(verifyCalls.length, verifyBeforeReplay, 'replayed nonce is rejected WITHOUT reaching code verification (replay protection survived the flood)')
  assert.ok(sr.destroyed, 'replay connection is destroyed')
  const ack = JSON.parse(String(sr.sent[0]).split('\n')[0])
  assert.equal(ack.type, 'pair-ack')
  assert.equal(ack.ok, false)

  // 4) the window stays bounded under a sustained flood (FIFO eviction works)
  for (let i = 0; i < 16384; i++) {
    const s = fakeSocket()
    transport.wireConnection(s, common)
    s.emit('data', Buffer.from(JSON.stringify({ type: 'pair-request', code: '000000', nonce: cipher.randomToken(), pub: 'ep' }) + '\n', 'utf8'))
  }
  assert.ok(seenPairNonces.size <= 8192, 'map never grows past the FIFO cap: ' + seenPairNonces.size)
})

test('M-8: hash-mismatch refunds the round byte budget so later files still fit', () => {
  const written = []
  const deps = {
    exists: key => written.some(w => w.key === key),
    size: () => 0,
    read: () => Buffer.alloc(0),
    writeAtomic: (key, buf) => { written.push({ key, buf }) },
    hashFn: buf => require('node:crypto').createHash('sha256').update(buf).digest('hex'),
  }
  const good = Buffer.from('good payload'.repeat(5)) // 55 bytes
  const bad = Buffer.from('corrupt'.repeat(10)) // 70 bytes
  const puller = att.createAttachmentPuller({
    deps, send: () => {}, peerId: 'p',
    maxFileBytes: 1024, maxBytes: 100, // tight budget: without the refund only ONE of the two fits
    session: { failed: new Map(), requests: new Map() },
  })
  // ONE batch containing both files: bad.bin (70B, wrong hash → refund) then good.bin (55B).
  puller.noteMissing(['bad.bin', 'good.bin'])
  let done = false
  assert.equal(puller.maybeStart(() => { done = true }, () => {}), true)
  // bad.bin with a WRONG hash → hash mismatch → markFailed → budget refunded
  assert.equal(puller.onMessage({ type: 'att-meta', id: 'bad.bin', size: bad.length, hash: 'deadbeef' }), true)
  assert.equal(puller.onMessage({ type: 'att-chunk', id: 'bad.bin', index: 0, data: bad.toString('base64'), final: true }), true)
  // good.bin must still pass the budget gate BECAUSE bad.bin's 70 bytes were refunded
  assert.equal(puller.onMessage({ type: 'att-meta', id: 'good.bin', size: good.length, hash: deps.hashFn(good) }), true)
  assert.equal(puller.onMessage({ type: 'att-chunk', id: 'good.bin', index: 0, data: good.toString('base64'), final: true }), true)
  assert.equal(puller.onMessage({ type: 'att-end' }), false)
  assert.ok(done, 'batch terminated cleanly')
  assert.ok(written.some(w => w.key === 'good.bin'), 'the second file landed because the failed file refunded its reserved bytes')
  assert.ok(!written.some(w => w.key === 'bad.bin'), 'the corrupt file was never written')
})
