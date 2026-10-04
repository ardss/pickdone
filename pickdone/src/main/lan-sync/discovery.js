'use strict'

/**
 * LAN sync discovery: mDNS advertise + browse for pickdone-sync._tcp peers.
 *
 * Primary path uses the pure-JS `bonjour-service` package; if unavailable (offline install)
 * it falls back to a minimal UDP broadcast discovery (same payload shape). Peers are deduped
 * by deviceId; re-seeing a known id refreshes host/port/lastSeen instead of re-emitting found.
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
// (bind EACCES) — candidates therefore span four discontiguous spans and the first BINDABLE port
// wins. LAN_SYNC_UDP_FALLBACK_PORT pins a specific port as a manual escape hatch.
const FALLBACK_PORT = 58471 // canonical port; first candidate (kept exported for compat)
const FALLBACK_PORT_CANDIDATES = [
  ...(Number(process.env.LAN_SYNC_UDP_FALLBACK_PORT) > 0 ? [Number(process.env.LAN_SYNC_UDP_FALLBACK_PORT)] : []),
  FALLBACK_PORT,
  39071,
  44071,
  20071,
]
// Injectable for tests (LAN_SYNC_UDP_FALLBACK_INTERVAL_MS); production stays 2000ms.
const FALLBACK_INTERVAL_MS = Number(process.env.LAN_SYNC_UDP_FALLBACK_INTERVAL_MS) > 0
  ? Number(process.env.LAN_SYNC_UDP_FALLBACK_INTERVAL_MS)
  : 2000
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
 * Advertisements carry EVERY interface address; picking addresses[0] live-dialed temp IPv6 /
 * link-local / NAT IPs. Rules: drop link-local IPv4 169.254.* and scope-less fe80:: (unroutable);
 * scoring is purely topological — an IPv4 sharing a /24 prefix with an active local interface
 * scores highest, everything else stays ALLOWED at the lowest positive score (rememberPeer's
 * dialability check + dial-failure budget still guard). A scoped fe80::x%if has its %scope
 * stripped (the scope id is the ADVERTISER's interface index) and scores lowest. */
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

