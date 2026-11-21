/* F1/F2 regression (2026-11-11 real two-machine acceptance, ab226-acceptance.md):
 *
 *   F1  After an auth failure ("terminal until re-pair", dialer-side unpairedBy), a SUCCESSFUL
 *       re-pair did not restore the node: the initiator's live peer entry kept the STALE
 *       per-pair secret (pair-ops persists the fresh secret AFTER restartSync but never told
 *       the restarted node), so the post-pair round dialed with the old secret, was rejected,
 *       and entered the terminal unpaired state — inbound/pairing stayed dead until a manual
 *       sync disable/enable (node restart). Reproduced twice on real machines (steps 6 & 12).
 *   F2  Same root: the unpair/re-pair churn leaves the dialer in hibernate/backoff
 *       (failStreakBy/dialNotBefore) and possibly flush-stall; nothing cleared that per-peer
 *       backpressure on pair success, so the round loop stayed wedged (>3 min observed).
 *
 *   Semantics (the contract these tests pin): a successful PAIRING is the ONLY trust-root
 *   change event — it must clear that peer's terminal unpaired flag AND all per-peer poll
 *   backpressure, and install the fresh per-pair secret into the live node entry. A REVOKED
 *   pairing (plain auth rejection, no new pair) must KEEP the block — neither the periodic
 *   round loop nor a manual forceDial ("sync now") may lift it.
 *
 * Run: node --test tests/unit/lan-sync/fix-20261110-repair-clears-terminal.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')
const createPairOps = require('../../../src/main/lan-sync/pair-ops.js')

const GLOBAL_SECRET = 'a1b2c3d4e5f6a7b8a1b2c3d4e5f6a7b8'
const OLD_PAIR_SECRET = '0000000000000000000000000000old1'
const NEW_PAIR_SECRET = '0000000000000000000000000000new2'

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

function peerState (node, id) {
  const p = node.getStatus().peers.find(x => x.deviceId === id)
  return p ? p.peerState : null
}

/* ---------------- F1: terminal unpaired must recover on pair success ---------------- */

test('F1: a stale-secret auth rejection puts the dialer in terminal unpaired', async () => {
  const a = makeNode('node-a')
  const b = makeNode('node-b')
  let bPort
  try {
  a.start(); b.start()
  bPort = await b.whenListening()

  // The stale entry (the restarted node restored the OLD per-pair secret): B's server now
  // verifies under a different secret and rejects the hello.
  a.addPeer({ deviceId: 'node-b', host: '127.0.0.1', port: bPort, secret: OLD_PAIR_SECRET })
  const r = await a.startSyncRound()
  assert.equal(r.confirmed, 0, 'stale-secret dial is rejected')
  assert.equal(peerState(a, 'node-b'), 'unpaired', 'auth rejection = terminal until re-pair')

  await sleep(30)
  } finally { try { await a.stop(); await b.stop() } catch {} }
})

test('F1 RED->GREEN: pair success clears the terminal flag + installs the fresh secret (round confirms)', async () => {
  const a = makeNode('node-a')
  // B already verifies under the NEW per-pair secret (the acceptor minted it at accept time)
  const b = makeNode('node-b', { pairingSecret: NEW_PAIR_SECRET })
  let bPort
  try {
  a.start(); b.start()
  bPort = await b.whenListening()

  a.addPeer({ deviceId: 'node-b', host: '127.0.0.1', port: bPort, secret: OLD_PAIR_SECRET })
  await a.startSyncRound()
  assert.equal(peerState(a, 'node-b'), 'unpaired')

  // The re-pair: a genuine trust-root change. The node must expose the pair-success reset the
  // pair-ops layer needs (pre-fix this API did not exist — the initiator had NO way to clear
  // the terminal state without a full sync disable/enable restart).
  assert.equal(typeof a.onPairSuccess, 'function', 'node must expose onPairSuccess(peerId)')
  a.addPeer({ deviceId: 'node-b', host: '127.0.0.1', port: bPort, secret: NEW_PAIR_SECRET })
  a.onPairSuccess('node-b')

  assert.notEqual(peerState(a, 'node-b'), 'unpaired', 'pair success lifts the terminal flag')
  const r = await a.startSyncRound()
  assert.equal(r.confirmed, 1, 'post-pair round dials with the FRESH secret and confirms')
  assert.equal(peerState(a, 'node-b'), 'ok')

  await sleep(30)
  } finally { try { await a.stop(); await b.stop() } catch {} }
})

/* ---------------- F2: poll backpressure must clear on pair success ---------------- */

test('F2 RED->GREEN: pair success clears hibernate/backoff so the next round dials immediately', async () => {
  // Small injected budgets: reach hibernate in a few fast retries instead of 10 x 5s backoff.
  const a = makeNode('node-a', { dialFailureBudget: 2, backoffBaseMs: 20 })
  const b = makeNode('node-b', { pairingSecret: NEW_PAIR_SECRET })
  let bPort
  try {
  a.start(); b.start()
  bPort = await b.whenListening()

  // Unpair churn: the dead window piles up dial failures until the peer hibernates.
  a.addPeer({ deviceId: 'node-b', host: '127.0.0.1', port: 1, secret: OLD_PAIR_SECRET }) // port 1 = dial fails
  for (let i = 0; i < 30 && peerState(a, 'node-b') !== 'hibernating'; i++) { await a.startSyncRound(); await sleep(25) }
  assert.equal(peerState(a, 'node-b'), 'hibernating', 'precondition: churn reached hibernate')

  // Re-pair success: the address is corrected AND the trust root rotates. The round loop must
  // dial on the NEXT tick — not sit out the 10-minute hibernate window (F2's >3 min wedge).
  a.addPeer({ deviceId: 'node-b', host: '127.0.0.1', port: bPort, secret: NEW_PAIR_SECRET })
  a.onPairSuccess('node-b')
  const r = await a.startSyncRound()
  assert.equal(r.confirmed, 1, 'pair success clears the backpressure — next round dials at once')
  assert.notEqual(peerState(a, 'node-b'), 'hibernating')

  await sleep(30)
  } finally { try { await a.stop(); await b.stop() } catch {} }
})

