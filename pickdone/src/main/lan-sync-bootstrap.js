/* P3a LAN sync bootstrap (2026-09-16, docs/sync/同步整体方案-2026-09-15.md §9).
 * Extracted from index.js for the size ratchet: index.js keeps one thin require+call after db init.
 *
 * Responsibilities:
 *   - Device identity: deviceId (UUID, persisted in settings_rows 'sync.deviceId' on first run),
 *     deviceName (default os.hostname(), user-renamable), pairingSecret (32-byte hex, generated on
 *     FIRST ENABLE only — never auto-enable; the app must boot with sync off by default).
 *   - Engine adapter: implements the shared/sync-core engine.mjs localStore contract against the
 *     db.call() surface (syncOplogSince cursor reads + per-entity hydration; application through
 *     the regular db write ops so every applied row is itself change-captured). Conflict rules are
 *     consumed from shared/sync-core/merge.mjs and nothing else (transport-adapter boundary, §8).
 *   - Node lifecycle: engine + lan-sync node are constructed LAZILY, only while sync.enabled is
 *     true. Auto round on start (10s delay) and every 5 minutes while enabled.
 *   - IPC ops: syncGetSettings / syncSetEnabled / syncGetStatus / syncGetPairingCode / syncSetName
 *     registered into db.js OPS via db-sync-ops.js (keeps the three-way op whitelist gate true).
 *
 * Known P3a scope cuts (documented, not silent):
 *   - Category/plan/filter tombstones cannot be hydrated (no read op returns them), so deletions of
 *     those entities propagate only as seq-advancing pointers that peers skip; full snapshot
 *     reconciliation covers them once snapshot exchange is wired into the round protocol.
 *   - conflictCopy from merge.mjs is logged, not materialized (renderer has no conflict-copy UI yet).
 *   - applySnapshot/replaceAll is implemented as merge-apply (non-destructive) because the round
 *     protocol never sends snapshot-request in P3a; a true destructive reset is deferred.
 */
const { randomUUID, timingSafeEqual } = require('node:crypto')
const os = require('node:os')
const log = require('electron-log')
const { createEngine } = require('../../shared/sync-core/engine.mjs')
const mergeCore = require('../../shared/sync-core/merge.mjs')
const { generatePairingSecret, derivePairingCode } = require('../../shared/sync-core/pairing.mjs')
const { createLanSyncNode } = require('./lan-sync/index')
const syncOps = require('./db-sync-ops')

// settings_rows keys (never synced: hydration skips the 'sync.' namespace, otherwise peers would
// adopt each other's identity)
const K_DEVICE_ID = 'sync.deviceId'
const K_DEVICE_NAME = 'sync.deviceName'
const K_PAIRING_SECRET = 'sync.pairingSecret'
const K_ENABLED = 'sync.enabled'
const K_MANUAL_PEERS = 'sync.manualPeers' // [{host,port}] — survives restarts (node peers are memory-only)
const CURSOR_META_KEY = 'sync.pushCursor' // persisted in meta (not settings_rows): per-device bookkeeping, no sync obligation
const K_PEER_WATERMARKS = 'sync.peerWatermarks' // {deviceId: highestSeqThatPeerAcked} — per-peer push progress (survives restarts)
const START_DELAY_MS = 10 * 1000
const ROUND_INTERVAL_MS = 5 * 60 * 1000
// Pairing code validity: issued on first request and stable for 10 minutes (the LAN transport
// authenticates with the persisted pairing secret — the displayed code is compare-only material
// in P3a, so its cadence is UX, not security; no mid-session surprise refresh)
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000

let state = null // { db, getWindowSenders, node, engine, timers, pendingWrites }

/* ---------- settings_rows helpers (deleted rows treated as absent) ---------- */
function settingGet (key) {
  const row = state.db.call('settingsRowsAll', {}).find(r => r.key === key && !r.deleted)
  return row ? row.value : null
}
function settingPut (key, value) { return state.db.call('settingsRowPut', { key, value }) }

/* ---------- identity ---------- */
function ensureIdentity () {
  let deviceId = settingGet(K_DEVICE_ID)
  if (!deviceId || typeof deviceId !== 'string') {
    deviceId = randomUUID()
    settingPut(K_DEVICE_ID, deviceId)
    log.info('[LanSync] device identity created:', deviceId)
  }
  let deviceName = settingGet(K_DEVICE_NAME)
  if (!deviceName || typeof deviceName !== 'string' || !deviceName.trim()) {
    deviceName = os.hostname() || 'pickdone-device'
    settingPut(K_DEVICE_NAME, deviceName)
  }
  return { deviceId, deviceName }
}

