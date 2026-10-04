/**
 * D17 (2026-10-02) — pairing lost-frame cluster in transport.js.
 *
 * P1: the pair-accept / pair-reject replies were destroyed-destroyed immediately after send —
 * frames still in the write buffer were DISCARDED, and onPaired (which persists the per-pair
 * secret) fired even when the frame never left (dead socket / refused write), minting a
 * permanent auth-dead pairing. Now: send return is checked, onPaired fires only on a
 * successfully handed-off frame, and the socket is destroyed AFTER the flush (end() discipline,
 * same as connect()'s em.close).
 *
 * P3: the client dial timeout emitted 'close' twice (manual emit + socket 'close' handler).
 *
 * Run: node --test tests/unit/lan-sync/d17-pairing-flush.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const transport = require('../../../src/main/lan-sync/transport.js')
const cipher = require('../../../src/main/lan-sync/cipher.js')
const { wireConnection } = transport

/** Minimal socket double for wireConnection: records writes, no real network. */
function fakeSocket ({ destroyed = false, writeResult = true } = {}) {
  const s = new EventEmitter()
  s.remoteAddress = '127.0.0.1'
  s.destroyed = destroyed
  s.writable = !destroyed
  s.written = []
  s.ended = false
  s.write = (data) => { s.written.push(String(data)); return writeResult }
  s.end = (cb) => { s.ended = true; s.writable = false; if (typeof cb === 'function') cb(); setImmediate(() => s.emit('close')); return s }
  s.destroy = () => { s.destroyed = true; s.emit('close') }
  s.setTimeout = () => {}
  s.setEncoding = () => {}
  return s
}

function pairRequestLine ({ code } = {}) {
  const eph = cipher.createPairEphemeral()
  return JSON.stringify({
    type: 'pair-request',
    deviceId: 'device-client',
    ...(code !== undefined ? { code } : { deviceName: 'Client Machine' }),
    nonce: cipher.randomToken(),
    pub: eph.pub,
  }) + '\n'
}

test('P1: manual pairing — a refused write (socket backpressure) must NOT record the pair', async () => {
  let pairedCalls = 0
  const socket = fakeSocket({ writeResult: false }) // kernel/user-space write refused
  wireConnection(socket, {
    deviceId: 'device-server',
    verifyPairingCode: () => true,
    onPaired: () => { pairedCalls++ },
  })
  socket.emit('data', pairRequestLine({ code: '123456' }))
  assert.equal(pairedCalls, 0, 'red before the fix: onPaired fired even though the accept frame was never handed to the socket')
  await new Promise((r) => setTimeout(r, 20))
  for (let t = 0; t < 40 && !socket.destroyed; t++) await new Promise((r) => setTimeout(r, 50)) // poll: flush-then-destroy may legally take up to its 1s cap under load
  assert.equal(socket.destroyed, true, 'the dead flow is still torn down')
})

test('P1: manual pairing — onPaired fires only when the accept frame is actually written, and the socket flushes before destroy', async () => {
  let pairedCalls = 0
  const socket = fakeSocket({ writeResult: true })
  wireConnection(socket, {
    deviceId: 'device-server',
    verifyPairingCode: () => true,
    onPaired: () => { pairedCalls++ },
  })
  socket.emit('data', pairRequestLine({ code: '123456' }))
  assert.equal(pairedCalls, 1, 'a delivered accept still records the pair')
  assert.equal(socket.ended, true, 'the accept frame is flushed (end) instead of being destroyed away')
  // The challenge (handshake boundary) stays plaintext on the wire; the accept itself is an
  // ENCRYPTED frame — its delivery is proven by onPaired firing (sendEnc's true return).
  assert.equal(socket.written.some(d => d.includes('"pair-challenge"')), true, 'the plaintext challenge preceded the encrypted accept')
  assert.ok(socket.written.length >= 2, 'the encrypted pair-accept frame followed the challenge')
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(socket.destroyed, true, 'the flow tears the socket down after the flush')
})

test('P2: two-way accept clicked after the requester socket died must NOT persist a half-pairing', () => {
  let respond = null
  const socket = fakeSocket()
  wireConnection(socket, {
    deviceId: 'device-server',
    onPairRequest: (req) => { respond = req.respond },
  })
  socket.emit('data', pairRequestLine()) // two-way (no code)
  assert.equal(typeof respond, 'function', 'the decision dialog got its respond hook')
  socket.destroyed = true // requester walked away mid-window
  socket.writable = false
  respond(true)
  assert.ok(!socket.written.some(d => d.includes('pair-accept')), 'no accept frame can be produced onto a dead socket')
  assert.equal(socket.ended, false, 'flush-then-destroy degrades to immediate destroy on a dead socket')
  assert.equal(socket.destroyed, true, 'the half-pairing flow is torn down instead of persisting')
})

test('P1: two-way reject is written and the socket flushes (the reject frame is no longer destroyed away)', () => {
  const pairedCalls = 0
  let respond = null
  const socket = fakeSocket({ writeResult: true })
  wireConnection(socket, {
    deviceId: 'device-server',
    onPairRequest: (req) => { respond = req.respond },
  })
  socket.emit('data', pairRequestLine())
  respond(false)
  assert.equal(pairedCalls, 0, 'a reject never records a pair')
  assert.equal(socket.written.some(d => d.includes('"pair-reject"')), true, 'the pair-reject frame was handed to the socket')
  assert.equal(socket.ended, true, 'the reject flushes before destroy')
})

test('P3: a dial timeout emits close exactly once', async () => {
  const server = transport.createLanServer({
    port: 0, host: '127.0.0.1', deviceId: 'device-server', pairingSecret: 's',
    getHandler: () => () => {},
  })
  const port = await new Promise((resolve) => server.on('listening', resolve))
  try {
    const closes = []
    const client = transport.connect('127.0.0.1', port, {
      deviceId: 'device-client',
      authCode: 'irrelevant', // server never answers: the dial deadline fires
      pairingSecret: 's',
      timeoutMs: 80,
    })
    // Deliberately NO 'error' listener: the guarded timeout path emits 'close' as the contract.
    client.on('close', () => closes.push(1))
    await new Promise((r) => setTimeout(r, 400))
    assert.equal(closes.length, 1, `red before the fix: close emitted ${closes.length} times (manual timeout emit + socket close handler)`)
  } finally {
    await server.close()
  }
})
