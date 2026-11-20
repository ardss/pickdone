/** beta.41 — `sync forget`: remove ONE stale peer record without rotating the shared secret.
 *
 * Context: `sync unpair` revokes the single shared pairing secret, so a record left behind by an
 * old dev instance (203.0.113.9:58472, hibernating, ECONNREFUSED every round) could only be
 * removed by disconnecting every healthy device. `forget` is the same bookkeeping minus the three
 * steps that damage real peers. This test pins exactly that difference — if anyone ever makes
 * forget call restartSync() or write K_PAIRING_SECRET, it goes red.
 *
 * Run: node --test tests/unit/lan-sync/beta41-forget-peer.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const createPairOps = require('../../../src/main/lan-sync/pair-ops.js')

function harness ({ peers = [], manualPeers = [], watermarks = { ghost: 5, other: 9 } } = {}) {
  const calls = { settingPut: [], removed: [], revoked: [], restarts: 0, notified: [] }
  const removedPeerIds = []
  const ops = createPairOps({
    getState: () => ({
      node: {
        getStatus: () => ({ peers }),
        removePeer: (id) => { removedPeerIds.push(id) }
      },
      peerWatermarks: {
        revoke: (id) => { calls.revoked.push(id); delete watermarks[id] },
        delete: (id) => { delete watermarks[id] }
      }
    }),
    settingGet: () => true,
    settingPut: (k, v) => { calls.settingPut.push([k, v]) },
    busWrite: (op, ...args) => { calls.busWrite = [op, ...args] },
    getSettingsPayload: () => ({ peers: [], enabled: true }),
    ensureIdentity: () => ({ deviceId: 'me' }),
    stopSync: async () => {},
    startSync: async () => {},
    runRound: async () => {},
    persistPeerWatermarks: () => { calls.persistedWatermarks = true },
    persistPairedPeer: () => {},
    removePairedPeer: (id) => { calls.removed.push(id) },
    restartSync: async () => { calls.restarts++ },
    manualPeers: () => manualPeers,
    loadPeerWatermarks: () => watermarks,
    notifyRenderers: (evt) => { calls.notified.push(evt) },
    emitSyncEvent: () => {},
    K_PAIRING_SECRET: 'sync.pairingSecret',
    K_DEVICE_NAME: 'sync.deviceName',
    K_MANUAL_PEERS: 'sync.manualPeers',
    K_PEER_WATERMARKS: 'sync.peerWatermarks.v2',
    K_ENABLED: 'sync.enabled',
    K_PEER_ALIAS_PREFIX: 'sync.peerAlias.',
    PAIRING_CODE_TTL_MS: 600000,
    DEFAULT_PORT: 58471,
    log: { info: () => {}, warn: () => {} }
  })
  return { ops, calls, removedPeerIds }
}

const GHOST = { deviceId: '94fdf505-ghost', host: '203.0.113.9', port: 58472 }
const REAL = { deviceId: '8ddae379-real', host: '203.0.113.9', port: 58471 }

test('beta.41: forget drops the record, its manual mirror, announce row and watermark', async () => {
  const { ops, calls, removedPeerIds } = harness({
    peers: [GHOST, REAL],
    manualPeers: [
      { host: '203.0.113.9', port: 58472 },
      { host: '203.0.113.9', port: 58471 }
    ]
  })
  const r = await ops.syncForgetPeerOp({ deviceId: GHOST.deviceId })
  assert.equal(r.forgotten, GHOST.deviceId)
  assert.deepEqual(calls.removed, [GHOST.deviceId], 'paired-peer record deleted')
  assert.deepEqual(removedPeerIds, ['manual-203.0.113.9:58472', GHOST.deviceId],
    'live node entry + its manual mirror dropped')
  const manualPut = calls.settingPut.find(([k]) => k === 'sync.manualPeers')
  assert.deepEqual(JSON.parse(manualPut[1]), [{ host: '203.0.113.9', port: 58471 }],
    'only the ghost address is removed from the manual list')
  assert.equal(calls.busWrite[0], 'deleteMeta')
  assert.match(calls.busWrite[1], /94fdf505-ghost$/, 'tomato-announce row for the ghost only')
  assert.deepEqual(calls.revoked, [GHOST.deviceId], 'ghost watermark revoked through the store')
  assert.equal(calls.persistedWatermarks, true)
})

test('beta.41: forget NEVER rotates the pairing secret and never restarts the node', async () => {
  const { ops, calls } = harness({ peers: [GHOST, REAL], manualPeers: [{ host: '203.0.113.9', port: 58472 }] })
  await ops.syncForgetPeerOp({ deviceId: GHOST.deviceId })
  assert.equal(calls.settingPut.some(([k]) => k === 'sync.pairingSecret'), false,
    'red before the fix: only unpair existed, and it rotates the secret — disconnecting the real device')
  assert.equal(calls.restarts, 0, 'no restart: the healthy peer keeps its live connection')
})

test('beta.41: forget is idempotent and still works with sync disabled (no live node)', async () => {
  const { calls } = harness()
  const disabled = createPairOps({
    getState: () => ({ node: null, peerWatermarks: null }),
    settingGet: () => false,
    settingPut: (k, v) => { calls.settingPut.push([k, v]) },
    busWrite: () => {},
    getSettingsPayload: () => ({ peers: [], enabled: false }),
    ensureIdentity: () => ({ deviceId: 'me' }),
    stopSync: async () => {}, startSync: async () => {}, runRound: async () => {},
    persistPeerWatermarks: () => {}, persistPairedPeer: () => {},
    removePairedPeer: (id) => { calls.removed.push(id) },
    restartSync: async () => { calls.restarts++ },
    manualPeers: () => [], loadPeerWatermarks: () => ({}),
    notifyRenderers: () => {}, emitSyncEvent: () => {},
    K_PAIRING_SECRET: 'sync.pairingSecret', K_DEVICE_NAME: 'sync.deviceName',
    K_MANUAL_PEERS: 'sync.manualPeers', K_PEER_WATERMARKS: 'sync.peerWatermarks.v2',
    K_ENABLED: 'sync.enabled', K_PEER_ALIAS_PREFIX: 'sync.peerAlias.',
    PAIRING_CODE_TTL_MS: 600000, DEFAULT_PORT: 58471,
    log: { info: () => {}, warn: () => {} }
  })
  const r = await disabled.syncForgetPeerOp({ deviceId: GHOST.deviceId })
  assert.equal(r.forgotten, GHOST.deviceId)
  assert.deepEqual(calls.removed, [GHOST.deviceId])
  await assert.rejects(() => disabled.syncForgetPeerOp({}), /deviceId is required/)
})