/* ---------- localStore adapter (shared/sync-core engine.mjs contract) ---------- */
const SYNCABLE_ENTITIES = new Set(['todo', 'setting', 'tomato', 'category', 'plan', 'filter'])

/**
 * Per-hydration-pass entity caches. The first buildSegments after a fresh cursor re-hydrates the
 * whole oplog (thousands of pointers); without these caches every pointer re-scanned a full entity
 * list (O(n²)) and the peer's round response starved past the transport's round timer, so the
 * cursor never advanced and every later round rebuilt the same backlog (2026-09-17 live drill).
 * A cache instance is valid for ONE getRowsSince call: rows applied between calls must re-read.
 */
function createHydrationCache () {
  const caches = {}
  const load = (key, op, idOf) => {
    if (!caches[key]) caches[key] = new Map((state.db.call(op, {}) || []).map(r => [idOf(r), r]))
    return caches[key]
  }
  return {
    todo: id => load('todo', 'getAll', r => String(r.taskId)).get(String(id)),
    setting: key => load('setting', 'settingsRowsAll', r => r.key).get(key),
    tomato: id => load('tomato', 'tomatoAll', r => String(r.tomatoId)).get(String(id)),
    category: id => load('category', 'getAllCategories', r => String(r.categoryId)).get(String(id)),
    plan: id => load('plan', 'planAll', r => String(r.id)).get(String(id)),
    filter: id => load('filter', 'filterList', r => String(r.id)).get(String(id)),
  }
}

/** Hydrate one oplog pointer row into a merge-ready payload row (null = not syncable). */
function hydrateRow (ptr, cache) {
  if (!SYNCABLE_ENTITIES.has(ptr.entity)) return null
  const c = cache || createHydrationCache()
  const base = { seq: ptr.seq, entity: ptr.entity, id: ptr.entityId, ts: ptr.ts }
  try {
    if (ptr.entity === 'todo') {
      const t = c.todo(ptr.entityId)
      if (!t) return { ...base, deleted: true, deletedAt: ptr.ts, data: null }
      return { ...base, updatedAt: t.updateTime || ptr.ts, deleted: !!t.delete, deletedAt: t.deletedAt || 0, data: t }
    }
    if (ptr.entity === 'setting') {
      if (String(ptr.entityId).startsWith('sync.')) return null // identity namespace stays local
      const r = c.setting(ptr.entityId)
      if (!r) return null
      return { ...base, updatedAt: r.updatedAt, deleted: !!r.deleted, deletedAt: r.deletedAt || 0, data: { key: r.key, value: r.value } }
    }
    if (ptr.entity === 'tomato') {
      const r = c.tomato(ptr.entityId)
      if (!r) return { ...base, deleted: true, deletedAt: ptr.ts, data: null }
      return { ...base, updatedAt: r.updatedAt || ptr.ts, deleted: false, deletedAt: 0, data: r }
    }
    if (ptr.entity === 'category') {
      const cat = c.category(ptr.entityId)
      if (!cat) return { ...base, deleted: true, deletedAt: ptr.ts, data: null } // tombstone hydration gap (see header)
      return { ...base, updatedAt: cat.updatedAt || ptr.ts, deleted: false, deletedAt: 0, data: cat }
    }
    if (ptr.entity === 'plan') {
      const p = c.plan(ptr.entityId)
      if (!p) return { ...base, deleted: true, deletedAt: ptr.ts, data: null }
      return { ...base, updatedAt: ptr.ts, deleted: false, deletedAt: 0, data: p }
    }
    if (ptr.entity === 'filter') {
      const f = c.filter(ptr.entityId)
      if (!f) return { ...base, deleted: true, deletedAt: ptr.ts, data: null }
      return { ...base, updatedAt: ptr.ts, deleted: false, deletedAt: 0, data: f }
    }
  } catch (e) { log.warn('[LanSync] hydrate failed for', ptr.entity, ptr.entityId, e.message) }
  return null
}

