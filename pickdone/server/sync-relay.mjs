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
 */

import { createServer } from 'node:http'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
     *  snapshot's coversSeq, so a recovery path always exists. */
    gc: account => {
      const snap = state.snapshots.get(account)
      const active = [...state.devices.values()].filter(d => d.account === account && d.status === 'active')
      const ackFloor = active.length ? Math.min(...active.map(d => d.lastAck || 0)) : 0
      const floor = Math.min(ackFloor, snap ? snap.coversSeq : 0)
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
      state.seq = dump.seq || 0
      state.envelopes = new Map(dump.envelopes.map(e => [e.serverSeq, e]))
      state.devices = new Map(dump.devices.map(d => [`${d.account}~${d.deviceId}`, d]))
      state.snapshots = new Map(dump.snapshots)
    },
  }
}

/** JSON-file write-through store: same contract, fsync-on-mutation via atomic rename. */
export function fileStore(dir) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, 'relay-state.json')
  const mem = memoryStore()
  const persist = () => writeFileSync(file, JSON.stringify(mem.__dump(), null, 0))
  if (existsSync(file)) mem.__load(JSON.parse(readFileSync(file, 'utf8')))
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
    registerDevice(account, deviceId) { return store.upsertDevice(account, deviceId, { lastSeen: Date.now() }) },
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
      const items = []
      let bytes = 0
      for (const e of store.getSince(account, afterSeq, 100000)) {
        const size = Buffer.byteLength(e.envelopeJson)
        if (bytes + size > maxBytes) break
        items.push({ serverSeq: e.serverSeq, envelope: e.envelopeJson })
        bytes += size
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
    req.on('data', c => {
      total += c.length
      if (total > MAX_BODY_BYTES) {
        res.writeHead(413, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'request body too large' }))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      let body = {}
      try {
        if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        const out = route(relay, req.method, req.url, body)
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
  return new Promise(resolve => server.listen(port, host, () => resolve(server)))
}

function route(relay, method, url, body) {
  const path = url.split('?')[0]
  const post = () => { if (method !== 'POST') throw err(405, 'POST only'); return body }
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
      const { account, device } = post()
      need(account && device, 'account, device required')
      return { device: relay.registerDevice(account, device) }
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
