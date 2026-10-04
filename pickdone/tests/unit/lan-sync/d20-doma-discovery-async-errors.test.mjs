/**
 * D20-DOM-A C4 regression — UDP fallback dead-channel guard counts ASYNC send failures:
 *   - a send whose callback reports an error (not a sync throw) must count as a failed sweep;
 *   - post-bind socket 'error' events must count toward the 3-failed-sweep budget.
 * Pre-fix: the send callback was `() => {}` and the post-bind 'error' handler only logged, so
 * a dead NIC / dead post-bind socket kept the channel "healthy" forever.
 * Run: node --test tests/unit/lan-sync/d20-doma-discovery-async-errors.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')
const path = require_('node:path')

// Shrink the sweep cadence BEFORE discovery.js is loaded (it reads env at module load) and
// force the UDP fallback path by hiding bonjour-service.
process.env.LAN_SYNC_UDP_FALLBACK_INTERVAL_MS = '60'
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

async function bindADiscovery (deviceId) {
  const discovery = loadUdpFallbackDiscovery()
  const disc = discovery.createDiscovery()
  disc.startAdvertising({ deviceId, name: deviceId, port: 58999 })
  const t0 = Date.now()
  while (!disc.udpFallbackPort() && Date.now() - t0 < 15000) await new Promise((r) => setTimeout(r, 50))
  assert.ok(disc.udpFallbackPort() > 0, 'UDP fallback bound (precondition)')
  return disc
}

test('C4: three consecutive ASYNC send-callback errors declare the channel dead', async () => {
  const disc = await bindADiscovery('d20-async')
  const sock = disc._udpSocket()
  // Async error path: the callback fires with an error (pre-fix: silently dropped).
  sock.send = (...args) => {
    const cb = args[args.length - 1]
    setImmediate(() => cb(new Error('simulated async send failure')))
  }
  const deadline = Date.now() + 5000
  while (disc._udpAdvertiseActive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  assert.equal(disc._udpAdvertiseActive(), false, 'channel declared dead after 3 async-failed sweeps (red before the fix: stayed active forever)')
  assert.equal(disc._udpSocket(), null, 'the dead channel socket is released (D15 C5 leak guard)')
  disc.stop()
})

test('C4: post-bind socket error events feed the sweep budget (3 in a row = dead)', async () => {
  const disc = await bindADiscovery('d20-sockerr')
  try {
    const sock = disc._udpSocket()
    const emitErr = () => sock.emit('error', Object.assign(new Error('simulated post-bind failure'), { code: 'EFAKE' }))
    emitErr()
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(disc._udpAdvertiseActive(), true, 'one failed sweep does NOT kill the channel')
    // The streak must be CONSECUTIVE failed sweeps: emit an error inside every sweep window
    // (interval is 60ms; 50ms gaps keep each sweep's consumed flag fresh).
    for (let i = 0; i < 5; i++) { emitErr(); await new Promise((r) => setTimeout(r, 50)) }
    const deadline = Date.now() + 5000
    while (disc._udpAdvertiseActive() && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    assert.equal(disc._udpAdvertiseActive(), false, 'red before the fix: post-bind errors only logged and never counted — the channel stayed active forever')
  } finally {
    disc.stop()
  }
})