function createLocalStoreAdapter () {
  return {
    getRowsSince (seq) {
      const ptrs = state.db.call('syncOplogSince', { sinceSeq: seq, limit: 10000 }) || []
      const cache = createHydrationCache()
      return ptrs.map(ptr => hydrateRow(ptr, cache)).filter(Boolean)
    },
    getCursor () { const v = state.db.call('getMeta', CURSOR_META_KEY); const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0 },
    setCursor (seq) { state.db.call('setMeta', [CURSOR_META_KEY, String(seq)]) },
    applyRow: row => applyRowSafe(row),
    /** Current live rows incl. tombstones, for buildSnapshot (seq-less; engine sorts by id). */
    allRows () {
      const out = []
      for (const t of state.db.call('getAll', { deleted: null }) || []) {
        out.push({ entity: 'todo', id: t.taskId, updatedAt: t.updateTime || 0, deleted: !!t.delete, deletedAt: t.deletedAt || 0, data: t })
      }
      for (const r of state.db.call('settingsRowsAll', {}) || []) {
        if (String(r.key).startsWith('sync.')) continue
        out.push({ entity: 'setting', id: r.key, updatedAt: r.updatedAt, deleted: !!r.deleted, deletedAt: r.deletedAt || 0, data: { key: r.key, value: r.value } })
      }
      for (const r of state.db.call('tomatoAll', {}) || []) out.push({ entity: 'tomato', id: r.tomatoId, updatedAt: r.updatedAt || 0, deleted: false, deletedAt: 0, data: r })
      for (const c of state.db.call('getAllCategories', {}) || []) out.push({ entity: 'category', id: String(c.categoryId), updatedAt: c.updatedAt || 0, deleted: false, deletedAt: 0, data: c })
      for (const c of state.db.call('planAll', {}) || []) out.push({ entity: 'plan', id: c.id, updatedAt: 0, deleted: false, deletedAt: 0, data: c })
      for (const f of state.db.call('filterList', {}) || []) out.push({ entity: 'filter', id: String(f.id), updatedAt: 0, deleted: false, deletedAt: 0, data: f })
      return out
    },
    /** Fresh-device path. P3a: merge-apply (non-destructive) — see header scope cuts. */
    replaceAll (rows) {
      for (const r of rows || []) applyRowSafe(r)
      flushPendingWrites()
    }
  }
}

/* ---------- apply: run merge rules, write the winner through regular db ops ---------- */
/** Content equality mirroring merge.mjs's contentDiffers (not exported there): bookkeeping fields
 *  (id/updatedAt/seq/deviceId/deletedAt markers + `deleted`) are excluded. */
function rowContentDiffers (a, b) {
  const SKIP = new Set(['id', 'updatedAt', 'seq', 'deviceId', 'deletedAt', 'deleted', 'entity', 'ts'])
  const keys = new Set([...Object.keys(a), ...Object.keys(b)])
  for (const k of keys) {
    if (SKIP.has(k)) continue
    if (a[k] !== b[k]) return true
  }
  return false
}

function applyRowSafe (incoming) {
  try { return applyRowInner(incoming) } catch (e) { log.warn('[LanSync] apply failed for', incoming && incoming.entity, incoming && incoming.id, e.message); return false }
}

