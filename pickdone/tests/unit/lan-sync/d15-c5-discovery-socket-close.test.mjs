/* D15 C5 regression — discovery closes the UDP sockets it stops. Two leak paths:
 *   (a) total bind failure (every candidate port exhausted) left the unbound socket open;
 *   (b) the dead-channel path (3 consecutive failed sweeps) stopped the interval but left
 *       the socket open.
 * Run: node --test tests/unit/lan-sync/d15-c5-discovery-socket-close.test.mjs
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
  const resolved = require_.resolve(path.join(import.meta.dirname, '../../../src/main/lan-sync/discovery.js'))
  delete require_.cache[resolved]
  try { return require_(resolved) } finally { Module._load = origLoad }
}
const path = require_('node:path')
const dgram = require_('node:dgram')

test('C5: total bind failure closes the dead socket (no leaked dgram handle)', async () => {
  // Occupy EVERY candidate port so every bind attempt fails EADDRINUSE.
  const { FALLBACK_PORT_CANDIDATES } = loadUdpFallbackDiscovery()
  const blockers = []
  for (const p of FALLBACK_PORT_CANDIDATES) {
    const b = dgram.createSocket('udp4')
    try { await new Promise((res, rej) => { b.on('error', rej); b.bind(p, res) }) } catch { /* candidate already taken: fine */ }
    blockers.push(b)
  }
  const discovery = loadUdpFallbackDiscovery()
  const disc = discovery.createDiscovery()
  try {
    disc.startAdvertising({ deviceId: 'd15c5a', name: 'd15c5a', port: 58999 })
    // bind attempts walk all candidates; each failure needs a tick — wait for the socket
    // handle to be released (red before the fix: the last dead socket stays open forever).
    const deadline = Date.now() + 8000
    while (disc._udpSocket() !== null && Date.now() < deadline) await new Promise(r => setTimeout(r, 50))
    assert.equal(disc._udpSocket(), null, 'after every candidate fails, the dead socket must be closed (red before: left open)')
    assert.equal(disc.udpFallbackPort(), 0, 'no port is bound')
  } finally {
    disc.stop()
    for (const b of blockers) { try { b.close() } catch { /* noop */ } }
  }
})

test('C5: dead advertise channel (3 failed sweeps) closes the socket too', async () => {
  const discovery = loadUdpFallbackDiscovery()
  const disc = discovery.createDiscovery()
  try {
    disc.startAdvertising({ deviceId: 'd15c5b', name: 'd15c5b', port: 58999 })
    const t0 = Date.now()
    while (!disc.udpFallbackPort() && Date.now() - t0 < 5000) await new Promise(r => setTimeout(r, 50))
    assert.ok(disc.udpFallbackPort() > 0, 'UDP fallback bound')
    const sock = disc._udpSocket()
    const closed = new Promise(r => sock.on('close', r))
    sock.send = () => { throw new Error('simulated dead NIC') }
    await closed // the socket must be closed when the channel is declared dead (red before: left open)
    // give the module a tick to null its reference
    const deadline = Date.now() + 2000
    while (disc._udpSocket() !== null && Date.now() < deadline) await new Promise(r => setTimeout(r, 25))
    assert.equal(disc._udpSocket(), null, 'socket reference released after channel death')
  } finally {
    disc.stop()
  }
})
