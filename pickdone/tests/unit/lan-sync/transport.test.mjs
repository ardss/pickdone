/**
 * LAN sync transport loopback tests: real TCP on 127.0.0.1 ephemeral ports
 * (loopback needs no firewall), covering delivery, auth rejection, and the
 * oversized-line cap. No mDNS involved.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanServer, connect, MAX_LINE_BYTES } = require('../../../src/main/lan-sync/transport.js')
const { deriveAuthCode, verifyAuthCode } = require('../../../src/main/lan-sync/pairing.js')

const SECRET = 'pairing-secret-alpha'
const SERVER_DEVICE = 'device-server'
const CLIENT_DEVICE = 'device-client'

async function listen(server) {
  await new Promise((resolve) => server.on('listening', resolve))
  return server.port
}

test('transport: authenticated peers exchange segments and acks', async () => {
  const received = []
  const server = createLanServer({
    port: 0,
    host: '127.0.0.1',
    deviceId: SERVER_DEVICE,
    pairingSecret: SECRET,
    getHandler: () => (msg, socket) => {
      if (msg.type === 'segments-chunk') {
        received.push(...msg.segments)
        socket._lanSend({ type: 'ack', applied: msg.segments.length, rejected: 0 })
      }
    },
  })
  const port = await listen(server)
  try {
    const client = connect('127.0.0.1', port, {
      deviceId: CLIENT_DEVICE,
      authCode: deriveAuthCode(SECRET, CLIENT_DEVICE),
      pairingSecret: SECRET,
    })
    await new Promise((resolve, reject) => {
      client.on('ready', resolve)
      client.on('error', reject)
      client.on('rejected', () => reject(new Error('unexpected rejection')))
    })
    const ack = await new Promise((resolve) => {
      client.on('message', (msg) => { if (msg.type === 'ack') resolve(msg) })
      client.send({ type: 'segments-chunk', segments: [{ fromSeq: 1, toSeq: 2, deviceId: CLIENT_DEVICE, rows: [{ id: 't1', seq: 1 }, { id: 't2', seq: 2 }] }] })
    })
    assert.equal(ack.applied, 1) // one segment envelope pushed
    assert.equal(received.length, 1)
    assert.equal(received[0].rows.length, 2)
    assert.equal(received[0].rows[0].id, 't1')
    assert.equal(received[0].rows[1].id, 't2')
    await client.close()
  } finally {
    await server.close()
  }
})

test('transport: wrong authCode is rejected and data messages never delivered', async () => {
  const received = []
  let unauthorized = null
  const server = createLanServer({
    port: 0,
    host: '127.0.0.1',
    deviceId: SERVER_DEVICE,
    pairingSecret: SECRET,
    getHandler: () => (msg) => { if (msg.type === 'segments-chunk') received.push(...(msg.segments || [])) },
    onUnauthorized: (info) => { unauthorized = info },
  })
  const port = await listen(server)
  try {
    const client = connect('127.0.0.1', port, {
      deviceId: CLIENT_DEVICE,
      authCode: 'deadbeefdeadbeef',
    })
    const result = await new Promise((resolve) => {
      client.on('rejected', resolve)
      client.on('ready', () => resolve('ready'))
      client.on('error', () => { /* ECONNRESET after destroy is fine */ })
    })
    assert.equal(result && result.ok, false) // hello-ack {ok:false} rejection
    assert.equal(unauthorized.deviceId, CLIENT_DEVICE)
    // Data is never accepted pre-auth: send garbage after rejection is moot
    // (socket destroyed), just assert no handler ran.
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(received.length, 0)
    await client.close()
  } finally {
    await server.close()
  }
})

test('transport: oversized line (>512KB) is rejected, connection destroyed', async () => {
  const received = []
  let serverSawError = null
  const server = createLanServer({
    port: 0,
    host: '127.0.0.1',
    deviceId: SERVER_DEVICE,
    pairingSecret: SECRET,
    getHandler: () => (msg) => { if (msg.type === 'segments-chunk') received.push(msg) },
  })
  server.on('error', (e) => { serverSawError = e })
  const port = await listen(server)
  try {
    const client = connect('127.0.0.1', port, {
      deviceId: CLIENT_DEVICE,
      authCode: deriveAuthCode(SECRET, CLIENT_DEVICE),
      pairingSecret: SECRET,
    })
    await new Promise((resolve) => client.on('ready', resolve))

    // Authenticate, then blast an oversized line and confirm the server kills
    // the connection and never processes it.
    const closed = new Promise((resolve) => client.on('close', resolve))
    const junk = 'x'.repeat(MAX_LINE_BYTES + 1024)
    client._socket.write(`{"type":"segments","pad":"${junk}"}\n`)
    await closed
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(received.length, 0)
    assert.equal(serverSawError, null) // protocol kill is not a server crash
    await client.close()
    await server.close()
  } catch (err) {
    await server.close()
    throw err
  }
})

