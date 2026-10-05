/**
 * PickDone Sync v2 — Opaque Protocol Relay (spec §3/§12-§21/§26-§28, Step 12).
 *
 * The relay is protocol-aware but business-semantics-blind: it understands
 * accounts, devices, serverSeq, durable ACKs, snapshots and the GC floor. It
 * never opens an envelope, never merges, never decides winners (spec §61).
 *
 * Transport: plain HTTP/JSON (spec §16/§17). All payloads travel as opaque
 * strings — today envelope JSON, tomorrow AEAD ciphertext — the relay schema
 * does not change when E2E lands (Step 7).
 *
 * Storage is pluggable: in-memory by default, JSON-file write-through for
 * self-host durability. A SQLite adapter arrives with deployment; the surface
 * below (appendEnvelope/getSince/lastSeq/…) is its contract.
 *
 * Run standalone (self-host, spec §54):
 *   node server/sync-relay.mjs --port 58480 --data ./relay-data
 *
 * SECURITY / SELF-HOST GUIDANCE: every data route (push/pull/ack/snapshot-put/
 * snapshot-latest/device-state) requires `Authorization: Bearer <deviceSecret>`,
 * minted per device at /v1/device/register and shown exactly once. The secret is
 * a bearer credential: anyone holding it can read and write the account's sync
 * stream. Plain HTTP therefore leaks it on the wire — when exposing the relay
 * beyond loopback/LAN, terminate TLS in front (reverse proxy or a TLS-enabled
 * host) and restrict direct 0.0.0.0 exposure to trusted networks.
 */

import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
// D22 (P2 2026-10-02): the shared durable atomic-write helper (tmp -> fsync -> rename).
// Plain Node, no electron — importable from this ESM module.
import { writeFileDurable } from '../src/main/durable-fs.js'

// ---------- storage backends ----------

