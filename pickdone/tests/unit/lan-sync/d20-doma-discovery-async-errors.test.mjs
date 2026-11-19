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

// Drive the UDP sweep deterministically. The full test pool can saturate the Windows
// event loop for seconds; wall-clock polling at a 60ms cadence can time out even when
// all three async callback failures are counted correctly.
async function bindControlledDiscovery (deviceId) {
  const original = globalThis.setInterval
  let sweep
  globalThis.setInterval = (callback, interval, ...args) => {
    if (interval === 60) {
      sweep = () => callback(...args)
      return original(callback, 3600000, ...args) // real timer retained for clearInterval
    }
    return original(callback, interval, ...args)
  }
  try {
    const disc = await bindADiscovery(deviceId)
    assert.equal(typeof sweep, 'function', 'advertise sweep registered after bind')
    return {
      disc,
      async drive () {
        sweep()
        await new Promise(resolve => setImmediate(resolve))
      },
      restore () { globalThis.setInterval = original }
    }
  } catch (e) {
    globalThis.setInterval = original
    throw e
  }
}

test('C4: three consecutive ASYNC send-callback errors declare the channel dead', async () => {
  const { disc, drive, restore } = await bindControlledDiscovery('d20-async')
  try {
    const sock = disc._udpSocket()
    sock.send = (...args) => {
      const cb = args[args.length - 1]
      setImmediate(() => cb(new Error('simulated async send failure')))
    }
    await drive()
    assert.equal(disc._udpAdvertiseActive(), true, 'one failed sweep must not close the socket')
    await drive()
    assert.equal(disc._udpAdvertiseActive(), true, 'two failed sweeps must not close the socket')
    await drive()
    assert.equal(disc._udpAdvertiseActive(), false, 'third callback-error sweep closes the channel')
    assert.equal(disc._udpSocket(), null, 'dead-channel socket released')
  } finally {
    disc.stop()
    restore()
  }
})

test('C4: post-bind socket error events feed the sweep budget (3 in a row = dead)', async () => {
  const { disc, drive, restore } = await bindControlledDiscovery('d20-sockerr')
  try {
    const sock = disc._udpSocket()
    sock.send = (...args) => setImmediate(() => args[args.length - 1](null))
    const emitErr = () => sock.emit('error', Object.assign(new Error('simulated post-bind failure'), { code: 'EFAKE' }))
    for (let i = 1; i <= 3; i++) {
      emitErr()
      await drive()
      assert.equal(disc._udpAdvertiseActive(), i < 3, 'consecutive error sweep ' + i)
    }
    assert.equal(disc._udpSocket(), null, 'socket released after third post-bind error')
  } finally {
    disc.stop()
    restore()
  }
})
