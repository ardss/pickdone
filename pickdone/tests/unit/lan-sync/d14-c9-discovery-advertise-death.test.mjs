/* D14 C9 regression — UDP discovery: a socket that dies AFTER bind must stop the advertise
 * interval instead of warn-forever every 2s for the process lifetime. Two death paths covered:
 * an unexpected post-bind socket close, and 3 consecutive failed send sweeps.
 * Run: node --test tests/unit/lan-sync/d14-c9-discovery-advertise-death.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import net from 'node:net'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

/** Grab a free TCP port from the OS (bind 0, read, close) — used as the ADVERTISED service
 *  port only (the UDP bind walks FALLBACK_PORT_CANDIDATES internally). Flake fix (2026-10-09):
 *  both tests used to hard-code 58999, colliding with anything else that claimed the port. */
function freePort () {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

/** Grab a free UDP port (bind 0, read, close) — pinned via LAN_SYNC_UDP_FALLBACK_PORT so the
 *  test never competes for the fixed 58471-family candidates. Root fix (2026-10-10 R2): the
 *  fallback walks its candidate list ONCE and gives up PERMANENTLY on exhaustion, so a runner
 *  where a fixed port is transiently busy/denied (ubuntu CI, the C9 flake family) meant 15s
 *  of never binding although the host can bind UDP fine. */
function freeUdpPort () {
  return new Promise((resolve, reject) => {
    const s = require_('node:dgram').createSocket('udp4')
    s.once('error', reject)
    s.bind(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

/** Load discovery.js fresh with bonjour-service unavailable → UDP fallback path. */
function loadUdpFallbackDiscovery (port) {
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'bonjour-service') throw new Error('simulated offline install')
    return origLoad.call(this, request, parent, isMain)
  }
  // D21 flake-hardening: pin a fast test cadence so the 3-sweep deadline cannot be outrun by
  // pool-load timer lag (the production default 2000ms made the 9s budget load-sensitive).
  process.env.LAN_SYNC_UDP_FALLBACK_INTERVAL_MS = '200'
  if (port) process.env.LAN_SYNC_UDP_FALLBACK_PORT = String(port)
  const resolved = require_.resolve(path.join(import.meta.dirname, '../../../src/main/lan-sync/discovery.js'))
  delete require_.cache[resolved]
  try { return require_(resolved) } finally { Module._load = origLoad }
}
const path = require_('node:path')

/** Can THIS host bind a plain UDP socket at all? Some CI runners deny LAN UDP binds entirely;
 *  there the fallback path never gets a socket and the death-sweep behavior under test is
 *  unreachable — failing there measured the runner, not the code (ubuntu CI flake 2026-10-09).
 *  A genuine code regression still fails loudly on any host where the probe bind succeeds. */
function canBindUdp () {
  return new Promise(resolve => {
    const s = require_('node:dgram').createSocket('udp4')
    s.once('error', () => { try { s.close() } catch {} resolve(false) })
    s.bind(0, () => { try { s.close() } catch {} resolve(true) })
  })
}

test('C9: post-bind socket death stops the advertise interval (no warn-forever loop)', async () => {
  const discovery = loadUdpFallbackDiscovery(await freeUdpPort())
  const disc = discovery.createDiscovery()
  disc.startAdvertising({ deviceId: 'd14c9', name: 'd14c9', port: await freePort() })
  const t0 = Date.now()
  while (!disc.udpFallbackPort() && Date.now() - t0 < 15000) await new Promise(r => setTimeout(r, 50))
  if (!disc.udpFallbackPort()) {
    disc.stop()
    if (await canBindUdp()) assert.fail('UDP fallback never bound although this host CAN bind UDP sockets')
    console.log('[skip-env] host denies UDP binds — death-sweep needs a real socket; gated pass')
    return
  }
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
  const discovery = loadUdpFallbackDiscovery(await freeUdpPort())
  const disc = discovery.createDiscovery()
  disc.startAdvertising({ deviceId: 'd14c9b', name: 'd14c9b', port: await freePort() })
  const t0 = Date.now()
  while (!disc.udpFallbackPort() && Date.now() - t0 < 15000) await new Promise(r => setTimeout(r, 50))
  if (!disc.udpFallbackPort()) {
    disc.stop()
    if (await canBindUdp()) assert.fail('UDP fallback never bound although this host CAN bind UDP sockets')
    console.log('[skip-env] host denies UDP binds — send-sweep death needs a real socket; gated pass')
    return
  }
  assert.ok(disc.udpFallbackPort() > 0)
  const sock = disc._udpSocket()
  sock.send = () => { throw new Error('simulated dead NIC') } // every sweep throws synchronously
  // 3 sweeps at FALLBACK_INTERVAL_MS=2000 → ~6.5s budget, then the interval must stop itself
  const deadline = Date.now() + 9000
  while (disc._udpAdvertiseActive() && Date.now() < deadline) await new Promise(r => setTimeout(r, 100))
  assert.equal(disc._udpAdvertiseActive(), false, 'channel declared dead after 3 failed sweeps (bounded, not warn-forever)')
  disc.stop()
})