function applyRowInner (incoming) {
  if (!incoming || !SYNCABLE_ENTITIES.has(incoming.entity)) return false
  const entity = incoming.entity
  // Locate the local counterpart for LWW comparison (cached: one entity-list read per ingest pass)
  const cache = state.applyCache || createHydrationCache()
  let localRow = null
  if (entity === 'todo') {
    const t = cache.todo(incoming.id)
    if (t) localRow = { updatedAt: t.updateTime || 0, deleted: !!t.delete, deletedAt: t.deletedAt || 0, data: t }
  } else if (entity === 'setting') {
    if (String(incoming.id).startsWith('sync.')) return false
    const r = cache.setting(incoming.id)
    if (r && !r.deleted) localRow = { updatedAt: r.updatedAt, deleted: false, deletedAt: 0, data: { key: r.key, value: r.value } }
  } else if (entity === 'tomato') {
    const r = cache.tomato(incoming.id)
    if (r) localRow = { updatedAt: r.updatedAt || 0, deleted: false, deletedAt: 0, data: r }
  } else if (entity === 'category') {
    const c = cache.category(incoming.id)
    if (c) localRow = { updatedAt: c.updatedAt || 0, deleted: false, deletedAt: 0, data: c }
  } else if (entity === 'plan') {
    const c = cache.plan(incoming.id)
    if (c) localRow = { updatedAt: 0, deleted: false, deletedAt: 0, data: c }
  } else if (entity === 'filter') {
    const f = cache.filter(incoming.id)
    if (f) localRow = { updatedAt: 0, deleted: false, deletedAt: 0, data: f }
  }
  if (!incoming.deleted && !incoming.data) return false // payload-less pointer, nothing to merge
  // Merge rules come from sync-core only (adapter boundary). Todos/chips/ledger have dedicated
  // rules; the remaining entities use the generic LWW shape.
  let winner
  if (entity === 'tomato') winner = mergeCore.mergeTomatoRows(localRow, incoming).row
  else winner = mergeCore.mergeTodoRows(localRow, incoming).row
  if (localRow && winner !== incoming) return false // local version stands
  if (localRow && winner === incoming && !rowContentDiffers(localRow, incoming)) return false // identical content: no-op, prevents apply/push ping-pong
  if (localRow && winner === incoming && mergeCore.mergeTodoRows(localRow, incoming).conflictCopy) {
    log.warn('[LanSync] conflict on', entity, incoming.id, '— local copy superseded (conflict-copy UI deferred)')
  }
  // Write the winner through the regular write ops (re-captured into the local oplog, which is what
  // propagates the acknowledged state back to the peer — idempotent under the same merge rules).
  // Todos/settings/tomato go through the per-segment write buffer: a first sync applies thousands of
  // rows and one transaction commit per row (~14ms each measured 2026-09-17) starves the round past
  // any sane budget, while the bulk ops commit in one transaction (upsertMany 3000 rows = ~110ms).
  if (entity === 'todo' && winner.data) {
    state.pendingWrites.todos.push({ ...winner.data, taskId: winner.data.taskId != null ? winner.data.taskId : incoming.id })
  } else if (entity === 'setting') {
    state.pendingWrites.settings.push({ key: incoming.id, value: winner.data.value })
  } else if (entity === 'tomato' && winner.data) {
    state.pendingWrites.tomatoes.push(winner.data)
  } else if (entity === 'category' && winner.data) {
    state.db.call('upsertCategory', { ...winner.data, id: winner.data.categoryId })
  } else if (entity === 'plan') {
    if (incoming.deleted) state.db.call('planRemoveIds', [incoming.id])
    else state.db.call('planAddMany', [winner.data])
  } else if (entity === 'filter') {
    if (incoming.deleted) state.db.call('filterDelete', Number(incoming.id))
    else state.db.call('filterUpsert', { ...winner.data, id: Number(incoming.id) })
  } else {
    return false
  }
  return true
}

/**
 * Flush the buffered bulk writes. Called after every ingested segment, after buildSnapshot-driven
 * replaceAll, and before the transport sends its round ack — a peer's push cursor may only advance
 * over rows that are already committed here (crash mid-buffer = rows unapplied, cursor stays, the
 * next round re-pushes; same crash semantics as commitSyncBatch §4.1).
 */
function flushPendingWrites () {
  const buf = state.pendingWrites
  try {
    if (buf.todos.length) state.db.call('upsertMany', buf.todos)
    if (buf.settings.length) state.db.call('settingsRowPutMany', buf.settings)
    if (buf.tomatoes.length) state.db.call('tomatoAppendMany', buf.tomatoes)
  } finally {
    buf.todos = []
    buf.settings = []
    buf.tomatoes = []
  }
}

/* ---------- engine + node lifecycle (lazy; only while enabled) ---------- */
function buildSegmentsWrapped (sinceSeq) {
  const r = state.engine.buildSegments(sinceSeq)
  state.pendingToSeq = r.toSeq
  return r.segments
}

/** Load persisted per-peer push watermarks into the live Map the node reads on every round. */
function loadPeerWatermarks () {
  try { return JSON.parse(settingGet(K_PEER_WATERMARKS) || '{}') || {} } catch { return {} }
}

function persistPeerWatermarks () {
  try { settingPut(K_PEER_WATERMARKS, JSON.stringify(state.peerWatermarks.raw())) } catch (e) { log.warn('[LanSync] watermark persist failed:', e.message) }
}

async function runRound () {
  if (!state || !state.node) return null
  try {
    const r = await state.node.startSyncRound()
    // Push progress is per-peer (the node records each peer's acked seq into state.peerWatermarks);
    // persist the map so watermarks survive restarts. There is no global cursor advance: a dead or
    // stale peer must never gate what a reachable peer receives, and each round only ships a
    // peer's unconfirmed delta (crash between ack and persist = re-push, idempotent §4.1).
    persistPeerWatermarks()
    notifyRenderers('round-done')
    return r
  } catch (e) { log.warn('[LanSync] round failed:', e.message); return null }
}

