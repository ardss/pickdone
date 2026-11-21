/* QA-R7 §7 regression — six-digit-code discovery died cross-machine because mDNS QUERIES often
 * get no answer across machines (Windows responder/firewall quirks) while mDNS ANNOUNCES do
 * cross; the old startAdvertising ran the UDP fallback ONLY when bonjour-service was absent,
 * so on a normal install discovery depended entirely on cross-machine mDNS query round-trips.
 * Fix: the UDP fallback channel now runs ALWAYS — alongside bonjour when present.
 * Proves: with a FAKE bonjour module present, startAdvertising still binds the UDP fallback
 * (advertise interval alive) AND a UDP announcement from a peer is received and upserted.
 * Run: node --test tests/unit/lan-sync/qa-r7-dual-channel-discovery.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import dgram from 'node:dgram'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')
const path = require_('node:path')

function freeUdpPort () {
  return new Promise((resolve, reject) => {
    const s = dgram.createSocket('udp4')
    s.once('error', reject)
    s.bind(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)) })
  })
}

function canBindUdp () {
  return new Promise(resolve => {
    const s = dgram.createSocket('udp4')
    s.once('error', () => { try { s.close() } catch {} resolve(false) })
    s.bind(0, () => { try { s.close() } catch {} resolve(true) })
  })
}

/** Load discovery.js fresh with a FAKE bonjour-service PRESENT (the normal-install path). */
function loadDualChannelDiscovery (port) {
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'bonjour-service') {
      const published = []
      return {
        Bonjour: class {
          publish (svc) { published.push(svc); return { stop: () => {} } }
          find (_opts, _cb) { return { stop: () => {} } }
          destroy () {}
        },
        _published: [],
      }
    }
    return origLoad.call(this, request, parent, isMain)
  }
  process.env.LAN_SYNC_UDP_FALLBACK_INTERVAL_MS = '200'
  if (port) process.env.LAN_SYNC_UDP_FALLBACK_PORT = String(port)
  const resolved = require_.resolve(path.join(import.meta.dirname, '../../../src/main/lan-sync/discovery.js'))
  delete require_.cache[resolved]
  try { return require_(resolved) } finally { Module._load = origLoad }
}

test('dual-channel: bonjour present does NOT suppress the UDP fallback (QA-R7 §7)', { skip: await canBindUdp() ? false : 'host cannot bind UDP' }, async () => {
  const port = await freeUdpPort()
  const mod = loadDualChannelDiscovery(port)
  const d = mod.createDiscovery()
  try {
    d.startAdvertising({ deviceId: 'qa-r7-dual-self', name: 'qa-r7-dual-self', port: 58001 })
    // The bind is async (candidate walk) — wait for the advertise interval to come alive.
    const becameActive = await new Promise(resolve => {
      const started = Date.now()
      const tick = () => {
        if (d._udpAdvertiseActive()) return resolve(true)
        if (Date.now() - started > 3000) return resolve(false)
        setTimeout(tick, 50)
      }
      tick()
    })
    // The core assertion: the fallback socket + advertise interval are alive WITH bonjour present.
    assert.equal(becameActive, true, 'UDP fallback must run alongside bonjour')
    assert.ok(d._udpSocket(), 'fallback socket must exist')

    // A peer announcement arriving over the UDP channel must upsert (discovery listens, not just talks).
    const found = new Promise(resolve => d.on('found', p => resolve(p)))
    const sender = dgram.createSocket('udp4')
    const payload = Buffer.from(JSON.stringify({ deviceId: 'qa-r7-dual-peer', name: 'QA-R7 Peer', port: 58002 }))
    await new Promise(r => sender.bind(0, '127.0.0.1', r))
    await new Promise(r => sender.send(payload, port, '127.0.0.1', r))
    const peer = await Promise.race([found, new Promise((_, rej) => setTimeout(() => rej(new Error('peer announcement not received within 5s')), 5000))])
    assert.equal(peer.deviceId, 'qa-r7-dual-peer')
    assert.equal(d.getPeers().some(p => p.deviceId === 'qa-r7-dual-peer'), true)
    sender.close()
  } finally {
    d.stop()
  }
})