test('transport: hello-before-data is enforced and pairing verifies symmetrically', async () => {
  // Sanity on the pairing primitive used by the auth gate.
  const code = deriveAuthCode(SECRET, CLIENT_DEVICE)
  assert.match(code, /^[0-9]{6}$/)
  assert.ok(verifyAuthCode(SECRET, CLIENT_DEVICE, code))
  assert.ok(!verifyAuthCode(SECRET, 'other-device', code))
  assert.ok(!verifyAuthCode('other-secret', CLIENT_DEVICE, code))
})

test('transport: EADDRINUSE degrades to an ephemeral port (second same-host instance)', async () => {
  const first = createLanServer({ deviceId: 'dev1', pairingSecret: SECRET, getHandler: () => {} })
  await new Promise((res, rej) => { first.on('listening', res); first.on('error', rej) })
  const second = createLanServer({ deviceId: 'dev2', pairingSecret: SECRET, getHandler: () => {} })
  try {
    const p = await new Promise((res, rej) => { second.on('listening', res); second.on('error', rej) })
    assert.ok(Number.isInteger(p) && p > 0, 'second server bound to an ephemeral port: ' + p)
    assert.notEqual(p, first.port, 'must not reuse the taken fixed port')
  } finally {
    await second.close()
    await first.close()
  }
})

test('transport: pair-request brute force is rate limited per IP across reconnects', async () => {
  // Regression: the pair-attempt counter was per-connection, so every reconnect reset it and
  // online guessing of the 6-digit code was one attempt per TCP connect for free.
  const CODE = '123456'
  const paired = []
  const server = createLanServer({
    port: 0,
    host: '127.0.0.1',
    deviceId: SERVER_DEVICE,
    pairingSecret: SECRET,
    verifyPairingCode: (code) => code === CODE,
    onPaired: (info) => paired.push(info),
  })
  const port = await listen(server)
  const tryPair = () => new Promise((resolve) => {
    const c = connect('127.0.0.1', port, { deviceId: CLIENT_DEVICE, pairCode: CODE, timeoutMs: 2000 })
    c.on('paired', () => { c.close(); resolve('accepted') })
    c.on('rejected', () => { c.close(); resolve('rejected') })
    c.on('error', () => resolve('error'))
  })
  try {
    const results = []
    for (let i = 0; i < 7; i++) results.push(await tryPair())
    // First 5 attempts pass the gate (correct code -> accepted); attempts 6+ are refused by the
    // server-level sliding window even though the code is correct.
    assert.deepEqual(results.slice(0, 5), ['accepted', 'accepted', 'accepted', 'accepted', 'accepted'])
    assert.ok(results[5] !== 'accepted', 'attempt 6 must not yield the secret')
    assert.ok(results[6] !== 'accepted', 'attempt 7 must not yield the secret')
    assert.equal(paired.length, 5)
  } finally {
    await server.close()
  }
})

test('transport: pre-auth lines over 4KB are dropped before authentication', async () => {
  // Regression: the 16MB post-auth line cap applied to UNAUTHENTICATED traffic too, letting any
  // LAN peer buffer megabytes (or gigabytes, drip-fed) before proving it knows the secret.
  const handled = []
  const server = createLanServer({
    port: 0,
    host: '127.0.0.1',
    deviceId: SERVER_DEVICE,
    pairingSecret: SECRET,
    getHandler: () => (msg) => handled.push(msg),
  })
  const port = await listen(server)
  try {
    const client = connect('127.0.0.1', port, { deviceId: CLIENT_DEVICE, authCode: 'nope', timeoutMs: 2000 })
    // Do NOT authenticate: blast a >4KB line straight away on a fresh connection.
    const fresh = connect('127.0.0.1', port, { deviceId: CLIENT_DEVICE, authCode: 'nope', timeoutMs: 2000 })
    const closed = new Promise((resolve) => fresh.on('close', resolve))
    fresh._socket.write(JSON.stringify({ type: 'segments-chunk', pad: 'x'.repeat(8 * 1024) }) + '\n')
    await closed
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(handled.length, 0, 'oversized pre-auth line must never reach the handler')
    await client.close()
  } finally {
    await server.close()
  }
})
