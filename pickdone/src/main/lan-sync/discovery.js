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
const os = require('node:os')

const SERVICE_TYPE = 'pickdone-sync'
// Bumped 1 -> 2 with the encrypted transport (cipher.js): protoVer is advertised, not
// enforced, but stays consistent with transport.js PROTO_VER semantics.
const PROTO_VER = 2
// UDP fallback port. WinNAT reserved ranges DRIFT BETWEEN REBOOTS and can swallow 58471 whole
// (bind EACCES; 2026-09-23 verified live: excluded range 58439-58538) — same environment failure
// class as the pickFreePort fix (c2e17f57). Candidates therefore span four discontiguous spans and
// the first BINDABLE port wins (bind-failure -> next candidate, never a silent dead channel).
// LAN_SYNC_UDP_FALLBACK_PORT pins a specific port as a manual escape hatch for fragmented networks
// (all peers on a LAN must broadcast on the same port; the deterministic candidate order makes
// healthy hosts converge on 58471 anyway).
const FALLBACK_PORT = 58471 // canonical port; first candidate (kept exported for compat)
const FALLBACK_PORT_CANDIDATES = [
  ...(Number(process.env.LAN_SYNC_UDP_FALLBACK_PORT) > 0 ? [Number(process.env.LAN_SYNC_UDP_FALLBACK_PORT)] : []),
  FALLBACK_PORT,
  39071,
  44071,
  20071,
]
const FALLBACK_INTERVAL_MS = 2000
// Bounded bookkeeping (round-3 review): a UDP/mDNS flood of forged deviceIds must not grow the
// peer map without limit. Beyond MAX_PEERS the least-recently-seen peer is evicted.
const MAX_PEERS = 64
// UDP fallback rate limit (round-3 review): at most one accepted upsert per source IP per this
// interval — legitimate broadcasters announce every FALLBACK_INTERVAL_MS, so 500ms discards
// flood traffic while never dropping a real peer announcement.
const UDP_UPSERT_MIN_INTERVAL_MS = 500
// D6 P2 (2026-09-21): cap on tracked source IPs before the LRU sweep runs (see startUdpFallback).
const UDP_IP_TRACK_MAX = 1024

let bonjourModule = null
try {
  // eslint-disable-next-line global-require
  bonjourModule = require('bonjour-service')
} catch {
  bonjourModule = null // offline install: UDP fallback below
}

/* ---------- Round-1 P0 (2026-09-21): dialable-address selection ----------
 * mDNS/UDP advertisements carry EVERY interface address of the advertising machine. Picking
 * addresses[0] live-dialed a temporary IPv6, a scope-less link-local, or a VMware NAT IP — all
 * timing out while the peer sat reachable one hop away. Selection rules:
 *   - drop link-local IPv6 (fe80::) WITHOUT a %scope id (unroutable) and IPv4 link-local 169.254.*;
 *   - Round-2 P1 (2026-09-21): the hardcoded 192.168.111.* "virtual range" was site-specific
 *     (this dev machine's VMware NAT) and wrongly hard-rejected real peers on other LANs using
 *     that range. Removed: scoring is now purely topological — an IPv4 sharing a /24 prefix with
 *     an active non-internal local interface scores highest; everything else stays ALLOWED at the
 *     lowest positive score (rememberPeer's dialability check + dial-failure budget still guard).
 *   - a scoped link-local IPv6 (fe80::x%if) has its %scope stripped for comparison: the scope id
 *     is the ADVERTISER's interface index, meaningless for dialing from here — score lowest. */