/* ---------------- Revocation positive: the block must SURVIVE without a re-pair ---------------- */

test('revocation stays blocked: periodic rounds and forceDial never lift a revoked pairing', async () => {
  const a = makeNode('node-a')
  const b = makeNode('node-b')
  let bPort
  try {
  a.start(); b.start()
  bPort = await b.whenListening()

  a.addPeer({ deviceId: 'node-b', host: '127.0.0.1', port: bPort, secret: OLD_PAIR_SECRET })
  await a.startSyncRound()
  assert.equal(peerState(a, 'node-b'), 'unpaired')

  // NO new pairing happened: the user only hits "sync now" (forceDial) — that clears the
  // dial WINDOW by design but must never lift the revoked-pairing terminal block.
  a.forceDial('node-b')
  const r = await a.startSyncRound()
  assert.equal(r.peers, 0, 'a revoked pairing is never dialed by the round loop')
  assert.equal(r.confirmed, 0)
  assert.equal(peerState(a, 'node-b'), 'unpaired', 'the terminal block survives without a real re-pair')

  await sleep(30)
  } finally { try { await a.stop(); await b.stop() } catch {} }
})

/* ---------------- pair-ops wiring: the pairing ops must actually call the reset ---------------- */

function makePairOpsHarness () {
  const calls = { addPeer: [], onPairSuccess: [], runRound: 0, persisted: [] }
  const state = {
    node: {
      pairWith: async () => ({ secret: NEW_PAIR_SECRET, peer: { deviceId: 'peer-9', name: 'Peer9', host: '127.0.0.1', port: 41000 } }),
      requestPair: async () => ({ secret: NEW_PAIR_SECRET, deviceId: 'peer-9', host: '127.0.0.1', port: 41000 }),
      addPeer: (p) => { calls.addPeer.push(p) },
      onPairSuccess: (id) => { calls.onPairSuccess.push(id) },
    },
    pairingCode: null,
  }
  const deps = {
    getState: () => state,
    settingGet: () => GLOBAL_SECRET, // existing global: mint-once contract keeps it
    settingPut: () => {},
    busWrite: () => {},
    getSettingsPayload: () => ({ enabled: true }),
    ensureIdentity: () => ({ deviceId: 'self-1', deviceName: 'Self' }),
    stopSync: async () => {},
    startSync: async () => {},
    runRound: async () => { calls.runRound++ },
    persistPeerWatermarks: () => {},
    persistPairedPeer: (e) => { calls.persisted.push(e) },
    removePairedPeer: () => {},
    restartSync: async () => {},
    manualPeers: () => [],
    loadPeerWatermarks: () => ({}),
    notifyRenderers: () => {},
    emitSyncEvent: () => {},
    K_PAIRING_SECRET: 'sync.pairingSecret',
    K_DEVICE_NAME: 'sync.deviceName',
    K_MANUAL_PEERS: 'sync.manualPeers',
    K_PEER_WATERMARKS: 'sync.peerWatermarks',
    K_ENABLED: 'sync.enabled',
    K_PEER_ALIAS_PREFIX: 'sync.peerAlias.',
    PAIRING_CODE_TTL_MS: 120000,
    DEFAULT_PORT: 58471,
    log: { info () {}, warn () {}, error () {} },
  }
  return { ops: createPairOps(deps), calls }
}

test('F1 wiring: syncPairWithCode installs the fresh per-pair secret + resets the live node', async () => {
  const { ops, calls } = makePairOpsHarness()
  await ops.syncPairWithCode({ deviceId: 'peer-9', code: '123456' })
  const add = calls.addPeer.find(p => p && p.deviceId === 'peer-9')
  assert.ok(add, 'pairWithCode must push the fresh secret into the LIVE node entry (the restarted node restored the stale one)')
  assert.equal(add.secret, NEW_PAIR_SECRET)
  assert.ok(calls.onPairSuccess.includes('peer-9'), 'pairWithCode must clear that peer terminal/backpressure state')
  assert.ok(calls.runRound >= 1, 'post-pair round is kicked')
})

test('F1 wiring: syncPairRequest (two-way confirm) does the same for its deviceId', async () => {
  const { ops, calls } = makePairOpsHarness()
  await ops.syncPairRequest({ host: '127.0.0.1', port: 41000 })
  const add = calls.addPeer.find(p => p && p.deviceId === 'peer-9')
  assert.ok(add, 'pairRequest must push the fresh secret into the LIVE node entry')
  assert.equal(add.secret, NEW_PAIR_SECRET)
  assert.ok(calls.onPairSuccess.includes('peer-9'))
})
