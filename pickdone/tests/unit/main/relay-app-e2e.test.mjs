import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createRelay, startRelayServer, memoryStore } from '../../../server/sync-relay.mjs'
import { createRelayClient } from '../../../shared/sync-transport/https/relay-client.mjs'
import { generateAccountRootKey, deriveDataKey } from '../../../shared/sync-crypto/e2e.mjs'

// Real app DB (not a mock): writes through db.call must land in sync_revisions and flow
// through the REAL bootstrap wiring (relay-sync-bootstrap → relay-sync-adapter →
// relay-client → relay HTTP server) into a second device's store.
process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-relay-app-e2e-'))
const require = createRequire(import.meta.url)
const db = require('../../../src/main/db')
db.init(process.env.TODO_DB_DIR)
const dbSyncOps = require('../../../src/main/db-sync-ops')
const relayBootstrap = require('../../../src/main/relay-sync-bootstrap')

const ACCOUNT = 'e2e-relay-acc'
// Simulated cross-device pairing: a manually shared root key stands in for the account
// key-pairing service (Step 14+) that does not exist yet — loopback test only, see the
// adapter's production-gate header.
const ROOT_KEY = generateAccountRootKey()

async function withRelay (t, { enrollment = '' } = {}) {
  const relay = createRelay(memoryStore(), { enrollment })
  const server = await startRelayServer(relay, { port: 0 })
  t.after(() => new Promise(r => server.close(r)))
  return { relay, baseUrl: `http://127.0.0.1:${server.address().port}` }
}