function hostScore(host) {
  let s = String(host || '')
  if (!s) return -1
  if (s.startsWith('169.254.')) return -1 // IPv4 link-local
  // Scoped link-local IPv6: strip the %scope suffix (advertiser's interface, not ours) — then it
  // is just fe80::, scored LOWEST-dialable (1) instead of ranked as a global address (round-2 P1).
  if (s.startsWith('fe80:')) {
    const pct = s.indexOf('%')
    if (pct === -1) return -1 // scope-less IPv6 link-local: unroutable
    s = s.slice(0, pct)
    return 1
  }
  const isV4 = /^\d+\.\d+\.\d+\.\d+$/.test(s)
  let sameSubnet = 0
  try {
    const m = s.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
    if (m) {
      for (const list of Object.values(os.networkInterfaces())) {
        for (const ni of list || []) {
          if (!ni || ni.internal || !ni.address || ni.family !== 'IPv4') continue
          const n = ni.address.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/)
          if (n && n[1] === m[1] && n[2] === m[2] && n[3] === m[3]) sameSubnet = 1
        }
      }
    }
  } catch { /* best effort */ }
  if (isV4) return sameSubnet ? 4 : 1 // round-2 P1: cross-subnet IPv4 allowed but lowest-ranked
  if (s.includes(':')) return 3 // global/scoped IPv6 (scope already stripped above)
  return 2 // hostnames
}
/** Pick the most dialable address from an mDNS advertisement. */
function pickAdvertisedAddress(addresses, fallbackHost) {
  const list = (Array.isArray(addresses) ? addresses : []).filter(Boolean)
  let best = null
  let bestScore = -1
  for (const a of list) {
    const sc = hostScore(a)
    if (sc > bestScore) { bestScore = sc; best = a }
  }
  if (bestScore >= 0) return best
  if (fallbackHost && hostScore(fallbackHost) >= 0) return fallbackHost
  return best || fallbackHost || null // everything filtered: caller decides (null = undialable)
}
/** True when a single host string is dialable (used to sanitize stored peer records). */
function isDialableHost(host) { return hostScore(host) >= 0 }

/** Round-5 P1: stricter gate for MANUAL peer entry. hostScore alone treats every non-IP string
 *  as a hostname (score 2), so "..." or "a..b" passed as "dialable" and got persisted, failing
 *  every dial forever. A manual entry must be syntactically real — dotted IPv4, IPv6 literal,
 *  or RFC-1123-style hostname labels — AND dialable per the discovery layer's own rules. */
