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
const { SYNC_SCHEMA_VERSION } = require('../../shared/sync-core/merge.mjs')
const { generatePairingSecret, derivePairingCode } = require('../../shared/sync-core/pairing.mjs')
const { createLanSyncNode } = require('./lan-sync/index')
const { DEFAULT_PORT } = require('./lan-sync/transport')
const syncOps = require('./db-sync-ops')

// settings_rows keys (never synced: hydration skips the 'sync.' namespace, otherwise peers would
// adopt each other's identity)
const K_DEVICE_ID = 'sync.deviceId'
const K_DEVICE_NAME = 'sync.deviceName'
const K_PAIRING_SECRET = 'sync.pairingSecret'
const K_ENABLED = 'sync.enabled'
const K_MANUAL_PEERS = 'sync.manualPeers' // [{host,port}] — survives restarts (node peers are memory-only)
const CURSOR_META_KEY = 'sync.pushCursor' // persisted in meta (not settings_rows): per-device bookkeeping, no sync obligation
// v2 (2026-09-18): the pre-v2 values were persisted in the RECEIVER's local seq space (its own
// max oplog seq) while buildSegments(fromSeq) consumes the SENDER's space — feeding those back
// overshot the cursor and skipped the sender's fresh rows. v2 starts empty once: the worst case
// of dropping a watermark is a re-push of already-applied rows, which is idempotent (§4.1).
const K_PEER_WATERMARKS = 'sync.peerWatermarks.v2'
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
  // Defensive GC-marker guard: legacy ('*gc*') oplog pointers (planPrune / tomatoMigrateFromMeta,
  // and pre-2026-09-18 purge rows) are ring-buffer bookkeeping, not records — hydrating one used
  // to materialize a ghost tombstone with taskId '*gc*' on peers.
  if (String(ptr.entityId) === '*gc*') return null
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

/**
 * LWW clock-skew clamp (single choke point for ALL inbound rows: increments and snapshot chunks
 * both land here). A peer whose clock runs far ahead would otherwise stamp every future conflict
 * in its favor forever. Clamp only the comparison keys (updatedAt/deletedAt) to `now` when they
 * are more than SKEW_CLAMP into the future; the stored payload (`data`) is never touched.
 */
const SKEW_CLAMP_MS = 10 * 60 * 1000
function clampSkew (row) {
  if (!row || typeof row !== 'object') return row
  const now = Date.now()
  const limit = now + SKEW_CLAMP_MS
  const future = (row.updatedAt > limit) || (row.deletedAt > limit)
  if (!future) return row
  return {
    ...row,
    updatedAt: row.updatedAt > limit ? now : row.updatedAt,
    deletedAt: row.deletedAt > limit ? now : row.deletedAt,
  }
}