export function memoryStore() {
  const state = { seq: 0, envelopes: new Map(), devices: new Map(), snapshots: new Map() }
  return {
    kind: 'memory',
    lastSeq: () => state.seq,
    appendEnvelope: (account, opId, envelopeJson) => {
      for (const e of state.envelopes.values()) {
        if (e.account === account && e.opId === opId) return { duplicate: true, serverSeq: e.serverSeq }
      }
      const serverSeq = ++state.seq
      state.envelopes.set(serverSeq, { account, opId, envelopeJson, serverSeq })
      return { duplicate: false, serverSeq }
    },
    getSince: (account, afterSeq, limit) =>
      [...state.envelopes.values()]
        .filter(e => e.account === account && e.serverSeq > afterSeq)
        .sort((a, b) => a.serverSeq - b.serverSeq)
        .slice(0, limit),
    upsertDevice: (account, deviceId, patch = {}) => {
      const key = `${account}~${deviceId}`
      const prev = state.devices.get(key) || { account, deviceId, status: 'active', lastAck: 0, lastSeen: 0 }
      state.devices.set(key, { ...prev, ...patch })
      return state.devices.get(key)
    },
    getDevice: (account, deviceId) => state.devices.get(`${account}~${deviceId}`) || null,
    listDevices: account => [...state.devices.values()].filter(d => d.account === account),
    putSnapshot: (account, snapshot) => {
      const prev = state.snapshots.get(account)
      const generation = Math.max(prev ? prev.generation : 0, snapshot.generation || 0)
      state.snapshots.set(account, { ...snapshot, generation })
    },
    latestSnapshot: account => state.snapshots.get(account) || null,
    /** GC floor = min durable ack among ACTIVE devices (spec §26). */
    gcFloor: account => {
      const active = [...state.devices.values()].filter(d => d.account === account && d.status === 'active')
      if (!active.length) return 0
      return Math.min(...active.map(d => d.lastAck || 0))
    },
    /** Snapshot-safe GC (spec §28): only below the floor AND below the latest
     *  snapshot's coversSeq, so a recovery path always exists. Snapshot-less
     *  deployments (GC floor fix, 2026-10-06): without a snapshot the floor used
     *  to be 0 forever → unbounded envelope growth. An ACK-ALONE floor with a
     *  sequence-horizon margin now bounds it: acked envelopes beyond the margin
     *  are removable even with no snapshot, while the margin keeps a recovery
     *  replay window for a device that lost its local state but not its ack. */
    gc: account => {
      const snap = state.snapshots.get(account)
      const active = [...state.devices.values()].filter(d => d.account === account && d.status === 'active')
      const ackFloor = active.length ? Math.min(...active.map(d => d.lastAck || 0)) : 0
      const GC_ACK_ALONE_MARGIN = 100000 // seq-margin kept when no snapshot exists yet
      let floor = Math.min(ackFloor, snap ? snap.coversSeq : 0)
      if (floor <= 0 && ackFloor > GC_ACK_ALONE_MARGIN) floor = ackFloor - GC_ACK_ALONE_MARGIN
      if (floor <= 0) return 0
      let removed = 0
      for (const [seq, e] of state.envelopes) {
        if (e.account === account && seq <= floor) { state.envelopes.delete(seq); removed++ }
      }
      return removed
    },
    flush: () => {},
    close: () => {},
    __dump: () => ({
      seq: state.seq,
      envelopes: [...state.envelopes.values()],
      devices: [...state.devices.values()],
      snapshots: [...state.snapshots.entries()],
    }),
    __load: dump => {
      // Corrupt-but-parseable dump hardening (2026-10-06): a torn-but-valid JSON file used to
      // load wholesale — an envelope entry missing serverSeq collapsed onto the undefined Map
      // key and the next persist() RE-PERSISTED the corruption. Validate every row's shape;
      // any malformed entry throws so fileStore quarantines the whole file (fresh boot),
      // exactly like an unparseable dump. seq loss is recoverable (clients re-push unacked).
      const envOk = e => e && Number.isInteger(e.serverSeq) && typeof e.opId === 'string' && typeof e.envelopeJson === 'string'
      const devOk = d => d && typeof d.account === 'string' && typeof d.deviceId === 'string'
      if (!dump || typeof dump !== 'object' || !Array.isArray(dump.envelopes) || !Array.isArray(dump.devices)) {
        throw new Error('malformed relay dump: envelopes/devices arrays required')
      }
      if (!dump.envelopes.every(envOk)) throw new Error('malformed relay dump: bad envelope entry (integer serverSeq, string opId/envelopeJson required)')
      if (!dump.devices.every(devOk)) throw new Error('malformed relay dump: bad device entry (string account/deviceId required)')
      state.seq = dump.seq || 0
      state.envelopes = new Map(dump.envelopes.map(e => [e.serverSeq, e]))
      state.devices = new Map(dump.devices.map(d => [`${d.account}~${d.deviceId}`, d]))
      state.snapshots = new Map(Array.isArray(dump.snapshots) ? dump.snapshots : [])
    },
  }
}

/** JSON-file write-through store: same contract, fsync-on-mutation via atomic rename.
 *
 *  D22 (P2 2026-10-02): the comment above used to be a LIE — persist() was a bare
 *  writeFileSync (no tmp, no fsync, no rename), so a crash mid-write could leave a TORN
 *  relay-state.json; and the startup load was an unguarded JSON.parse, so that torn file
 *  crashed the relay at boot. Worse, a partially-written file that still parsed could
 *  REGRESS `seq`, making the relay re-issue serverSeqs and clients replay whole histories.
 *  Writes now go through writeFileDurable (tmp + fsync + rename), and a corrupt load is
 *  quarantined to relay-state.json.bad with a FRESH state instead of crashing (seq loss is
 *  recoverable: clients re-push unacked envelopes; a replayed seq is not). */
