/** C4 (2026-10-02) — per-process aggregate line-buffer budget for the LAN sync transport.
 *
 * Per-reader caps bound ONE socket, but 64 concurrent (maxSockets) authenticated sockets x the
 * 32MB post-auth cap = a 2GB worst-case aggregate of buffered line bytes on the main process.
 * Every LineReader now feeds a shared per-process budget; when a feed pushes the aggregate past
 * the cap, the OFFENDING socket is closed (its bytes released). A single legitimate round
 * (32MB) still fits under the 64MB default.
 *
 * Run: node --test tests/unit/lan-sync/transport-buffer-budget.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const transport = require('../../../src/main/lan-sync/transport.js')
const { createLanServer, connect, __setLineBufferBudget, LINE_BUFFER_BUDGET_BYTES } = transport
const { deriveAuthCode } = require('../../../src/main/lan-sync/pairing.js')

const SECRET = 'pairing-secret-alpha'
const SERVER_DEVICE = 'device-server'

async function listen (server) {
  await new Promise((resolve) => server.on('listening', resolve))
  return server.port
}

/** Dial + authenticate one client. Resolves once hello-ack ok (line cap raised to 32MB). */
function authClient (port, deviceId) {
  return new Promise((resolve, reject) => {
    const client = connect('127.0.0.1', port, {
      deviceId,
      authCode: deriveAuthCode(SECRET, deviceId),
      pairingSecret: SECRET
    })
    client.on('ready', () => resolve(client))
    client.on('error', reject)
    client.on('rejected', (m) => reject(new Error('unexpected rejection: ' + JSON.stringify(m))))
  })
}

test('C4: the aggregate budget default is 64MB (2 legit 32MB rounds fit, 64x32MB does not)', () => {
  assert.equal(LINE_BUFFER_BUDGET_BYTES, 64 * 1024 * 1024)
})

test('C4: pushing the AGGREGATE past the cap closes the offending socket, not the innocent one', async () => {
  // Shrink the budget for the test (restored in finally): two authenticated readers, each
  // buffering 40KB of an unterminated line — the second one crosses the 64KB aggregate.
  const savedCap = 64 * 1024 * 1024
  __setLineBufferBudget(64 * 1024)
  const closed = []
  const server = createLanServer({
    port: 0,
    host: '127.0.0.1',
    deviceId: SERVER_DEVICE,
    pairingSecret: SECRET,
    getHandler: () => () => {},
    onPeer: (peer, socket) => { socket.on('close', () => closed.push(peer.deviceId)) }
  })
  let first = null
  let second = null
  try {
    const port = await listen(server)
    first = await authClient(port, 'device-a')
    second = await authClient(port, 'device-b')
    // Each drip is unterminated (no '\n'), so the bytes stay buffered in the reader.
    const drip = 'x'.repeat(40 * 1024)
    first.send({ type: 'ping' })
    first._socket.write(drip)
    second._socket.write(drip)
    // Give the second reader's feed a tick to trip the aggregate gate.
    const secondClosed = await new Promise((resolve) => {
      const t = setTimeout(() => resolve(false), 2000)
      second._socket.once('close', () => { clearTimeout(t); resolve(true) })
    })
    assert.equal(secondClosed, true, 'red before the fix: no aggregate budget — both readers could buffer freely')
    await new Promise((r) => setTimeout(r, 100))
    assert.equal(first._socket.destroyed, false, 'the innocent reader (under the aggregate) is untouched')
    assert.deepEqual(closed.includes('device-b'), true)
  } finally {
    __setLineBufferBudget(savedCap)
    try { if (first) await first.close() } catch { /* already closed */ }
    try { if (second) await second.close() } catch { /* already closed */ }
    await server.close()
  }
})

test('C4: a single legitimate large buffer under the default budget is never closed', async () => {
  const server = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: SERVER_DEVICE, pairingSecret: SECRET,
    getHandler: () => () => {}
  })
  let client = null
  try {
    const port = await listen(server)
    client = await authClient(port, 'device-solo')
    // 4MB buffered unterminated — far under the 64MB default aggregate.
    client._socket.write('y'.repeat(4 * 1024 * 1024))
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(client._socket.destroyed, false, 'solo round buffering is business as usual')
  } finally {
    try { if (client) await client.close() } catch { /* already closed */ }
    await server.close()
  }
})
