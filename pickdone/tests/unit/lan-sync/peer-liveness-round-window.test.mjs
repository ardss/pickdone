import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createLanSyncNode, recentlyReachable, ONLINE_WINDOW_MS } = require('../../../src/main/lan-sync/index.js')

test('LAN peer liveness window covers the five-minute automatic sync interval plus scheduling slack', () => {
  const bootstrap = readFileSync(path.resolve(import.meta.dirname, '../../../src/main/lan-sync-bootstrap.js'), 'utf8')
  const match = bootstrap.match(/const ROUND_INTERVAL_MS = (\d+) \* (\d+) \* (\d+)/)
  assert.ok(match, 'periodic LAN sync interval must remain visible to liveness contract')
  const roundMs = Number(match[1]) * Number(match[2]) * Number(match[3])
  assert.ok(ONLINE_WINDOW_MS > roundMs, 'healthy paired peers must not go offline between scheduled rounds')
  assert.ok(ONLINE_WINDOW_MS <= roundMs + 90_000, 'offline detection must not be delayed excessively')
})

test('recent authenticated sync persists across a normal idle interval, then expires without a fresh round', () => {
  const now = 2_000_000_000_000
  const roundAt = now - (5 * 60_000 + 20_000)
  assert.equal(recentlyReachable(now, undefined, roundAt), true)
  assert.equal(recentlyReachable(now, undefined, now - 90_001), true)
  assert.equal(recentlyReachable(now, undefined, now - ONLINE_WINDOW_MS), false)
  assert.equal(recentlyReachable(now, undefined, now - ONLINE_WINDOW_MS + 1), true)
  assert.equal(recentlyReachable(now, undefined, now + 10), false, 'future timestamps are not reachable evidence')
  assert.equal(recentlyReachable(now, null, null), false, 'never paired does not become online')
  assert.equal(recentlyReachable(now, now - 12_000, null), true, 'fresh discovery also establishes liveness')
})

test('Device Center status uses same grace window as peer-online/offline events', async () => {
  const fakeDiscovery = { startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] }
  const node = createLanSyncNode({
    deviceId: 'self-liveness', name: 'Self', pairingSecret: 'unit-key',
    port: 0, host: '127.0.0.1', ownHosts: [], discoverFn: fakeDiscovery,
    ingestSegment: () => {}, ingestSnapshot: () => {}, buildSegments: () => [],
  })
  const originalNow = Date.now
  const base = 2_000_000_000_000
  try {
    Date.now = () => base
    node.addPeer({ deviceId: 'peer-liveness', name: 'Peer', host: '127.0.0.1', port: 58471 })
    Date.now = () => base + 5 * 60_000 + 30_000
    assert.equal(node.getStatus().peers[0].online, true, 'should not flicker offline in idle gap')
    Date.now = () => base + ONLINE_WINDOW_MS + 5_000
    assert.equal(node.getStatus().peers[0].online, false, 'actually stale peer must still expire')
  } finally {
    Date.now = originalNow
    await node.stop()
  }
})