test('e2e: app writes → relay ops → loopback relay → peer device converges; relay never sees plaintext', async t => {
  const { relay, baseUrl } = await withRelay(t, { enrollment: 'synthetic-e2e-enrollment' })
  relayBootstrap.initRelaySync()

  // before enable: the op surface answers with default-off status
  const off = dbSyncOps.dispatch('relayGetSettings')
  assert.equal(off.enabled, false, 'relay ops available but default OFF after init')

  // enable through the app op surface (dispatch path): flips the v2 revision flag + registers
  const enabled = await dbSyncOps.dispatch('relaySetEnabled', { enabled: true, account: ACCOUNT, baseUrl, rootKey: ROOT_KEY, enrollment: 'synthetic-e2e-enrollment' })
  assert.equal(enabled.enabled, true)
  assert.equal(enabled.hasEnrollment, true, 'the app bootstrap must forward the CLI enrollment to the adapter')
  assert.equal(db.call('getMeta', 'sync.relay.enrollment'), 'synthetic-e2e-enrollment', 'the isolated device must persist its enrollment for registration')
  assert.equal(enabled.hasDeviceSecret, true, 'device registered against the relay')
  assert.equal(enabled.account, ACCOUNT)
  assert.equal(db.call('revisionsFlagState').on, true, 'enable turns on the v2 revision recorder')

  // app writes — the real write path records revisions (flag on)
  db.call('upsert', { taskId: 'e1', title: 'alpha secret from the app', createdAt: 1, updatedAt: 100 })
  db.call('upsert', { taskId: 'e1', title: 'alpha edited on device one', createdAt: 1, updatedAt: 200 })
  db.call('upsert', { taskId: 'e2', title: 'beta second task', createdAt: 2, updatedAt: 150 })

  // one round through the op surface
  const round = await dbSyncOps.dispatch('relaySyncNow')
  assert.equal(round.ok, true, round.error || '')
  assert.ok(round.pushed >= 3, 'app-recorded revisions pushed to the relay')

  // wire/storage invariant: everything on the relay is opaque AEAD ciphertext
  const dump = relay.store.__dump()
  assert.ok(dump.envelopes.length >= 3)
  for (const e of dump.envelopes) {
    assert.ok(e.envelopeJson.startsWith('e1.'), 'envelope not AEAD-framed')
    assert.ok(!e.envelopeJson.includes('secret') && !e.envelopeJson.includes('alpha') && !e.envelopeJson.includes('beta'),
      'plaintext leaked into relay storage')
  }

  // second desktop (peer) joins with the shared root key: pulls, decrypts, converges exactly
  const { createRevisionStore, applyEnvelope, materializedAll } = await import('../../../shared/sync-core/causality/merge.mjs')
  const peer = createRelayClient({ nodeId: 'peer-device', account: ACCOUNT, baseUrl, dataKey: deriveDataKey(ROOT_KEY), enrollment: 'synthetic-e2e-enrollment' })
  await peer.register()
  const pr = await peer.round()
  assert.ok(pr.pulled >= 3, 'peer pulled the app revisions')

  // app-side materialization: export the recorded DAG the same way the adapter does and
  // compare against what the peer materialized (same convergence surface, real db source)
  const rev = db.__revisionsForTests
  const appMaterialized = materializedAll(rev.exportToStore(createRevisionStore, applyEnvelope))
  const peerMaterialized = peer.materialized()
  for (const id of ['e1', 'e2']) {
    assert.equal(peerMaterialized[id], appMaterialized[id], `peer converged with the app on entity ${id}`)
  }

  // bidirectional: peer writes, the app-side round pulls + verifies + advances the cursor
  // (row hydration into the business tables is the engine worktree's v2-apply slice; the
  // transport boundary here is download → verify → merge → ACK/advance, spec §18)
  await peer.commit('e3', { title: 'written by the peer' })
  await peer.round()
  const round2 = await dbSyncOps.dispatch('relaySyncNow')
  assert.equal(round2.ok, true, round2.error || '')
  assert.ok(round2.pulled >= 1, 'app round pulled the peer revision')
  assert.ok(round2.cursor > round.cursor, 'cursor advanced past the peer frames')

  // durable ACK: both devices have a real ack floor on the relay (GC not pinned at 0)
  const devices = relay.store.__dump().devices
  const appDevice = devices.find(d => d.deviceId === enabled.nodeId)
  const peerDevice = devices.find(d => d.deviceId === 'peer-device')
  assert.ok(appDevice && appDevice.lastAck > 0, 'app device ack floor advanced')
  assert.ok(peerDevice && peerDevice.lastAck > 0, 'peer ack floor advanced')

  // restart persistence: tear the bootstrap singleton down and rebuild it over the SAME db —
  // the credential + cursor resume (no re-register, no re-push of old revisions)
  relayBootstrap.__test.reset()
  relayBootstrap.initRelaySync()
  const after = dbSyncOps.dispatch('relayGetStatus')
  assert.equal(after.enabled, true, 'enabled flag survived the restart')
  assert.equal(after.hasDeviceSecret, true, 'device secret survived the restart')
  const envelopesBefore = relay.store.__dump().envelopes.length
  const devicesBefore = relay.store.__dump().devices.length
  db.call('upsert', { taskId: 'e4', title: 'post-restart write', createdAt: 4, updatedAt: 300 })
  const round3 = await dbSyncOps.dispatch('relaySyncNow')
  assert.equal(round3.ok, true, round3.error || '')
  const dumpAfter = relay.store.__dump()
  assert.equal(dumpAfter.devices.length, devicesBefore, 'no re-register after restart: secret was attached')
  assert.ok(dumpAfter.envelopes.length >= envelopesBefore + 1, 'the new revision (plus any bookkeeping meta revisions recorded since the last persist) landed')
  const opIds = dumpAfter.envelopes.map(e => e.opId)
  assert.equal(new Set(opIds).size, opIds.length, 'no duplicate envelopes after restart (durable pushed-set suppressed replays)')

  // disable through the op surface: rounds become no-ops, config + secrets retained
  const disabled = await dbSyncOps.dispatch('relaySetEnabled', { enabled: false })
  assert.equal(disabled.enabled, false)
  const skipped = await dbSyncOps.dispatch('relaySyncNow')
  assert.equal(skipped.skipped, 'disabled')
  const status = dbSyncOps.dispatch('relayGetStatus')
  assert.equal(status.hasDeviceSecret, true, 'disable retains the credential for re-enable')
})

test('e2e: bootstrap without lan-sync init still resolves a fallback device identity', async t => {
  // db IS initialized but lan-sync-bootstrap never ran initLanSync — resolveNodeId must have
  // fallen back to the self-managed sync.relay.nodeId, and init stays a singleton.
  const st = relayBootstrap.__test.getState()
  assert.ok(st && st.adapter, 'bootstrap singleton alive from the main e2e test')
  assert.ok(st.adapter.nodeId, 'adapter has a stable nodeId')
  const again = relayBootstrap.initRelaySync()
  assert.equal(again, st, 'initRelaySync is idempotent (single adapter)')
})