function manualPeers () {
  try { return JSON.parse(settingGet(K_MANUAL_PEERS) || '[]') || [] } catch { return [] }
}

function persistManualPeer (entry) {
  const list = manualPeers().filter(x => !(x.host === entry.host && Number(x.port) === Number(entry.port)))
  list.push(entry)
  settingPut(K_MANUAL_PEERS, JSON.stringify(list))
}

/** Map wrapper exposing .raw() for persistence; seeded from settings_rows so progress survives restarts. */
function createTrackedWatermarks () {
  const m = new Map(Object.entries(loadPeerWatermarks()).map(([k, v]) => [k, Number(v) || 0]))
  m.raw = () => Object.fromEntries(m)
  return m
}

function startSync () {
  if (state.node) return
  const { deviceId, deviceName } = ensureIdentity()
  const pairingSecret = settingGet(K_PAIRING_SECRET)
  if (!pairingSecret) { log.warn('[LanSync] enabled but no pairing secret — generating one'); settingPut(K_PAIRING_SECRET, generatePairingSecret()) }
  // Legacy-data bootstrap: rows written before the oplog existed have no capture pointers and
  // would never propagate to peers. Seed once per database on first sync start (2026-09-18 drill:
  // three legacy rows stayed unsynced forever while every captured row converged).
  try { const seeded = state.db.call('seedSyncOplog', {}); if (seeded && seeded.seeded > 0) log.info('[LanSync] seeded', seeded.seeded, 'legacy rows into the oplog') } catch (e) { log.warn('[LanSync] legacy seed failed:', e.message) }
  state.engine = createEngine({ localStore: createLocalStoreAdapter(), deviceId })
  state.node = createLanSyncNode({
    deviceId,
    peerProgress: state.peerWatermarks,
    name: settingGet(K_DEVICE_NAME) || deviceName,
    pairingSecret: settingGet(K_PAIRING_SECRET),
    verifyPairingCode: code => !!state.pairingCode && state.pairingCode.expiresAt > Date.now() &&
      (() => { const a = Buffer.from(String(code)); const b = Buffer.from(String(state.pairingCode.code)); return a.length === b.length && timingSafeEqual(a, b) })(),
    ingestSegment: body => {
      // One lookup cache per segment message: a peer's first-sync push carries thousands of rows
      // and applyRowInner must not re-read a full entity list per row (same O(n^2) trap as
      // hydration — 2026-09-18 drill: server handlers ran 30-60s and starved every round).
      state.applyCache = createHydrationCache()
      try {
        const r = state.engine.ingestSegment(body)
        flushPendingWrites()
        return r
      } finally { state.applyCache = null }
    },
    ingestSnapshot: body => state.engine.applySnapshot(body),
    buildSegments: buildSegmentsWrapped,
    buildSnapshot: () => state.engine.buildSnapshot()
  })
  state.node.on('round-error', info => { log.warn('[LanSync] round error:', info && info.error); notifyRenderers('round-error') })
  state.node.on('peer-unauthorized', info => log.warn('[LanSync] unauthorized peer rejected:', info && info.deviceId))
  // restore manually added peers (node peer table is memory-only; settings_rows is the authority)
  for (const mp of manualPeers()) {
    try { state.node.addPeer({ deviceId: 'manual-' + mp.host + ':' + mp.port, host: mp.host, port: Number(mp.port) }) } catch (e) { log.warn('[LanSync] manual peer restore failed:', e.message) }
  }
  state.node.start()
  state.pendingToSeq = 0
  // Auto round: 10s after enable/boot, then every 5 minutes (only while enabled)
  state.timers.push(setTimeout(() => { runRound() }, START_DELAY_MS))
  state.timers.push(setInterval(() => { runRound() }, ROUND_INTERVAL_MS))
  log.info('[LanSync] node started for', deviceId)
}

async function stopSync () {
  if (!state.node) return
  for (const t of state.timers) { clearTimeout(t); clearInterval(t) }
  state.timers = []
  const n = state.node
  state.node = null
  state.engine = null
  try { await n.stop() } catch (e) { log.warn('[LanSync] stop failed:', e.message) }
  log.info('[LanSync] node stopped')
}

function notifyRenderers (reason) {
  try {
    const senders = state.getWindowSenders ? state.getWindowSenders() : []
    for (const s of senders) { try { if (s && !s.isDestroyed()) s.send('lan-sync-changed', { reason, at: Date.now() }) } catch { /* dying sender */ } }
  } catch { /* renderer notification is best-effort */ }
}