/** Round-5 P1: stricter gate for MANUAL peer entry — hostScore alone treats every non-IP string
 *  as a hostname, so junk like "..." got persisted and failed every dial forever. Must be
 *  syntactically real (IPv4 / IPv6 literal / RFC-1123 hostname) AND dialable. */
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
    // Wave-B P2-3: route EVERY address change through the same scoring as mDNS — the UDP
    // fallback announces only rinfo.address, so multi-NIC peers flapped their address (and
    // burned the dial-failure budget) every few seconds. A new candidate replaces the stored
    // host only when it scores STRICTLY higher; ties keep the incumbent.
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
    // D20-C4: set by the post-bind 'error' handler; one failed sweep per next sweep.
    let sweepError = false
    const payload = Buffer.from(JSON.stringify({ deviceId, name: name || deviceId, port, protoVer: PROTO_VER }))
    // A fresh socket per attempt: a socket whose bind failed is closed and cannot be re-bound.
    const tryBind = () => {
      if (udp) { try { udp.close() } catch { /* noop */ } }
      // NO reuseAddr: on Windows SO_REUSEADDR lets a later bind SILENTLY succeed over an
      // existing socket, defeating the candidate-walk contract and D15 C5's close-on-total-
      // failure path. A taken port must be a REAL EADDRINUSE (UDP has no TIME_WAIT).
      udp = dgram.createSocket({ type: 'udp4' })
      attachUdpHandlers()
      // 2026-09-28 (was `port`, shadowing the destructured TCP arg): the fallback used to
      // broadcast ONLY to its own bound candidate port — a silent discovery partition. Fan
      // out to EVERY candidate port + the advertised TCP port.
      const bindPort = FALLBACK_PORT_CANDIDATES[candidateIdx++]
      udp.bind(bindPort, () => {
        udpBound = true
        fallbackPort = bindPort // only on SUCCESS — an in-flight attempt must not read as bound
        udp.setBroadcast(true)
        const targets = [...new Set(FALLBACK_PORT_CANDIDATES
          .concat(Number.isInteger(port) && port > 0 ? [port] : []))]
        // D14 C9 dead-channel guard: 3 consecutive failed sweeps declare the channel dead
        // (clear interval, close socket — D15 C5). D20-C4: ASYNC send errors (callback err,
        // dropped by the old `() => {}`) AND post-bind socket 'error' events (sweepError,
        // set in attachUdpHandlers) count as failed sweeps too.
        let failedSweeps = 0
        const killChannel = () => {
          if (udpTimer) { clearInterval(udpTimer); udpTimer = null }
          udpBound = false
          // D15 C5: a declared-dead channel must not leak the socket — close it too. Restarting
          // advertising (startAdvertising) recreates socket + interval from scratch.
          try { udp.close() } catch { /* noop */ }
          udp = null
          try { require('electron-log').warn('[LanSync] UDP fallback advertise channel dead (3 consecutive failed sweeps) — socket closed, advertise interval stopped; restart advertising to recreate it') } catch { /* noop */ }
        }
        udpTimer = setInterval(() => {
          let pending = 0
          let failed = false
          let settled = false
          const settle = () => {
            if (settled || pending > 0) return
            settled = true
            failedSweeps = (failed || sweepError) ? failedSweeps + 1 : 0
            sweepError = false
            if (failedSweeps >= 3) killChannel()
          }
          const sendAd = (target) => {
            pending++
            try {
              udp.send(payload, target, '255.255.255.255', (err) => {
                if (err) failed = true // D20-C4: async send failure counts as a failed sweep
                pending--
                settle()
              })
            } catch (e) {
              failed = true // sync throw (socket already dead) — the original D14 C9 path
              try { require('electron-log').warn('[LanSync] UDP fallback send failed:', e && e.message) } catch { /* noop */ }
              require('../log-isolation') // test isolation: redirect electron-log file transport into TODO_DB_DIR/TODO_USER_DATA_DIR
              pending--
              settle()
            }
          }
          for (const target of targets) sendAd(target)
          settle()
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
        // D6 P2 (2026-09-21): the old `size >= 1024 → clear()` reset EVERY legitimate rate
        // limit under a spoofed-source flood (burst amplification). Bounded LRU sweep instead:
        // drop entries older than the interval window, then evict least-recently-active one by
        // one until under the cap — honest peers keep their limits, spoofed entries age out.
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
        // Round-2 P1: the UDP fallback carries NO addresses — the sender's real IP is
        // rinfo.address; pass it as the candidate host (never the loopback placeholder).
        upsertPeer({ ...JSON.parse(buf.toString('utf8')), host: (rinfo && rinfo.address) || undefined })
      } catch { /* malformed broadcast */ }
    })
    udp.on('close', () => {
      // D14 C9: an UNEXPECTED post-bind close (not our own stop(), which clears the timer first)
      // must not leave the advertise interval firing into a closed socket — stop it and surface.
      if (udpBound && udpTimer) {
        clearInterval(udpTimer)
        udpTimer = null
        udpBound = false
        try { require('electron-log').warn('[LanSync] UDP fallback socket closed after bind — advertise interval stopped') } catch { /* noop */ }
      }
    })
    udp.on('error', (err) => {
      // Bind-phase failure (WinNAT excluded range / port occupied): walk to the next candidate
      // instead of leaving a dead channel (2026-09-23 root fix, c2e17f57 precedent). After the
      // socket IS bound, keep the old behavior — a later EADDRINUSE from a second instance must
      // not kill the app; just leave a trace. Never fully silent either way.
      if (!udpBound && err && /^(EACCES|EADDRINUSE|EADDRNOTAVAIL)$/.test(err.code || '')) {
        if (candidateIdx < FALLBACK_PORT_CANDIDATES.length) tryBind()
        else {
          // D15 C5 (2026-10-03): total bind failure (every candidate exhausted) must not leak
          // the dead socket — this udp handle can never be bound (a socket whose bind failed
          // is closed and cannot be re-bound). Close it; a later startAdvertising recreates
          // it from scratch.
          try { udp.close() } catch { /* noop */ }
          udp = null
          try { require('electron-log').warn('[LanSync] UDP discovery fallback: no bindable candidate port from', FALLBACK_PORT_CANDIDATES.join('/'), '— socket released') } catch { /* noop */ }
        }
        return
      }
      if (udpBound) sweepError = true // D20-C4: post-bind errors feed the sweep budget
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
      // D18 (2026-10-02): repeated discover() used to overwrite the module-level `browser` handle
      // without stopping the previous one — each call leaked a live mDNS browser (duplicated
      // 'found' callbacks, unbounded handle growth), the same hygiene startAdvertising applies
      // with its destroy-then-recreate of the advertised service. Stop the stale browser BEFORE
      // minting the new one.
      if (browser) { try { browser.stop() } catch { /* noop */ } browser = null }
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
    // D14 C9 test hooks: raw socket ref + whether the post-bind advertise interval is alive.
    _udpSocket: () => udp,
    _udpAdvertiseActive: () => !!(udpBound && udpTimer),
    on: em.on.bind(em),
    _upsertPeer: upsertPeer, // test hook (injected peer lists)
  }
}

module.exports = { createDiscovery, SERVICE_TYPE, PROTO_VER, FALLBACK_PORT, FALLBACK_PORT_CANDIDATES, pickAdvertisedAddress, isDialableHost, isPlausibleHost, hostScore }
