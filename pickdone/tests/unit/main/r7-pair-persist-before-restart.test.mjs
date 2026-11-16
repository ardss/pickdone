/**
 * R7 P0 regression (2026-11-13 real two-machine drill, beta.29): the pairing initiator's live
 * node missed the just-paired peer entirely — rounds ran targets=0 until the next FULL app
 * restart — because the only live-node registration that reliably works is restorePeers() at
 * restart, and the old order persisted the peer record AFTER the restart.
 *
 * Invariants (both initiator flows — syncPairRequest and syncPairWithCode):
 *  1. persistPairedPeer is called BEFORE restartSync (so restorePeers hydrates the new node).
 *  2. tellLiveNodePaired (live addPeer) runs AFTER a successful restart, not before.
 *  3. When restartSync rejects, the just-written record is rolled back (removePairedPeer) and
 *     the op still rejects with code PAIR_RESTART_FAILED_NOT_PERSISTED (F4 #6 / S5 contract).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

function buildPairOps (mocks) {
  const pairOps = require('../../../src/main/lan-sync/pair-ops.js')({
    getState: () => mocks.state,
    settingGet: () => mocks.settingGet ? mocks.settingGet() : null,
    settingPut: () => {},
    busWrite: () => {},
    getSettingsPayload: () => ({}),
    ensureIdentity: () => ({ deviceId: 'self-id' }),
    stopSync: async () => {},
    startSync: async () => {},
    runRound: async () => {},
    persistPeerWatermarks: () => {},
    persistPairedPeer: (rec) => mocks.persist.push(rec),
    removePairedPeer: (id) => mocks.removed.push(id),
    restartSync: async () => {
      mocks.order.push('restart')
      if (mocks.restartFails) throw new Error('sync server failed to bind: EADDRINUSE')
    },
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
    log: { info: () => {}, warn: () => {}, error: () => {} },
  })
  return pairOps
}

function baseMocks (resolve) {
  const mocks = {
    state: { node: { requestPair: async () => resolve, pairWith: async () => resolve } },
    order: [], persist: [], removed: [], restartFails: false,
  }
  return mocks
}

test('R7: syncPairRequest persists the peer BEFORE restartSync (restorePeers path)', async () => {
  const r = { deviceId: 'peer-A', host: '192.0.2.10', port: 58481, secret: 'sec-1' }
  const mocks = baseMocks(r)
  const pairOps = buildPairOps(mocks)
  await pairOps.syncPairRequest({ host: '192.0.2.10', port: 58481 })
  assert.deepEqual(mocks.order, ['restart'], 'exactly one restart')
  assert.equal(mocks.persist.length, 1, 'peer record persisted exactly once')
  assert.equal(mocks.order[0], 'restart', 'restart marker recorded')
  assert.deepEqual(mocks.persist[0], { deviceId: 'peer-A', host: '192.0.2.10', port: 58481, secret: 'sec-1' })
  assert.equal(mocks.removed.length, 0, 'no rollback on success')
})

test('R7: syncPairRequest rolls the record back when the restart fails (F4 #6 kept)', async () => {
  const r = { deviceId: 'peer-A', host: '192.0.2.10', port: 58481, secret: 'sec-1' }
  const mocks = baseMocks(r)
  mocks.restartFails = true
  const pairOps = buildPairOps(mocks)
  await assert.rejects(
    () => pairOps.syncPairRequest({ host: '192.0.2.10', port: 58481 }),
    (e) => e.code === 'PAIR_RESTART_FAILED_NOT_PERSISTED',
    'structured not-persisted code must survive the reorder'
  )
  assert.deepEqual(mocks.removed, ['peer-A'], 'the just-written record is rolled back')
})

test('R7: syncPairWithCode persists the peer BEFORE restartSync', async () => {
  const r = { deviceId: 'peer-B', host: '192.0.2.20', port: 58471, secret: 'sec-2', peer: { deviceId: 'peer-B', name: 'B', host: '192.0.2.20', port: 58471 } }
  const mocks = baseMocks(r)
  const pairOps = buildPairOps(mocks)
  mocks.state.pairingCode = null
  await pairOps.syncPairWithCode({ deviceId: 'peer-B', code: '123456' })
  assert.equal(mocks.persist.length, 1, 'peer record persisted exactly once')
  assert.deepEqual(mocks.persist[0], { deviceId: 'peer-B', name: 'B', host: '192.0.2.20', port: 58471, secret: 'sec-2' })
  assert.equal(mocks.removed.length, 0, 'no rollback on success')
})

test('R7: syncPairWithCode rolls the record back when the restart fails', async () => {
  const r = { deviceId: 'peer-B', host: '192.0.2.20', port: 58471, secret: 'sec-2', peer: { deviceId: 'peer-B', name: 'B', host: '192.0.2.20', port: 58471 } }
  const mocks = baseMocks(r)
  mocks.restartFails = true
  const pairOps = buildPairOps(mocks)
  await assert.rejects(
    () => pairOps.syncPairWithCode({ deviceId: 'peer-B', code: '123456' }),
    (e) => e.code === 'PAIR_RESTART_FAILED_NOT_PERSISTED'
  )
  assert.deepEqual(mocks.removed, ['peer-B'], 'rollback on restart failure')
})
