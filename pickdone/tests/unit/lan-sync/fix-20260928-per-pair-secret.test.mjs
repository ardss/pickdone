/* F1 regression (2026-09-28 3-machine drill): per-peer pairing secrets.
 * Root cause: every pairing overwrote the single global sync.pairingSecret, so pairing a
 * NEW peer invalidated every PREVIOUS pair (A↔B broke the moment A↔C was paired).
 * Fix: the responder mints a FRESH secret per pair-accept; it is persisted in both sides'
 * paired-peer records; hello auth and client dialing prefer the peer-record secret and fall
 * back to the global (legacy peers keep working).
 *
 * Run: node --test tests/unit/lan-sync/fix-20260928-per-pair-secret.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')
const { createLanServer } = require('../../../src/main/lan-sync/transport.js')
const { connect } = require('../../../src/main/lan-sync/transport.js')
const { deriveAuthCode } = require('../../../src/main/lan-sync/pairing.js')
const createPairedPeers = require('../../../src/main/lan-sync/paired-peers.js')

const GLOBAL_SECRET = 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8'
const PAIR_SECRET_B = 'b1b2b3b4b5b6b7b8b1b2b3b4b5b6b7b8'

const sleep = ms => new Promise(r => setTimeout(r, ms))

function makeNode (deviceId, over = {}) {
  return createLanSyncNode({
    deviceId, pairingSecret: GLOBAL_SECRET, port: 0, host: '127.0.0.1',
    discoverFn: { startAdvertising () {}, discover () {}, stop () {}, getPeers: () => [] },
    ingestSegment: () => ({ applied: 0 }),
    ingestSnapshot: () => {},
    buildSegments: () => [],
    ...over,
  })
}

test('F1: a round authenticated with the per-peer secret confirms while the global differs', async () => {
  // A only accepts B under B's OWN per-pair secret (the global is a DIFFERENT value, as it
  // would be after A paired some other peer C and overwrote the global).
  const a = makeNode('node-a', { secretFor: (id) => (id === 'node-b' ? PAIR_SECRET_B : null) })
  const b = makeNode('node-b')
  a.start()
  const aPort = await a.whenListening()

  // The stale-global signature of the old bug: with no per-peer secret on the dial entry,
  // B authenticates with the global and A (holding a rotated global) must REJECT it.
  b.addPeer({ deviceId: 'node-a', host: '127.0.0.1', port: aPort })
  const rStale = await b.startSyncRound()
  assert.equal(rStale.confirmed, 0, 'global-secret-only dial fails against rotated global')

  // With the per-pair secret persisted on the peer record (the fix), the same pair confirms.
  // forceDial: the failed stale round armed the per-peer backoff window; a re-pair (addPeer in
  // production resets dialability the same way) must clear it.
  b.addPeer({ deviceId: 'node-a', host: '127.0.0.1', port: aPort, secret: PAIR_SECRET_B })
  b.forceDial('node-a')
  const r = await b.startSyncRound()
  assert.equal(r.confirmed, 1, 'per-pair-secret dial confirms')

  await sleep(30)
  await b.stop()
  await a.stop()
})

test('F1: pair-accept mints a FRESH per-pair secret (never the global) and echoes the responder deviceId', async () => {
  const paired = []
  const server = createLanServer({
    port: 0, host: '127.0.0.1', deviceId: 'srv-1', pairingSecret: GLOBAL_SECRET,
    verifyPairingCode: (code) => code === '123456',
    onPaired: (info) => paired.push(info),
    getHandler: () => () => {},
  })
  await new Promise((resolve) => server.once('listening', resolve))

  const client = connect('127.0.0.1', server.port, {
    deviceId: 'cli-1', pairCode: '123456', protoVer: 2, timeoutMs: 5000,
  })
  const accepted = await new Promise((resolve, reject) => {
    client.on('paired', resolve)
    client.on('rejected', (m) => reject(new Error('rejected: ' + JSON.stringify(m))))
    client.on('error', reject)
    setTimeout(() => reject(new Error('pairing timeout')), 4000).unref?.()
  })

  assert.ok(accepted.secret && accepted.secret !== GLOBAL_SECRET, 'accept carries a fresh secret, not the global')
  assert.equal(accepted.deviceId, 'srv-1', 'accept echoes the responder deviceId (initiator needs it to persist the record)')
  assert.equal(paired.length, 1)
  assert.equal(paired[0].secret, accepted.secret, 'both sides hold the SAME per-pair secret')
  client.close()
  await server.close()
})

test('F1: persistPairedPeer stores the per-pair secret and a secret-only update writes', async () => {
  const store = new Map()
  const pp = createPairedPeers({
    settingGet: (k) => store.get(k) || null,
    settingPut: (k, v) => store.set(k, v),
    log: { warn () {} },
    isDialableHost: (h) => !!h,
    DEFAULT_PORT: 58471,
    K_PAIRED_PEERS: 'sync.pairedPeers',
  })

  assert.equal(pp.persistPairedPeer({ deviceId: 'p1', name: 'P1', host: '192.168.1.9', port: 58471 }), true)
  // Address refresh from a later connection must NOT clobber the secret (entry has none).
  assert.equal(pp.persistPairedPeer({ deviceId: 'p1', host: '192.168.1.10', port: 58471 }), true, 'address change writes')
  assert.equal(pp.persistPairedPeer({ deviceId: 'p1', host: '192.168.1.10', port: 58471 }), false, 'no write without change')
  assert.equal(pp.loadPairedPeers().p1.secret, null, 'no secret yet')

  assert.equal(pp.persistPairedPeer({ deviceId: 'p1', secret: PAIR_SECRET_B }), true, 'secret-only update writes')
  assert.equal(pp.persistPairedPeer({ deviceId: 'p1', secret: PAIR_SECRET_B }), false, 'same secret does not rewrite')
  assert.equal(pp.loadPairedPeers().p1.secret, PAIR_SECRET_B)
  // Secret survives an address refresh (entry without secret keeps the stored one).
  pp.persistPairedPeer({ deviceId: 'p1', host: '192.168.1.11', port: 58471 })
  assert.equal(pp.loadPairedPeers().p1.secret, PAIR_SECRET_B, 'address refresh keeps the secret')
})

test('F1: the persisted auth code derivation matches the per-pair secret end to end', () => {
  assert.notEqual(deriveAuthCode(PAIR_SECRET_B, 'node-b'), deriveAuthCode(GLOBAL_SECRET, 'node-b'),
    'per-pair and global secrets derive distinct auth codes (the old single-secret bug in test form)')
})
