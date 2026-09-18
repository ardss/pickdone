/**
 * Round-3 hardening regression tests (node-level, real TCP on 127.0.0.1 ephemeral ports):
 *   - peer-bookkeeping LRU cap (MAX_PEERS = 64): a discovery flood cannot grow the tables;
 *   - security-ring seed shape validation: malformed persisted entries are dropped at the
 *     trust boundary (the ring is rendered verbatim in Device Center);
 *   - a clean socket close BEFORE the round settles fails the round promptly (no 120s hang);
 *   - wire deviceName sanitization (control-char strip + 40-char clamp).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')
const { createLanServer, cleanDeviceName } = require('../../../src/main/lan-sync/transport.js')

const SECRET = 'hardening-secret-1'

function fakeDiscovery() {
  return { startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] }
}

function makeNode(extra = {}) {
  return createLanSyncNode({
    deviceId: 'me',
    pairingSecret: SECRET,
    port: 0,
    host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: () => ({ applied: 0, rejected: 0 }),
    ingestSnapshot: () => {},
    buildSegments: () => [],
    roundTimeoutMs: 4000,
    ...extra,
  })
}

test('hardening: peer bookkeeping is LRU-capped at 64 — a discovery flood cannot grow it', async () => {
  const node = makeNode()
  node.start()
  await node.whenListening()
  // Flood with 80 distinct deviceIds (a forged mDNS/UDP announce storm).
  for (let i = 0; i < 80; i++) {
    node.addPeer({ deviceId: `flood-${i}`, host: '127.0.0.1', port: 40000 + i, name: `f${i}` })
  }
  const peers = node.getStatus().peers
  assert.ok(peers.length <= 64, `peer table is capped (got ${peers.length})`)
  // The OLDEST entries were expelled, the newest survive.
  assert.ok(!peers.some(p => p.deviceId === 'flood-0'), 'the least-recently-seen peer was evicted')
  assert.ok(peers.some(p => p.deviceId === 'flood-79'), 'the incoming peer survives its own eviction round')
  // A known peer refresh (re-announce) must NOT trigger eviction churn.
  node.addPeer({ deviceId: 'flood-79', host: '127.0.0.1', port: 40079, name: 'f79' })
  assert.equal(node.getStatus().peers.length, peers.length, 're-announcing an existing peer does not grow the table')
  await node.stop()
})

test('hardening: malformed persisted security-log entries are dropped at the seed boundary', async () => {
  const node = makeNode({
    securityLog: [
      null,
      'garbage',
      { ip: '1.2.3.4', reason: 'auth-rejected' }, // missing at
      { at: 'not-a-number', ip: '1.2.3.4', reason: 'auth-rejected' },
      { at: Date.now(), reason: 'auth-rejected' }, // missing ip
      { at: Date.now(), ip: 42, reason: 'auth-rejected' }, // non-string ip
      { at: Date.now(), ip: '9.9.9.9', reason: 'auth-rejected' }, // VALID
    ],
  })
  const sec = node.getStatus().security
  assert.equal(sec.length, 1, `only shape-valid entries seeded (got ${sec.length})`)
  assert.equal(sec[0].ip, '9.9.9.9')
  await node.stop()
})

test('hardening: a clean close before the round settles fails the round promptly (no deadline hang)', async () => {
  // Peer accepts the push then FINishes without acking: the round must fail at the close event,
  // not idle to the round deadline.
  const server = createLanServer({
    port: 0,
    host: '127.0.0.1',
    deviceId: 'peer',
    pairingSecret: SECRET,
    getHandler: () => (msg, socket) => {
      if (msg.type === 'segments-chunk') {
        setImmediate(() => socket.destroy()) // clean close, NO ack, NO snapshot
      }
    },
  })
  await new Promise((resolve) => server.on('listening', resolve))
  const node = makeNode({ buildSegments: () => [{ fromSeq: 1, toSeq: 1, deviceId: 'me', rows: [{ id: 'a', seq: 1 }] }] })
  node.start()
  await node.whenListening()
  node.addPeer({ deviceId: 'peer', host: '127.0.0.1', port: server.port })

  const r = await node.startSyncRound()
  assert.equal(r.confirmed, 0, 'the round failed (no ack)')
  assert.ok(node.getStatus().lastError, 'the failure is surfaced as the node lastError')

  await node.stop()
  await server.close()
})

test('hardening: wire deviceName is sanitized — control chars stripped, clamped to 40 chars', () => {
  assert.equal(cleanDeviceName('\u001b]2;pwned\u0007evil'), ']2;pwnedevil', 'terminal escape stripped')
  assert.equal(cleanDeviceName('a'.repeat(100)).length, 40, 'clamped to 40 chars')
  assert.equal(cleanDeviceName('  spaced  '), 'spaced', 'trimmed')
  assert.equal(cleanDeviceName(42), '', 'non-string collapses to empty')
  assert.equal(cleanDeviceName(undefined), '')
})
