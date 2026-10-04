/* D14 C9 regression — UDP discovery: a socket that dies AFTER bind must stop the advertise
 * interval instead of warn-forever every 2s for the process lifetime. Two death paths covered:
 * an unexpected post-bind socket close, and 3 consecutive failed send sweeps.
 * Run: node --test tests/unit/lan-sync/d14-c9-discovery-advertise-death.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

/** Load discovery.js fresh with bonjour-service unavailable → UDP fallback path. */
function loadUdpFallbackDiscovery () {
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'bonjour-service') throw new Error('simulated offline install')
    return origLoad.call(this, request, parent, isMain)
  }
  // D21 flake-hardening: pin a fast test cadence so the 3-sweep deadline cannot be outrun by
  // pool-load timer lag (the production default 2000ms made the 9s budget load-sensitive).
  process.env.LAN_SYNC_UDP_FALLBACK_INTERVAL_MS = '200'
  const resolved = require_.resolve(path.join(import.meta.dirname, '../../../src/main/lan-sync/discovery.js'))
  delete require_.cache[resolved]
  try { return require_(resolved) } finally { Module._load = origLoad }
}
const path = require_('node:path')

test('C9: post-bind socket death stops the advertise interval (no warn-forever loop)', async () => {
  const discovery = loadUdpFallbackDiscovery()
  const disc = discovery.createDiscovery()
  disc.startAdvertising({ deviceId: 'd14c9', name: 'd14c9', port: 58999 })
  const t0 = Date.now()
  while (!disc.udpFallbackPort() && Date.now() - t0 < 15000) await new Promise(r => setTimeout(r, 50))
  assert.ok(disc.udpFallbackPort() > 0, 'UDP fallback bound')
  assert.equal(disc._udpAdvertiseActive(), true, 'advertise interval live after bind')
  // kill the socket underneath (simulates the interface/handle dying after bind)
  const sock = disc._udpSocket()
  sock.close()
  await new Promise(r => setTimeout(r, 150))
  assert.equal(disc._udpAdvertiseActive(), false, 'advertise interval cleared on unexpected post-bind close (red before the fix: warn every 2s forever)')
  disc.stop()
})

test('C9: three consecutive failed send sweeps declare the channel dead and stop advertising', async () => {
  const discovery = loadUdpFallbackDiscovery()
  const disc = discovery.createDiscovery()
  disc.startAdvertising({ deviceId: 'd14c9b', name: 'd14c9b', port: 58999 })
  const t0 = Date.now()
  while (!disc.udpFallbackPort() && Date.now() - t0 < 15000) await new Promise(r => setTimeout(r, 50))
  assert.ok(disc.udpFallbackPort() > 0)
  const sock = disc._udpSocket()
  sock.send = () => { throw new Error('simulated dead NIC') } // every sweep throws synchronously
  // 3 sweeps at FALLBACK_INTERVAL_MS=2000 → ~6.5s budget, then the interval must stop itself
  const deadline = Date.now() + 9000
  while (disc._udpAdvertiseActive() && Date.now() < deadline) await new Promise(r => setTimeout(r, 100))
  assert.equal(disc._udpAdvertiseActive(), false, 'channel declared dead after 3 failed sweeps (bounded, not warn-forever)')
  disc.stop()
})