function applyRowInner (incoming) {
  if (!incoming || !SYNCABLE_ENTITIES.has(incoming.entity)) return false
  // Defensive: a '*gc*' oplog marker must never surface as an appliable row id (see hydrateRow).
  if (String(incoming.id) === '*gc*') return false
  incoming = clampSkew(incoming)
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
    // settingsRowsAll (deliberately) includes tombstones: a LOCAL tombstone must take part in the
    // merge as a real row, otherwise an older remote live row wins LWW against "missing" and
    // resurrects what the user deleted here (delete-wins never gets a chance to hold).
    if (r) localRow = { updatedAt: r.updatedAt, deleted: !!r.deleted, deletedAt: r.deletedAt || 0, data: { key: r.key, value: r.value } }
  } else if (entity === 'tomato') {
    const r = cache.tomato(incoming.id)
    // tomatoAll filters deleted=0 (db.js), so a local tomato tombstone reads as "absent" here;
    // localRow stays null and the incoming row (including its tombstone) wins and is landed via
    // the tomatoRemoveByIds branch below — the tombstone still takes effect, idempotently.
    if (r) localRow = { updatedAt: r.updatedAt || 0, deleted: false, deletedAt: 0, data: r }
  } else if (entity === 'category') {
    const c = cache.category(incoming.id)
    if (c) localRow = { updatedAt: c.updatedAt || 0, deleted: false, deletedAt: 0, data: c }
  } else if (entity === 'plan') {
    // planAll/filterList do not SELECT updatedAt (db.js - outside this fix file scope), so the
    // local LWW age is UNKNOWN, not 0. An honest LWW is impossible across that domain: treating
    // unknown as 0 makes every remote row (ts > 0) win, so two devices ping-pong plan/filter
    // edits every round, each clobbering the other newer state. ageUnknown rows are therefore
    // SKIPPED for live-row writes (conservative); tombstones still land (deletion propagation is
    // strictly safer than a divergent resurrect).
    const c = cache.plan(incoming.id)
    if (c) localRow = { updatedAt: 0, deleted: false, deletedAt: 0, ageUnknown: true, data: c }
  } else if (entity === 'filter') {
    const f = cache.filter(incoming.id)
    if (f) localRow = { updatedAt: 0, deleted: false, deletedAt: 0, ageUnknown: true, data: f }
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
  if (entity === 'todo') {
    if (winner.deleted && !winner.data) {
      // Remote tombstone winner: without this branch no write fired and the peer's deletion NEVER
      // landed here (every branch required winner.data). Land it through the buffered bulk path —
      // todoToRow normalizes `delete:1` into a deleted=1 tombstone row on upsertMany.
      state.pendingWrites.todos.push({ taskId: incoming.id, delete: 1, deletedAt: winner.deletedAt || incoming.deletedAt || 0 })
      return true
    }
    if (!winner.data) return false
    state.pendingWrites.todos.push({ ...winner.data, taskId: winner.data.taskId != null ? winner.data.taskId : incoming.id })
  } else if (entity === 'setting') {
    if (winner.deleted) {
      // Tombstone winner (delete-wins). settingsRowPut/putRow clears `deleted` on write, so pushing
      // the (data-carrying) tombstone through the buffer would RESURRECT the row; land the
      // deletion through the dedicated tombstone op instead. Direct sync call: deletes are rare
      // and tiny, no bulk buffering needed.
      state.db.call('settingsRowDelete', { key: incoming.id })
      return true
    }
    if (!winner.data) return false
    state.pendingWrites.settings.push({ key: incoming.id, value: winner.data.value })
  } else if (entity === 'tomato') {
    if (winner.deleted && !winner.data) {
      // Tomato tombstone winner (hydrated from a pointer whose row is gone locally): land it via
      // the tombstone op. Direct sync call, same reasoning as settingsRowDelete above.
      state.db.call('tomatoRemoveByIds', [incoming.id])
      return true
    }
    if (!winner.data) return false
    state.pendingWrites.tomatoes.push(winner.data)
  } else if (entity === 'category' && winner.data) {
    state.db.call('upsertCategory', { ...winner.data, id: winner.data.categoryId })
  } else if (entity === 'plan') {
    if (incoming.deleted) state.db.call('planRemoveIds', [incoming.id])
    else if (localRow && localRow.ageUnknown) return false // cross-domain LWW: local age unknown, refuse to clobber
    else state.db.call('planAddMany', [winner.data])
  } else if (entity === 'filter') {
    if (incoming.deleted) state.db.call('filterDelete', Number(incoming.id))
    else if (localRow && localRow.ageUnknown) return false // cross-domain LWW: local age unknown, refuse to clobber
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
  if (buf.todos.length) state.db.call('upsertMany', buf.todos)
  if (buf.settings.length) state.db.call('settingsRowPutMany', buf.settings)
  if (buf.tomatoes.length) state.db.call('tomatoAppendMany', buf.tomatoes)
  // Clear ONLY after every bulk op committed. A throw here must propagate to the round: the engine
  // has already recorded the rows applied and the peer will be acked, so silently dropping the
  // buffer (the old `finally` clear) lost those rows forever. Letting the exception escape fails
  // the round, the peer's cursor stays put, and the next round re-pushes (idempotent, §4.1).
  buf.todos = []
  buf.settings = []
  buf.tomatoes = []
}

/**
 * Local max oplog seq — reported to peers as `ack.appliedToSeq` so their per-peer push watermarks
 * can advance and rounds ship deltas instead of re-pushing the full backlog every time.
 * syncOplogSince is ascending-only with a clamped limit, so page forward; the ring buffer keeps
 * ~10k rows, so this is one query in practice (two at most right after a trim boundary).
 */
function readMaxOplogSeq () {
  let since = 0
  for (let i = 0; i < 10000; i++) {
    const rows = state.db.call('syncOplogSince', { sinceSeq: since, limit: 10000 }) || []
    if (rows.length < 10000) return rows.length ? rows[rows.length - 1].seq : since
    since = rows[rows.length - 1].seq
  }
  return since
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
    ingestSnapshot: body => {
      // Snapshot-request protocol receiver (assembled {schemaVersion, deviceId, rows} from the
      // node): apply the rows through the SAME applyRowInner pipeline as increments (merge rules,
      // tombstones, per-pass applyCache, buffered bulk writes). Chunk-merge-apply is idempotent,
      // so a partial snapshot leaves a consistent DB; the node advances the pull watermark ONLY
      // on snapshot-end, so a failed/partial transfer never skips missed increments. Deliberately
      // NOT engine.applySnapshot: that is the fresh-device replaceAll path and resets the global
      // push cursor to 0, which would cause a full oplog re-push to every peer.
      const rows = Array.isArray(body && body.rows) ? body.rows : []
      state.applyCache = createHydrationCache()
      try {
        for (const r of rows) applyRowSafe(r)
        flushPendingWrites()
      } finally { state.applyCache = null }
      return { rows: rows.length }
    },
    // Streaming snapshot receiver: the node calls this PER received snapshot-chunk, so the
    // full snapshot never materializes in memory and pendingWrites flush per chunk (bounded
    // buffers). Crash semantics unchanged: the pull watermark still advances only at
    // snapshot-end, and chunk-merge-apply is idempotent.
    ingestSnapshotChunk: body => {
      const rows = Array.isArray(body && body.rows) ? body.rows : []
      state.applyCache = createHydrationCache()
      try {
        for (const r of rows) applyRowSafe(r)
        flushPendingWrites()
      } finally { state.applyCache = null }
      return { rows: rows.length }
    },
    getMaxSeq: () => readMaxOplogSeq(),
    // Oldest oplog seq still retained (the ring prunes from the front): advertised in the round
    // ack so a watermark-behind peer can tell its increments were pruned on our side.
    getOldestSeq: () => {
      const rows = state.db.call('syncOplogSince', { sinceSeq: 0, limit: 1 }) || []
      return rows.length ? rows[0].seq : 0
    },
    buildSegments: buildSegmentsWrapped,
    // Memory-bounded snapshot sender: the node streams bounded chunks straight from this rows
    // array (sorted like engine.buildSnapshot). engine.buildSnapshot (full canonical JSON
    // string) is intentionally NOT wired here anymore — materializing it held ~3x the dataset
    // in the main process during a snapshot send. It stays available in the engine for
    // tests/CLI.
    buildSnapshotRows: () => {
      const rows = createLocalStoreAdapter().allRows()
      rows.sort((a, b) => String(a.id).localeCompare(String(b.id)))
      return rows
    },
    snapshotSchemaVersion: SYNC_SCHEMA_VERSION,
  })
  state.node.on('round-error', info => {
    log.warn('[LanSync] round error:', info && info.error)
    emitSyncEvent('round-error', { deviceId: info && info.peer, detail: info && info.error && info.error.message })
    notifyRenderers('round-error')
  })
  state.node.on('round-done', info => emitSyncEvent('round-done', { deviceId: info && info.peer, applied: info && info.applied }))
  // Snapshot-request protocol activity for the Device Center feed (sent = we served a peer's
  // snapshot-request; received = we recovered via a peer's full snapshot).
  state.node.on('snapshot-sync', info => emitSyncEvent('snapshot-sync', {
    deviceId: info && info.peer, direction: info && info.direction, rows: info && info.rows,
  }))
  state.node.on('peer-online', p => emitSyncEvent('peer-online', { deviceId: p.deviceId, deviceName: p.name, host: p.host }))
  state.node.on('peer-offline', p => emitSyncEvent('peer-offline', { deviceId: p.deviceId, deviceName: p.name, host: p.host }))
  state.node.on('pair-throttled', info => emitSyncEvent('pair-throttled', { ip: info && info.ip }))
  // Inbound two-way confirm request: hold it for the human (respond callback comes from the
  // transport, which owns the 60s auto-reject timer) and surface it to the renderer.
  state.node.on('pair-request', info => {
    state.pendingPair = info
    emitSyncEvent('pair-request', { deviceId: info && info.deviceId, deviceName: info && info.deviceName, host: info && info.host })
  })
  state.node.on('pair-accepted', info => emitSyncEvent('pair-accepted', { host: info && info.host, port: info && info.port }))
  state.node.on('pair-rejected', info => emitSyncEvent('pair-rejected', { host: info && info.host, port: info && info.port, reason: info && info.reason }))
  // Inbound pairing completed (manual code or confirmed): tell the renderer it succeeded.
  state.node.on('paired-inbound', info => emitSyncEvent('pair-accepted', { deviceId: info && info.deviceId, host: info && info.host }))
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
  state.pendingPair = null
  try { await n.stop() } catch (e) { log.warn('[LanSync] stop failed:', e.message) }
  log.info('[LanSync] node stopped')
}

