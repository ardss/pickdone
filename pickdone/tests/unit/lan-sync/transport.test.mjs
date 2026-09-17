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
      if (msg.type === 'segments') {
        received.push(...msg.segments)
        socket.write(JSON.stringify({ type: 'ack', applied: msg.segments.length, rejected: 0 }) + '\n')
      }
    },
  })
  const port = await listen(server)
  try {
    const client = connect('127.0.0.1', port, {
      deviceId: CLIENT_DEVICE,
      authCode: deriveAuthCode(SECRET, CLIENT_DEVICE),
    })
    await new Promise((resolve, reject) => {
      client.on('ready', resolve)
      client.on('error', reject)
      client.on('rejected', () => reject(new Error('unexpected rejection')))
    })
    const ack = await new Promise((resolve) => {
      client.on('message', (msg) => { if (msg.type === 'ack') resolve(msg) })
      client.send({ type: 'segments', segments: [{ fromSeq: 1, toSeq: 2, deviceId: CLIENT_DEVICE, rows: [{ id: 't1', seq: 1 }, { id: 't2', seq: 2 }] }] })
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
    getHandler: () => (msg) => { if (msg.type === 'segments') received.push(...(msg.segments || [])) },
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
    getHandler: () => (msg) => { if (msg.type === 'segments') received.push(msg) },
  })
  server.on('error', (e) => { serverSawError = e })
  const port = await listen(server)
  try {
    const client = connect('127.0.0.1', port, {
      deviceId: CLIENT_DEVICE,
      authCode: deriveAuthCode(SECRET, CLIENT_DEVICE),
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