/* ---------- IPC op handlers (registered into db.OPS via db-sync-ops) ---------- */
function getSettingsPayload () {
  const { deviceId, deviceName } = ensureIdentity()
  return {
    enabled: settingGet(K_ENABLED) === true,
    deviceId,
    deviceName,
    hasPairingSecret: !!settingGet(K_PAIRING_SECRET)
  }
}

function getStatusPayload () {
  const s = getSettingsPayload()
  if (!state.node) return { ...s, listening: false, port: null, peers: [], lastRoundAt: null, lastError: null }
  const st = state.node.getStatus()
  return { ...s, listening: st.listening, port: st.port, peers: st.peers, lastRoundAt: st.lastRoundAt, lastError: st.lastError }
}

function registerOps () {
  syncOps.register({
    syncGetSettings: () => getSettingsPayload(),
    syncGetStatus: () => getStatusPayload(),
    syncSetEnabled: p => {
      const enabled = !!(p && p.enabled)
      const wasEnabled = settingGet(K_ENABLED) === true
      if (enabled === wasEnabled && state.node === null && enabled === false) return getSettingsPayload()
      settingPut(K_ENABLED, enabled)
      if (enabled) {
        if (!settingGet(K_PAIRING_SECRET)) settingPut(K_PAIRING_SECRET, generatePairingSecret())
        startSync()
      } else {
        stopSync()
      }
      notifyRenderers('enabled-changed')
      return getSettingsPayload()
    },
    syncPairWithCode: async p => {
      const code = String((p && p.code) || '').trim()
      if (!/^\d{6}$/.test(code)) throw new Error('syncPairWithCode: 6-digit code required')
      if (!state.node) throw new Error('syncPairWithCode: sync is not enabled')
      const r = await state.node.pairWith(p && p.deviceId || undefined, code)
      settingPut(K_PAIRING_SECRET, String(r.secret))
      log.info('[LanSync] paired with peer', r.peer && r.peer.deviceId, '- shared secret adopted, restarting node')
      state.pairingCode = null // consumed; issue a fresh code on next click
      await stopSync()
      startSync()
      runRound().then(persistPeerWatermarks)
      return { ...getSettingsPayload(), peer: r.peer }
    },
    syncAddPeer: p => {
      const host = String((p && p.host) || '').trim()
      const port = Number((p && p.port) || 58471)
      if (!host || !/^[.:\w-]+$/.test(host)) throw new Error('syncAddPeer: host is required')
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('syncAddPeer: invalid port')
      if (!state.node) throw new Error('syncAddPeer: sync is not enabled')
      persistManualPeer({ host, port })
      // placeholder id until the first authenticated hello reveals the peer's real identity
      return state.node.addPeer({ deviceId: 'manual-' + host + ':' + port, host, port, name: (p && p.name) || undefined })
    },
    syncGetPairingCode: () => {
      const secret = settingGet(K_PAIRING_SECRET)
      if (!secret) return { code: null, expiresAt: 0 }
      if (state.pairingCode && state.pairingCode.expiresAt > Date.now()) return state.pairingCode
      const { deviceId } = ensureIdentity()
      const expiresAt = Date.now() + PAIRING_CODE_TTL_MS
      state.pairingCode = { code: derivePairingCode(secret, deviceId + ':' + expiresAt), expiresAt }
      return state.pairingCode
    },
    syncSetName: p => {
      const name = String((p && p.name) || '').trim().slice(0, 40)
      if (!name) throw new Error('syncSetName: name is required')
      settingPut(K_DEVICE_NAME, name)
      if (state.node) { // advertising payload carries the name: restart to re-broadcast
        stopSync().then(() => { if (settingGet(K_ENABLED) === true) startSync() }).catch(() => {})
      }
      return getSettingsPayload()
    }
  })
}

/** Called once from src/main/index.js after db init. Never auto-enables sync. */
function initLanSync ({ db, getWindowSenders }) {
  const peerWatermarks = createTrackedWatermarks()
  state = { db, getWindowSenders, node: null, engine: null, timers: [], pendingToSeq: 0, peerWatermarks, pendingWrites: { todos: [], settings: [], tomatoes: [] } }
  registerOps()
  try {
    if (settingGet(K_ENABLED) === true) startSync()
  } catch (e) { log.warn('[LanSync] startup enable failed:', e.message) }
}

module.exports = { initLanSync }
