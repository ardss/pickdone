'use strict'

/**
 * LAN sync discovery: mDNS advertise + browse for pickdone-sync._tcp peers.
 *
 * Primary path uses the pure-JS `bonjour-service` package. If the package is
 * unavailable (offline install), this module transparently falls back to a
 * minimal UDP broadcast discovery on port 58471 (same payload shape).
 *
 * Peers are deduped by deviceId; re-seeing a known deviceId refreshes its
 * host/port/lastSeen instead of emitting a duplicate onFound.
 *
 * Pure Node (dgram + optional bonjour-service), no Electron imports. CommonJS.
 */

const { EventEmitter } = require('node:events')
const dgram = require('node:dgram')

const SERVICE_TYPE = 'pickdone-sync'
// Bumped 1 -> 2 with the encrypted transport (cipher.js): protoVer is advertised, not
// enforced, but stays consistent with transport.js PROTO_VER semantics.
const PROTO_VER = 2
const FALLBACK_PORT = 58471
const FALLBACK_INTERVAL_MS = 2000

let bonjourModule = null
try {
  // eslint-disable-next-line global-require
  bonjourModule = require('bonjour-service')
} catch {
  bonjourModule = null // offline install: UDP fallback below
}

/**
 * Create a discovery instance.
 * @returns {{startAdvertising:Function, discover:Function, stop:Function, getPeers:Function, on:EventEmitter.on}}
 */
function createDiscovery() {
  const em = new EventEmitter()
  const peers = new Map() // deviceId -> {deviceId, name, host, port, lastSeen}
  let bonjour = null
  let advertisedService = null
  let browser = null
  let udp = null
  let udpTimer = null
  let stopped = false

  function upsertPeer(info) {
    if (!info || typeof info.deviceId !== 'string' || !info.deviceId) return null
    if (typeof info.port !== 'number' || !Number.isInteger(info.port) || info.port <= 0) return null
    const existing = peers.get(info.deviceId)
    const peer = {
      deviceId: info.deviceId,
      name: info.name || info.deviceId,
      host: info.host || '127.0.0.1',
      port: info.port,
      protoVer: info.protoVer || PROTO_VER,
      lastSeen: Date.now(),
    }
    const isNew = !existing
    peers.set(info.deviceId, peer)
    if (isNew && !stopped) em.emit('found', peer)
    return peer
  }

  function startAdvertising({ deviceId, name, port }) {
    if (!deviceId || !Number.isInteger(port)) throw new Error('startAdvertising: deviceId and integer port required')
    if (bonjourModule) {
      bonjour = new bonjourModule.Bonjour()
      advertisedService = bonjour.publish({
        name: `pickdone-${deviceId}`,
        type: SERVICE_TYPE,
        port,
        txt: { deviceId, name: name || deviceId, protoVer: String(PROTO_VER) },
      })
    } else {
      startUdpFallback({ deviceId, name, port })
    }
  }

  function startUdpFallback({ deviceId, name, port }) {
    udp = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    const payload = Buffer.from(JSON.stringify({ deviceId, name: name || deviceId, port, protoVer: PROTO_VER }))
    udp.on('message', (buf) => {
      try {
        upsertPeer(JSON.parse(buf.toString('utf8')))
      } catch { /* malformed broadcast */ }
    })
    udp.on('error', (err) => {
      // Best-effort fallback, but never silent: an unlogged bind/send failure made the whole
      // discovery channel look healthy while discovering nothing. Keep the socket alive (a later
      // EADDRINUSE from a second instance must not kill the app); just leave a trace.
      try { require('electron-log').warn(`[LanSync] UDP discovery fallback error${err && err.code ? ' (' + err.code + ')' : ''}:`, err && err.message) } catch { /* electron-log unavailable in pure-node contexts */ }
    })
    udp.bind(FALLBACK_PORT, () => {
      udp.setBroadcast(true)
      udpTimer = setInterval(() => {
        udp.send(payload, FALLBACK_PORT, '255.255.255.255', () => {})
      }, FALLBACK_INTERVAL_MS)
      udpTimer.unref?.()
    })
  }

  function discover(onFound) {
    if (typeof onFound === 'function') em.on('found', onFound)
    if (bonjourModule) {
      bonjour = bonjour || new bonjourModule.Bonjour()
      browser = bonjour.find({ type: SERVICE_TYPE }, (svc) => {
        upsertPeer({
          deviceId: svc.txt && svc.txt.deviceId,
          name: svc.txt && svc.txt.name,
          host: (svc.addresses && svc.addresses[0]) || svc.host,
          port: svc.port,
          protoVer: svc.txt && Number(svc.txt.protoVer),
        })
      })
    }
    // UDP fallback listener is started by startAdvertising; nothing extra here.
  }

  function stop() {
    stopped = true
    if (udpTimer) { clearInterval(udpTimer); udpTimer = null }
    if (browser) { try { browser.stop() } catch { /* noop */ } browser = null }
    if (advertisedService) { try { advertisedService.stop() } catch { /* noop */ } advertisedService = null }
    if (bonjour) { try { bonjour.destroy() } catch { /* noop */ } bonjour = null }
    if (udp) { try { udp.close() } catch { /* noop */ } udp = null }
  }

  return {
    startAdvertising,
    discover,
    stop,
    getPeers: () => Array.from(peers.values()),
    on: em.on.bind(em),
    _upsertPeer: upsertPeer, // test hook (injected peer lists)
  }
}

module.exports = { createDiscovery, SERVICE_TYPE, PROTO_VER, FALLBACK_PORT }