function notifyRenderers (reason) {
  try {
    const senders = state.getWindowSenders ? state.getWindowSenders() : []
    for (const s of senders) { try { if (s && !s.isDestroyed()) s.send('lan-sync-changed', { reason, at: Date.now() }) } catch { /* dying sender */ } }
  } catch { /* renderer notification is best-effort */ }
}

/**
 * Device Center event channel: ONE 'syncEvent' IPC event carrying a self-describing payload
 * {type, at, ...}. Kept alongside the legacy 'lan-sync-changed' ping (existing consumers keep
 * working). Types: peer-online, peer-offline, pair-request, pair-accepted, pair-rejected,
 * round-done, round-error, pair-throttled.
 */
function emitSyncEvent (type, payload) {
  try {
    const senders = state.getWindowSenders ? state.getWindowSenders() : []
    const msg = { type, at: Date.now(), ...(payload || {}) }
    for (const s of senders) { try { if (s && !s.isDestroyed()) s.send('syncEvent', msg) } catch { /* dying sender */ } }
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
  if (!state.node) {
    return {
      ...s, listening: false, port: null, peers: [], recent: [], security: [],
      lastRoundAt: null, lastError: null,
      self: { deviceId: s.deviceId, deviceName: s.deviceName, port: null },
    }
  }
  const st = state.node.getStatus()
  return {
    ...s, listening: st.listening, port: st.port,
    peers: st.peers, recent: st.recent, security: st.security,
    lastRoundAt: st.lastRoundAt, lastError: st.lastError,
    self: st.self || { deviceId: s.deviceId, deviceName: s.deviceName, port: st.port },
  }
}

function registerOps () {
  syncOps.register({
    // main-internal (not renderer-callable): one-time legacy-row oplog backfill, see startSync.
    seedSyncOplog: () => {
      if (settingGet('sync.seedDone')) return { seeded: 0 }
      // bare pointers only: content already lives locally; hydration on push reads the live rows.
      const seen = new Set()
      const rows = []
      for (const r of createLocalStoreAdapter().allRows()) {
        const k = r.entity + ':' + r.id
        if (!seen.has(k)) { seen.add(k); rows.push({ entity: r.entity, id: r.id }) }
      }
      const res = state.db.call('appendOplogPointers', rows)
      settingPut('sync.seedDone', '1')
      return res
    },
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
    // Two-way confirmed pairing: respond to the pending inbound pair-request (from syncEvent
    // 'pair-request'). The transport's 60s timer already auto-rejects on silence.
    syncPairRespond: p => {
      const accept = !!(p && p.accept)
      const info = state.pendingPair
      state.pendingPair = null
      if (!info || typeof info.respond !== 'function') return { ok: false, error: 'no pending pair request' }
      try { info.respond(accept) } catch (e) { log.warn('[LanSync] pair respond failed:', e.message); return { ok: false, error: e.message } }
      log.info('[LanSync] inbound pair request', accept ? 'accepted' : 'rejected', 'from', info.host)
      return { ok: true, accept }
    },
    // Two-way confirmed pairing: dial the peer and ask. Resolves once the peer's human accepts
    // (secret adopted like syncPairWithCode, node restarted, first round kicked off); rejects on
    // pair-reject / timeout, with the syncEvent 'pair-rejected' already emitted by the node.
    syncPairRequest: async p => {
      const host = String((p && p.host) || '').trim()
      const port = Number.isInteger(p && p.port) ? p.port : DEFAULT_PORT
      if (!host || !/^[.:\w-]+$/.test(host)) throw new Error('syncPairRequest: host is required')
      if (!state.node) throw new Error('syncPairRequest: sync is not enabled')
      const r = await state.node.requestPair(host, port)
      settingPut(K_PAIRING_SECRET, String(r.secret))
      log.info('[LanSync] two-way pairing accepted by', host, '- shared secret adopted, restarting node')
      await stopSync()
      startSync()
      runRound().then(persistPeerWatermarks)
      return { ...getSettingsPayload(), host: r.host, port: r.port }
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
  state = { db, getWindowSenders, node: null, engine: null, timers: [], pendingToSeq: 0, peerWatermarks, pendingWrites: { todos: [], settings: [], tomatoes: [] }, pendingPair: null }
  registerOps()
  try {
    if (settingGet(K_ENABLED) === true) startSync()
  } catch (e) { log.warn('[LanSync] startup enable failed:', e.message) }
}

module.exports = { initLanSync }

// Test-only hooks: applyRowInner/flushPendingWrites operate on the module-level `state` singleton;
// unit tests swap in a mock state via __test.setState. Production paths never touch __test.
module.exports.__test = {
  setState: s => { state = s },
  applyRow: row => applyRowSafe(row),
  flushPendingWrites,
}