export function fileStore(dir) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'relay-state.json')
  const mem = memoryStore()
  const persist = () => writeFileDurable(file, JSON.stringify(mem.__dump(), null, 0))
  if (existsSync(file)) {
    try {
      mem.__load(JSON.parse(readFileSync(file, 'utf8')))
    } catch (err) {
      const bad = file + '.bad'
      try { renameSync(file, bad) } catch { /* unreadable AND unmovable: leave it, start fresh */ }
      console.error(`[relay] relay-state unreadable (${err && err.message}) — quarantined to ${bad}, starting fresh`)
    }
  }
  return {
    // kind AFTER the spread: Object.entries(mem) carries kind:'memory' and would
    // otherwise overwrite the file marker (drill log said "storage: memory @ .")
    ...Object.fromEntries(Object.entries(mem).map(([k, v]) =>
      [k, typeof v === 'function' ? (...args) => {
        const r = v(...args)
        if (!['lastSeq', 'getSince', 'getDevice', 'listDevices', 'latestSnapshot', 'gcFloor', 'flush', 'close', '__dump', '__load'].includes(k)) persist()
        return r
      } : v])),
    kind: 'file',
    flush: persist,
    close: () => persist(),
  }
}

// ---------- relay logic (transport-agnostic, directly unit-testable) ----------

export function createRelay(store) {
  return {
    store,
    /**
     * Device registration. First-time registration is open (the register response is the only
     * channel that mints a bearer secret). Re-registration of a device whose row ALREADY holds
     * a populated deviceSecret requires PROOF: the caller must present the current secret
     * (bearer header or body `deviceSecret`) and only then is it rotated. Without proof the
     * request is rejected with 409 — otherwise anyone who knew account+deviceId could overwrite
     * the victim's secret, locking the victim out (401s) and gaining full pull/push access.
     */
    registerDevice(account, deviceId, { bearerSecret, bodySecret } = {}) {
      const prev = store.getDevice(account, deviceId)
      const existing = prev && typeof prev.deviceSecret === 'string' ? prev.deviceSecret : ''
      if (existing) {
        const ok = [bearerSecret, bodySecret].some(s =>
          typeof s === 'string' && s.length > 0 && (() => {
            const a = Buffer.from(s); const b = Buffer.from(existing)
            return a.length === b.length && timingSafeEqual(a, b)
          })())
        if (!ok) throw err(409, 'device already registered: present the current deviceSecret (bearer or body) to rotate it')
      }
      // per-device bearer secret: minted fresh on every (proven) register, shown once
      const deviceSecret = randomBytes(32).toString('hex')
      return store.upsertDevice(account, deviceId, { lastSeen: Date.now(), deviceSecret })
    },
    /**
     * Bearer auth for data routes: timing-safe compare of the supplied secret
     * against the stored device row. Routes that carry a deviceId (push/pull/
     * ack/device-state) check that device's row; routes that carry only an
     * account (snapshot-put/snapshot-latest) accept any of the account's
     * devices' secrets — the secret still proves possession of a registered
     * device for that account.
     */
    authorize(account, deviceId, authz) {
      const m = /^Bearer\s+(\S+)$/i.exec(authz || '')
      const supplied = m ? Buffer.from(m[1]) : null
      const candidates = (account && deviceId)
        ? [store.getDevice(account, deviceId)].filter(Boolean)
        : (account ? store.listDevices(account) : [])
      const ok = supplied && candidates.some(row => {
        const expected = typeof row.deviceSecret === 'string' ? row.deviceSecret : ''
        if (!expected) return false
        const b = Buffer.from(expected)
        return supplied.length === b.length && timingSafeEqual(supplied, b)
      })
      if (!ok) throw err(401, 'unauthorized: missing or invalid device bearer secret')
    },
    setDeviceState(account, deviceId, patch) { return store.upsertDevice(account, deviceId, patch) },
    push(account, deviceId, items) {
      const acked = {}
      for (const item of items) {
        const r = store.appendEnvelope(account, item.opId, item.envelope)
        acked[item.opId] = r.serverSeq
      }
      store.upsertDevice(account, deviceId, { lastSeen: Date.now() })
      return { acked, serverSeq: store.lastSeq() }
    },
    pull(account, afterSeq, maxBytes) {
      // server-side clamp: a client sending maxBytes:null previously bypassed the cap
      if (!Number.isFinite(maxBytes) || maxBytes <= 0) maxBytes = 4 * 1024 * 1024
      maxBytes = Math.min(maxBytes, 32 * 1024 * 1024)
      // Paged materialization (2026-10-06): getSince(account, after, 100000) used to build the
      // WHOLE remaining history in memory before the byte clamp discarded most of it. Page in
      // batches of 500 and stop at the first batch boundary once the byte budget is hit —
      // memory is O(page + response), not O(history).
      const items = []
      let bytes = 0
      let cursor = afterSeq
      for (;;) {
        const page = store.getSince(account, cursor, 500)
        if (!page.length) break
        for (const e of page) {
          const size = Buffer.byteLength(e.envelopeJson)
          if (bytes + size > maxBytes) return { fromSeq: afterSeq + 1, toSeq: items.length ? items[items.length - 1].serverSeq : afterSeq, items }
          items.push({ serverSeq: e.serverSeq, envelope: e.envelopeJson })
          bytes += size
        }
        if (page.length < 500) break
        cursor = page[page.length - 1].serverSeq
      }
      return { fromSeq: afterSeq + 1, toSeq: items.length ? items[items.length - 1].serverSeq : afterSeq, items }
    },
    ack(account, deviceId, ackSeq) {
      const dev = store.getDevice(account, deviceId)
      const lastAck = Math.max(dev ? dev.lastAck : 0, ackSeq)
      store.upsertDevice(account, deviceId, { lastAck, lastSeen: Date.now() })
      const removed = store.gc(account)
      return { acked: lastAck, gcRemoved: removed }
    },
    putSnapshot(account, snapshot) {
      store.putSnapshot(account, snapshot)
      const removed = store.gc(account)
      return { generation: snapshot.generation, gcRemoved: removed }
    },
    latestSnapshot: account => store.latestSnapshot(account),
  }
}

