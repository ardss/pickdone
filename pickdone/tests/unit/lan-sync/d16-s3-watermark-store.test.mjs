/**
 * S3 regression (2026-10-03): 'a deleted/invalidated watermark stays deleted until a real
 * pairing event' is encoded at the ONE watermark-store ownership point.
 *
 * Pre-fix interleaving being pinned: unpair point-deleted the settings key + live Map entry,
 * but an in-flight ack from the still-authenticated round ran client-round's
 * peerProgress.set(deviceId, seq) into the SAME Map while stopSync awaited n.stop(); stopSync's
 * settle-point then persisted the WHOLE Map back into the settings row — resurrecting the
 * deleted watermark. A stale push watermark suppresses re-push of rows <= that seq on re-pair
 * (sync-matrix.md §5.3) — the data-loss class the unpair flow's own comment forbids.
 *
 * Invariants asserted here (store level + bootstrap wiring):
 *   1. revoke() removes the id from the live map AND persists the revocation (survives restart).
 *   2. the advance path (peerProgress.set) is FILTERED for a revoked id — the in-flight ack
 *      cannot re-insert; a whole-map persist cannot write it back.
 *   3. only a successful persistPairedPeer (reinstate) re-opens the id.
 *   4. invalidate() clears live watermarks but keeps revocations.
 *   5. S6: a failed read degrades persistence — the durable row is never overwritten by a map
 *      derived from a failed read.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const createPeerWatermarkStore = require('../../../src/main/lan-sync/watermark-store.js')
const createJsonSettingStore = require('../../../src/main/lan-sync/settings-map-store.js')
const bootstrap = require('../../../src/main/lan-sync-bootstrap.js')

function makeDb () {
  const rows = new Map()
  return {
    rows,
    settingGet: key => rows.has(key) ? rows.get(key) : null,
    settingPut: (key, value) => { rows.set(key, value) },
  }
}

test('S3: revoke survives restart; the ack advance path cannot re-insert; only reinstate re-opens', () => {
  const { settingGet, settingPut, rows } = makeDb()
  const store = createJsonSettingStore({ settingGet, settingPut, log: console, key: 'sync.peerWatermarks.v2', name: 'peer watermarks', defaultValue: '{}' })
  const wm = createPeerWatermarkStore({ settingGet, settingPut, log: console, key: 'sync.peerWatermarks.v2', store })
  rows.set('sync.peerWatermarks.v2', JSON.stringify({ 'p1': 5, 'p2': 9 }))

  // Unpair p1: revoke + persist (what pair-ops does now).
  const tracked = wm.createTracked()
  assert.equal(tracked.get('p1'), 5)
  tracked.revoke('p1')
  wm.persist(tracked)
  assert.ok(!JSON.parse(rows.get('sync.peerWatermarks.v2'))['p1'], 'the unpaired watermark is gone from the durable row')

  // "Restart": reload from settings. Then the in-flight ack lands (peerProgress.set).
  const tracked2 = wm.createTracked()
  assert.equal(tracked2.get('p1'), undefined, 'the revoked watermark must not survive a restart')
  assert.equal(tracked2.get('p2'), 9, 'unrelated watermarks survive')
  tracked2.set('p1', 42) // the ack advance path (client-round) — MUST be filtered
  wm.persist(tracked2)
  const durable = JSON.parse(rows.get('sync.peerWatermarks.v2'))
  assert.equal(durable['p1'], undefined, 'the whole-map persist cannot resurrect the deleted watermark')
  assert.ok(Array.isArray(durable.__revoked) && durable.__revoked.includes('p1'), 'the revocation itself persists across restarts')

  // Re-pair: persistPairedPeer success -> reinstate -> the id works again.
  tracked2.reinstate('p1')
  tracked2.set('p1', 42)
  const afterReinstate = JSON.parse(rows.get(wm.persist(tracked2) && 'sync.peerWatermarks.v2'))
  assert.equal(afterReinstate['p1'], 42, 'a real pairing event re-opens the watermark')
  assert.equal(afterReinstate.__revoked, undefined, 'the revocation list is cleared once empty')
})

test('S3: invalidate clears live watermarks but KEEPS revocations', () => {
  const { settingGet, settingPut, rows } = makeDb()
  const store = createJsonSettingStore({ settingGet, settingPut, log: console, key: 'k', name: 'wm', defaultValue: '{}' })
  const wm = createPeerWatermarkStore({ settingGet, settingPut, log: console, key: 'k', store })
  rows.set('k', JSON.stringify({ a: 1, b: 2, __revoked: ['b'] }))
  const tracked = wm.createTracked()
  wm.invalidate(tracked)
  const durable = JSON.parse(rows.get('k'))
  assert.equal(durable.a, undefined, 'recovery clears every live watermark (full re-push)')
  assert.deepEqual(durable.__revoked, ['b'], 'a revoked pairing must not resurrect via recovery either')
})

test('S3/S6 wiring: bootstrap persist skips after a failed boot read — durable row never overwritten', () => {
  const { rows } = makeDb()
  const CORRUPT = '{"peer-x": 42,,,' // undecodable durable value
  rows.set('sync.peerWatermarks.v2', CORRUPT)
  const settingsMap = new Map(rows)
  const db = {
    call (op, p) {
      if (op === 'settingsRowPut') { settingsMap.set(p.key, p.value); return null }
      if (op === 'settingsRowsAll') return [...settingsMap.entries()].map(([key, value]) => ({ key, value, deleted: false }))
      return null
    },
  }
  const { wm, store } = bootstrap.__test.makeWatermarkStoresForDb(db)
  const degraded = wm.createTracked()
  assert.equal(degraded.size, 0, 'a failed read seeds nothing')
  degraded.set('peer-y', 7) // a round "confirmed" an ack
  const persisted = wm.persist(degraded)
  assert.equal(persisted, false, 'the whole-map persist must be skipped while degraded (S6)')
  assert.equal(store.canPersist(), false, 'the store latches degraded')
  assert.equal(settingsMap.get('sync.peerWatermarks.v2'), CORRUPT, 'the durable row is byte-identical — no write derived from a failed read')
})
