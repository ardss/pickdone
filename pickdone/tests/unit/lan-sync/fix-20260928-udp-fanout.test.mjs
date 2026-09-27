/**
 * Regression (2026-09-28): the UDP fallback broadcast used to go ONLY to the port the sender
 * itself bound (`const port = FALLBACK_PORT_CANDIDATES[candidateIdx++]` shadowed the destructured
 * TCP port argument, and the single send reused it). A host whose bind candidate landed on a low
 * candidate port and a healthy peer listening on the canonical port could never hear each other —
 * silent discovery partition. Fix: fan the broadcast out to EVERY candidate port + the advertised
 * TCP port, and rename the shadowing variable.
 *
 * This test stages exactly the partition: instance A is pinned (LAN_SYNC_UDP_FALLBACK_PORT) to
 * 58477; instance B is pinned to 39071, a DIFFERENT default candidate. Before the fix A's only
 * destination was 58477 and B (on 39071) discovered nothing; after the fix A's fan-out includes
 * 39071 and B discovers A.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import os from 'node:os'

const require = createRequire(import.meta.url)
const sleep = ms => new Promise(r => setTimeout(r, ms))

function withBonjourUnavailable (fn) {
  const Module = require('module')
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'bonjour-service') throw new Error('stubbed unavailable (UDP fallback test)')
    return origLoad.call(this, request, parent, isMain)
  }
  return Promise.resolve().then(fn).finally(() => { Module._load = origLoad })
}

/** Re-require discovery.js with a pinned env candidate (FALLBACK_PORT_CANDIDATES is require-time). */
function requirePinnedDiscovery (pinnedPort) {
  process.env.LAN_SYNC_UDP_FALLBACK_PORT = String(pinnedPort)
  try {
    delete require.cache[require.resolve('../../../src/main/lan-sync/discovery.js')]
    return require('../../../src/main/lan-sync/discovery.js')
  } finally {
    delete process.env.LAN_SYNC_UDP_FALLBACK_PORT
  }
}

test('UDP fallback fan-out: a host bound to a non-canonical candidate is still discovered by a peer listening on another candidate port', async () => {
  await withBonjourUnavailable(async () => {
    const modA = requirePinnedDiscovery(58477)
    const modB = requirePinnedDiscovery(39071)
    assert.notEqual(modA.FALLBACK_PORT_CANDIDATES[0], modB.FALLBACK_PORT_CANDIDATES[0], 'staged: the two instances pinned to different candidates')
    const A = modA.createDiscovery()
    const B = modB.createDiscovery()
    try {
      A.startAdvertising({ deviceId: 'fanout-a', name: 'Fanout-A', port: 58491 })
      B.startAdvertising({ deviceId: 'fanout-b', name: 'Fanout-B', port: 58492 })
      B.discover(() => {})
      const t0 = Date.now()
      while (Date.now() - t0 < 8000 && !B.getPeers().some(p => p.deviceId === 'fanout-a')) await sleep(200)
      const peer = B.getPeers().find(p => p.deviceId === 'fanout-a')
      assert.ok(peer, 'B discovered A across DIFFERENT bound candidate ports (fan-out works)')
      assert.ok(peer.host && peer.host !== '127.0.0.1', 'host is the real sender address: ' + peer.host)
      const locals = new Set()
      for (const l of Object.values(os.networkInterfaces())) for (const ni of l || []) if (ni && ni.address && !ni.internal) locals.add(ni.address)
      assert.ok(locals.has(peer.host), 'sender address is one of this machine’s own IPs')
    } finally {
      try { A.stop() } catch { /* noop */ }
      try { B.stop() } catch { /* noop */ }
    }
  })
})
