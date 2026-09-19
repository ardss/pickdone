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
// Bounded bookkeeping (round-3 review): a UDP/mDNS flood of forged deviceIds must not grow the
// peer map without limit. Beyond MAX_PEERS the least-recently-seen peer is evicted.
const MAX_PEERS = 64
// UDP fallback rate limit (round-3 review): at most one accepted upsert per source IP per this
// interval — legitimate broadcasters announce every FALLBACK_INTERVAL_MS, so 500ms discards
// flood traffic while never dropping a real peer announcement.
const UDP_UPSERT_MIN_INTERVAL_MS = 500

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
  const lastUpsertByIp = new Map() // ip -> last accepted UDP upsert (rate limit, see constant)
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
    if (!existing && peers.size >= MAX_PEERS) {
      // LRU eviction: expel the least-recently-seen peer (never the incoming one).
      let oldestId = null
      let oldestAt = Infinity
      for (const [id, p] of peers) {
        if (p.lastSeen < oldestAt) { oldestAt = p.lastSeen; oldestId = id }
      }
      if (oldestId) peers.delete(oldestId)
    }
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
      // P2 2026-09-20: repeated startAdvertising used to orphan the previous Bonjour instance —
      // its published service + sockets stayed alive until GC (duplicate mDNS records, leaked
      // handles). Destroy the old instance (which owns the browser + advertised service) before
      // recreating.
      if (bonjour) {
        if (advertisedService) { try { advertisedService.stop() } catch { /* noop */ } }
        if (browser) { try { browser.stop() } catch { /* noop */ } }
        try { bonjour.destroy() } catch { /* noop */ }
        bonjour = null; advertisedService = null; browser = null
      }
      bonjour = new bonjourModule.Bonjour()
      advertisedService = bonjour.publish({
        name: `pickdone-${deviceId}`,
        type: SERVICE_TYPE,
        port,
        txt: { deviceId, name: name || deviceId, protoVer: String(PROTO_VER) },
      })
    } else {
      // UDP fallback: same leak guard — close the previous socket + interval before recreating.
      if (udpTimer) { clearInterval(udpTimer); udpTimer = null }
      if (udp) { try { udp.close() } catch { /* noop */ } udp = null }
      startUdpFallback({ deviceId, name, port })
    }
  }

  function startUdpFallback({ deviceId, name, port }) {
    udp = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    const payload = Buffer.from(JSON.stringify({ deviceId, name: name || deviceId, port, protoVer: PROTO_VER }))
    udp.on('message', (buf, rinfo) => {
      try {
        // Per-source rate limit (round-3 review): a flood of UDP broadcasts from one IP must not
        // burn CPU on JSON.parse + upsert. Known peers re-announce every ~2s, so a 500ms floor
        // per source IP never drops a legitimate announcement.
        const ip = rinfo && rinfo.address
        const now = Date.now()
        const last = lastUpsertByIp.get(ip) || 0
        if (now - last < UDP_UPSERT_MIN_INTERVAL_MS) return
        lastUpsertByIp.set(ip, now)
        if (lastUpsertByIp.size >= 1024) lastUpsertByIp.clear() // spoofed-source flood guard
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
    if (typeof onFound === 'function') {
      // P2 2026-09-20: repeated discover() with the same callback used to stack duplicate
      // 'found' listeners (each duplicate emits a second onFound per peer + a MaxListeners
      // warning). Dedupe: remove-then-add keeps exactly one registration per callback.
      em.removeListener('found', onFound)
      em.on('found', onFound)
    }
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