// ---------- HTTP surface (spec §16/§17/§57) ----------

const PROTOCOL_VERSION = 1

export function startRelayServer(relay, { port = 0, host = '127.0.0.1' } = {}) {
  const MAX_BODY_BYTES = 8 * 1024 * 1024
  const server = createServer((req, res) => {
    const chunks = []
    let total = 0
    const respondTooLarge = () => {
      // Header guard (2026-10-06): req.destroy() is async — a buffered chunk can re-enter this
      // handler after the 413 was already written, and a second writeHead threw
      // ERR_HTTP_HEADERS_SENT. `responded` + res.headersSent make the branch idempotent.
      if (responded || res.headersSent) return
      responded = true
      res.writeHead(413, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'request body too large' }))
      // No req.destroy() here: resetting the socket races the client's read of the 413
      // (ECONNRESET on the caller side). The remaining body is drained and ignored — the
      // responded/headersSent guards make both later handlers no-ops.
    }
    let responded = false
    req.on('data', c => {
      total += c.length
      if (total > MAX_BODY_BYTES) { respondTooLarge(); return }
      if (responded || res.headersSent) return
      chunks.push(c)
    })
    req.on('end', () => {
      if (responded || res.headersSent) return
      responded = true
      let body = {}
      try {
        if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const out = route(relay, req.method, req.url, body, req.headers.authorization)
        res.writeHead(200, { 'content-type': 'application/json', 'x-protocol-version': String(PROTOCOL_VERSION) })
        res.end(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, ...out }))
      } catch (err) {
        // protocol rejections keep their message; internal failures stay opaque
        // (driver/storage exceptions must not reach the client)
        const status = err.status || 500
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: err.status ? err.message : 'internal error' }))
        if (!err.status) console.error('[relay] internal error:', err)
      }
    })
  })
  // Coded listen failure (2026-10-06): EADDRINUSE used to reject with the raw Node error (or,
  // before the promise existed at all, hang). Surface a readable coded error; other listen
  // errors reject with their original cause.
  return new Promise((resolve, reject) => {
    server.once('error', e => {
      if (e && e.code === 'EADDRINUSE') reject(err(503, `listen failed: port ${port} already in use (EADDRINUSE) on ${host}`))
      else reject(e)
    })
    server.listen(port, host, () => resolve(server))
  })
}

