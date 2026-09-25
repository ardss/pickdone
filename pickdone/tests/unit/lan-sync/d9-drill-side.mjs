/**
 * One "machine" of the D9 loopback two-machine drill: a standalone process holding a REAL
 * database and a REAL LAN-sync TCP node wired through the PRODUCTION merge pipeline
 * (sync-apply applyRowSafe + flushPendingWrites). Speaks newline-delimited JSON on
 * stdin/stdout so the orchestrator test can drive and observe it — the same shape as the
 * 2026-09-18 physical two-device drill, minus the second physical device (the transport
 * port is FIXED at 58471, so two app instances cannot bind on one host).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const db = require('../../../src/main/db.js')
const syncApply = require('../../../src/main/sync-apply.js')
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')
const { createEngine } = require('../../../shared/sync-core/engine.mjs')

const emit = obj => process.stdout.write(JSON.stringify(obj) + '\n')

let state = null
let node = null

function setup ({ dir, deviceId }) {
  fs.mkdirSync(dir, { recursive: true })
  db.init(dir)
  state = {
    db: { call: (op, params) => db.call(op, params) },
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    applied: null,
    applyCache: null,
    engine: null,
    node: null,
    timers: [],
    peerWatermarks: new Map(),
    pendingToSeq: 0,
    getWindowSenders: () => [],
    deviceId,
  }
  const localStore = {
    getRowsSince (seq) {
      const ptrs = db.call('syncOplogSince', { sinceSeq: seq, limit: 10000 }) || []
      const cache = syncApply.createHydrationCache(state)
      return ptrs.map(p => syncApply.hydrateRow(state, p, cache)).filter(Boolean)
    },
    getCursor () { const n = Number(db.call('getMeta', 'sync.pushCursor')); return Number.isFinite(n) && n > 0 ? n : 0 },
    setCursor (seq) { db.call('setMeta', ['sync.pushCursor', String(seq)]) },
    applyRow: row => syncApply.applyRowSafe(state, row),
    allRows () {
      return (db.call('getAll', { deleted: null }) || []).map(t => ({
        entity: 'todo', id: t.taskId, updatedAt: t.updateTime || 0, deleted: !!t.delete, deletedAt: t.deletedAt || 0, data: t,
      }))
    },
  }
  state.engine = createEngine({ localStore, deviceId })
  const stampPeer = body => (body && typeof body === 'object' && body.deviceId && Array.isArray(body.rows))
    ? { ...body, rows: body.rows.map(r => ({ ...r, deviceId: body.deviceId })) }
    : body
  node = createLanSyncNode({
    deviceId,
    name: deviceId,
    pairingSecret: 'd9-drill-secret',
    port: 0,
    host: '127.0.0.1',
    discoverFn: { startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] },
    peerProgress: state.peerWatermarks,
    securityLog: { push () {}, entries: () => [] },
    buildSegments: since => {
      const r = state.engine.buildSegments(since)
      state.pendingToSeq = r.toSeq
      return r.segments
    },
    ingestSegment: body => {
      state.applyCache = syncApply.createHydrationCache(state)
      try {
        const r = state.engine.ingestSegment(stampPeer(body))
        const flush = syncApply.flushPendingWrites(state)
        if (flush && flush.ok === false) r.flushFailed = true
        return r
      } finally { state.applyCache = null }
    },
    ingestSnapshot: body => {
      state.applyCache = syncApply.createHydrationCache(state)
      try {
        for (const r of stampPeer(body).rows || []) syncApply.applyRowSafe(state, r)
        syncApply.flushPendingWrites(state)
        return { rows: (body && body.rows || []).length }
      } finally { state.applyCache = null }
    },
  })
  node.start()
}

const handlers = {
  start ({ dir, deviceId }) {
    if (!path.isAbsolute(dir)) dir = path.join(os.tmpdir(), dir)
    setup({ dir, deviceId })
    return { port: null }
  },
  async port () {
    const p = await node.whenListening()
    return { port: p }
  },
  addPeer ({ peer }) { node.addPeer(peer); return {} },
  write ({ ops }) { for (const { op, params } of ops) db.call(op, params); return {} },
  async read ({ op, params }) {
    return { result: JSON.parse(JSON.stringify(db.call(op, params) ?? null)) }
  },
  async round () {
    try { await node.startSyncRound(); return {} } catch (e) { return { roundError: String(e && e.message) } }
  },
  stop () { try { node.stop() } catch {} return {} },
}

const rl = readline.createInterface({ input: process.stdin })
rl.on('line', async line => {
  if (!line.trim()) return
  let msg
  try { msg = JSON.parse(line) } catch { return }
  const { id, do: action, ...args } = msg
  try {
    const h = handlers[action]
    if (!h) return emit({ id, error: 'unknown action ' + action })
    emit({ id, ...await h(args) })
  } catch (e) {
    emit({ id, error: String(e && e.message) })
  }
})
process.on('disconnect', () => process.exit(0))