function isPlausibleHost(host) {
  const s = String(host || '').trim()
  if (!s) return false
  const ipv4 = /^(\d{1,3})(\.\d{1,3}){3}$/.test(s)
  const ipv6 = s.includes(':') && /^[0-9a-fA-F:.]+$/.test(s)
  const hostname = /^(?=.{1,253}$)([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/.test(s)
  return (ipv4 || ipv6 || hostname) && isDialableHost(s)
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
  let candidateIdx = 0 // UDP fallback bind-candidate cursor (see FALLBACK_PORT_CANDIDATES)
  let udpBound = false
  let fallbackPort = 0 // the port this instance actually bound (0 = none yet)

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
      // Round-2 P1: NO loopback placeholder — a peer without any dialable address is SKIPPED
      // (announcements re-arrive every ~2s). Storing '127.0.0.1' made the node dial itself.
      host: pickAdvertisedAddress(info.addresses, info.host),
      port: info.port,
      protoVer: info.protoVer || PROTO_VER,
      lastSeen: Date.now(),
    }
    if (!peer.host || !isDialableHost(peer.host)) return null
    // Wave-B P2-3: route EVERY address change through the same scoring as mDNS. The UDP fallback
    // announces only rinfo.address (no addresses list), so a multi-NIC peer's UDP sightings used
    // to OVERWRITE the better-scored mDNS address with a worse one (and vice versa) every few
    // seconds — address flapping that burned rememberPeer's dial-failure/re-pair budget. A newly
    // scored candidate now only replaces the stored host when it scores STRICTLY higher — ties
    // keep the incumbent so alternating equal-class announcements cannot flap the address.
    if (existing && existing.host && isDialableHost(existing.host) && hostScore(peer.host) <= hostScore(existing.host)) {
      peer.host = existing.host
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
    candidateIdx = 0
    udpBound = false
    const payload = Buffer.from(JSON.stringify({ deviceId, name: name || deviceId, port, protoVer: PROTO_VER }))
    // A fresh socket per attempt: a socket whose bind failed is closed and cannot be re-bound.
    const tryBind = () => {
      if (udp) { try { udp.close() } catch { /* noop */ } }
      udp = dgram.createSocket({ type: 'udp4', reuseAddr: true })
      attachUdpHandlers()
      const port = FALLBACK_PORT_CANDIDATES[candidateIdx++]
      udp.bind(port, () => {
        udpBound = true
        fallbackPort = port // only on SUCCESS — an in-flight attempt must not read as bound
        udp.setBroadcast(true)
        udpTimer = setInterval(() => {
          udp.send(payload, port, '255.255.255.255', () => {})
        }, FALLBACK_INTERVAL_MS)
        udpTimer.unref?.()
      })
    }
    // Handlers are re-attached per bind attempt (tryBind builds a fresh socket each time).
    function attachUdpHandlers () {
    udp.on('message', (buf, rinfo) => {
      try {
        // Per-source rate limit (round-3 review): a flood of UDP broadcasts from one IP must not
        // burn CPU on JSON.parse + upsert. Known peers re-announce every ~2s, so a 500ms floor
        // per source IP never drops a legitimate announcement.
        const ip = rinfo && rinfo.address
        const now = Date.now()
        const last = lastUpsertByIp.get(ip) || 0
        if (now - last < UDP_UPSERT_MIN_INTERVAL_MS) return
        // Re-insert (delete+set) so Map iteration order reflects recency — the sweep below
        // evicts the LEAST recently active sources first.
        if (lastUpsertByIp.has(ip)) lastUpsertByIp.delete(ip)
        lastUpsertByIp.set(ip, now)
        // D6 P2 (2026-09-21): the old `size >= 1024 → clear()` was self-destructing under exactly
        // the flood it guarded against — a spoofed-source cycler filled the map, the bulk clear
        // reset EVERY legitimate peer's rate limit, and the next real announcement wave all
        // passed the gate at once (burst amplification). Replace with a bounded LRU sweep:
        // first drop entries older than the interval window (they are no longer rate-limiting
        // anything), then evict least-recently-active entries one by one until under the cap.
        // A bulk clear never happens; honest peers keep their limits and spoofed entries age out.
        if (lastUpsertByIp.size >= UDP_IP_TRACK_MAX) {
          for (const [k, t] of lastUpsertByIp) {
            if (now - t >= UDP_UPSERT_MIN_INTERVAL_MS) lastUpsertByIp.delete(k)
            if (lastUpsertByIp.size < UDP_IP_TRACK_MAX) break
          }
          while (lastUpsertByIp.size >= UDP_IP_TRACK_MAX) {
            const oldest = lastUpsertByIp.keys().next().value
            lastUpsertByIp.delete(oldest)
          }
        }
        // Round-2 P1: the UDP fallback payload carries NO addresses — the sender's real IP is
        // rinfo.address, so pass it as the candidate host. (It used to fall through to the
        // '127.0.0.1' placeholder and every UDP-discovered peer was dialed on loopback.)
        upsertPeer({ ...JSON.parse(buf.toString('utf8')), host: (rinfo && rinfo.address) || undefined })
      } catch { /* malformed broadcast */ }
    })
    udp.on('error', (err) => {
      // Bind-phase failure (WinNAT excluded range / port occupied): walk to the next candidate
      // instead of leaving a dead channel (2026-09-23 root fix, c2e17f57 precedent). After the
      // socket IS bound, keep the old behavior — a later EADDRINUSE from a second instance must
      // not kill the app; just leave a trace. Never fully silent either way.
      if (!udpBound && err && /^(EACCES|EADDRINUSE|EADDRNOTAVAIL)$/.test(err.code || '')) {
        if (candidateIdx < FALLBACK_PORT_CANDIDATES.length) tryBind()
        else try { require('electron-log').warn('[LanSync] UDP discovery fallback: no bindable candidate port from', FALLBACK_PORT_CANDIDATES.join('/')) } catch { /* noop */ }
        return
      }
      // Best-effort fallback, but never silent: an unlogged bind/send failure made the whole
      // discovery channel look healthy while discovering nothing. Keep the socket alive (a later
      // EADDRINUSE from a second instance must not kill the app); just leave a trace.
      try { require('electron-log').warn(`[LanSync] UDP discovery fallback error${err && err.code ? ' (' + err.code + ')' : ''}:`, err && err.message) } catch { /* electron-log unavailable in pure-node contexts */ }
    })
    }
    tryBind()
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
          host: svc.host,
          addresses: svc.addresses, // round-1 P0: full list — pickAdvertisedAddress selects
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
    fallbackPort = 0
    udpBound = false
  }

  return {
    startAdvertising,
    discover,
    stop,
    getPeers: () => Array.from(peers.values()),
    udpFallbackPort: () => fallbackPort, // test hook: which candidate actually bound
    on: em.on.bind(em),
    _upsertPeer: upsertPeer, // test hook (injected peer lists)
  }
}

module.exports = { createDiscovery, SERVICE_TYPE, PROTO_VER, FALLBACK_PORT, FALLBACK_PORT_CANDIDATES, pickAdvertisedAddress, isDialableHost, isPlausibleHost, hostScore }