/** Data routes all require the per-device bearer secret (register is the only
 *  way to obtain one; everything else is unauthenticated by design). */
const PROTECTED_ROUTES = new Set([
  '/v1/sync/push',
  '/v1/sync/pull',
  '/v1/sync/ack',
  '/v1/device/state',
  '/v1/snapshot/put',
  '/v1/snapshot/latest',
])

function route(relay, method, url, body, authz) {
  const path = url.split('?')[0]
  const post = () => { if (method !== 'POST') throw err(405, 'POST only'); return body }
  if (PROTECTED_ROUTES.has(path)) {
    const { account, device } = body || {}
    relay.authorize(account, device, authz)
  }
  switch (path) {
    case '/v1/sync/push': {
      const { account, device, items } = post()
      need(account && device && Array.isArray(items), 'account, device, items required')
      // envelope must be an opaque STRING: an object here passes push but poisons every
      // later pull for the account (pull does string ops on stored envelopes) — live
      // inspection probe found this (P2)
      need(items.every(it => it && typeof it.opId === 'string' && typeof it.envelope === 'string'), 'each item needs string opId + string envelope')
      return relay.push(account, device, items)
    }
    case '/v1/sync/pull': {
      const { account, afterSeq = 0, maxBytes } = post()
      need(account, 'account required')
      return relay.pull(account, afterSeq, maxBytes)
    }
    case '/v1/sync/ack': {
      const { account, device, ackSeq } = post()
      need(account && device && Number.isInteger(ackSeq), 'account, device, ackSeq required')
      return relay.ack(account, device, ackSeq)
    }
    case '/v1/device/register': {
      const { account, device, deviceSecret } = post()
      need(account && device, 'account, device required')
      return { device: relay.registerDevice(account, device, { bodySecret: deviceSecret, bearerSecret: parseBearer(authz) }) }
    }
    case '/v1/device/state': {
      const { account, device, status } = post()
      need(account && device, 'account, device required')
      return { device: relay.setDeviceState(account, device, status ? { status } : {}) }
    }
    case '/v1/snapshot/put': {
      const { account, snapshot } = post()
      need(account && snapshot && Number.isInteger(snapshot.coversSeq) && Number.isInteger(snapshot.generation), 'account + snapshot{generation, coversSeq} required')
      return relay.putSnapshot(account, snapshot)
    }
    case '/v1/snapshot/latest': {
      const { account } = post()
      need(account, 'account required')
      return { snapshot: relay.latestSnapshot(account) }
    }
    default:
      throw err(404, `no route ${path}`)
  }
}

const err = (status, message) => Object.assign(new Error(message), { status })
const need = (ok, message) => { if (!ok) throw err(400, message) }
const parseBearer = authz => { const m = /^Bearer\s+(\S+)$/i.exec(authz || ''); return m ? m[1] : null }

// ---------- CLI entry (self-host, spec §54) ----------

export async function main(argv = process.argv.slice(2)) {
  const arg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`)
    return i >= 0 ? argv[i + 1] : fallback
  }
  const port = Number(arg('port', 58480))
  // self-host must accept LAN/WAN peers: loopback default would make the relay
  // unreachable from every other device (first real deployment caught this)
  const host = arg('host', '0.0.0.0')
  const data = arg('data', null)
  let store
  if (arg('storage', 'auto') === 'sqlite') {
    const { sqliteStore } = await import('./sync-relay-sqlite.mjs')
    store = sqliteStore(join(data || '.', 'relay.db'))
  } else store = data ? fileStore(data) : memoryStore()
  const relay = createRelay(store)
  return startRelayServer(relay, { port, host }).then(server => {
    console.log(`[pickdone-sync-relay] listening on :${server.address().port} (storage: ${store.kind}${data ? ` @ ${dirname(data)}` : ''})`)
    return server
  })
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) {
  main()
}
