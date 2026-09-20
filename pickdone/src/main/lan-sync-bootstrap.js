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
 *   - conflictCopy from merge.mjs is materialized for todos only (tombstoned recycle-bin row,
 *     see sync-apply.js); other entities log the loser (no conflict-copy UI yet).
 *   - applySnapshot/replaceAll is implemented as merge-apply (non-destructive) because the round
 *     protocol never sends snapshot-request in P3a; a true destructive reset is deferred.
 */
const { randomUUID, timingSafeEqual } = require('node:crypto')
const os = require('node:os')
const log = require('electron-log')
const { createEngine } = require('../../shared/sync-core/engine.mjs')
const { SYNC_SCHEMA_VERSION } = require('../../shared/sync-core/merge.mjs')
const { generatePairingSecret, derivePairingCode } = require('../../shared/sync-core/pairing.mjs')
const { createLanSyncNode } = require('./lan-sync/index')
const { DEFAULT_PORT } = require('./lan-sync/transport')
const { isDialableHost } = require('./lan-sync/discovery')
const syncOps = require('./db-sync-ops')

// settings_rows keys (never synced: hydration skips the 'sync.' namespace, otherwise peers would adopt each other's identity)
const K_DEVICE_ID = 'sync.deviceId'
const K_DEVICE_NAME = 'sync.deviceName'
const K_PAIRING_SECRET = 'sync.pairingSecret'
const K_ENABLED = 'sync.enabled'
const K_MANUAL_PEERS = 'sync.manualPeers' // [{host,port}] — survives restarts (node peers are memory-only)
// Round-1 P0 (2026-09-21): the PAIRED peer table — {deviceId: {deviceId,name,host,port,pairedAt}}.
// The peer table used to live ONLY in node memory: `sync status` showed peers:(none) after every
// restart and the periodic round had no dial targets until mDNS happened to re-find the peer.
// The transport port is FIXED (58471, transport.DEFAULT_PORT) — both nodes bind the same port, so
// the listening side can record a reachable peer address from the inbound connection alone.
const K_PAIRED_PEERS = 'sync.peers'
const CURSOR_META_KEY = 'sync.pushCursor' // persisted in meta (not settings_rows): per-device bookkeeping, no sync obligation
// v2 (2026-09-18): the pre-v2 values were persisted in the RECEIVER's local seq space (its own
// max oplog seq) while buildSegments(fromSeq) consumes the SENDER's space — feeding those back
// overshot the cursor and skipped the sender's fresh rows. v2 starts empty once: the worst case of dropping a watermark is a re-push of already-applied rows, which is idempotent (§4.1).
const K_PEER_WATERMARKS = 'sync.peerWatermarks.v2' // {deviceId: highestSeqThatPeerAcked} — per-peer push progress (survives restarts)
const K_SECURITY_LOG = 'sync.securityLog' // last 20 security-ring entries (pair-throttled / auth-rejected), JSON — survives restarts
const SECURITY_PERSIST_MIN_MS = 1000 // write-throttle: at most one security-log write per second
const BLOB_SETTINGS_KEY = 'db.settingsState' // P1-2a: the renderer settings blob the applied rows are folded back into
const START_DELAY_MS = 2000
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
/* The apply/hydration/flush pipeline lives in ./sync-apply.js (line ratchet, round-3 review);
 * the delegates below bind the bootstrap's module-level `state` singleton to it. */
const syncApply = require('./sync-apply')
const { isMachineLocalSettingKey, isMachineLocalMetaKey, isSyncBlobMetaKey } = syncApply
const createHydrationCache = () => syncApply.createHydrationCache(state)
const hydrateRow = (ptr, cache) => syncApply.hydrateRow(state, ptr, cache)
const localUserId = () => syncApply.localUserId(state)
const applyRowSafe = row => syncApply.applyRowSafe(state, row)
const flushPendingWrites = () => syncApply.flushPendingWrites(state)
const readMaxOplogSeq = () => syncApply.readMaxOplogSeq(state)

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
        // 'sync.' = identity namespace; 'securityLock*' = password/question ciphertext — both must never leave this device (round-3 review: the settingsState bridge mirrors securityLock rows into settings_rows).
        if (isMachineLocalSettingKey(r.key)) continue
        out.push({ entity: 'setting', id: r.key, updatedAt: r.updatedAt, deleted: !!r.deleted, deletedAt: r.deletedAt || 0, data: { key: r.key, value: r.value } })
      }
      for (const r of state.db.call('tomatoAll', {}) || []) out.push({ entity: 'tomato', id: r.tomatoId, updatedAt: r.updatedAt || 0, deleted: false, deletedAt: 0, data: r })
      for (const r of state.db.call('tomatoTombstones', {}) || []) out.push({ entity: 'tomato', id: r.tomatoId, updatedAt: r.updatedAt || 0, deleted: true, deletedAt: r.deletedAt || 0, data: null }) // X1: snapshot tombstones (rationale in sync-apply.js tomato localRow)
      // M1/M3 (2026-09-20): categories snapshot from the RAW row table — peers apply category data
      // through upsertCategory (row columns), and local tombstones must ride along (data:null) so a
      // fresh device learns about deletions. Same tombstone rule for plans/filters (delete-wins for locally deleted rows on the receiving side).
      for (const c of state.db.call('categoriesAllRows', {}) || []) out.push({ entity: 'category', id: String(c.id), updatedAt: c.updatedAt || 0, deleted: !!c.deleted, deletedAt: c.deletedAt || 0, data: c.deleted ? null : c })
      for (const c of state.db.call('planAll', {}) || []) out.push({ entity: 'plan', id: c.id, updatedAt: c.updatedAt || 0, deleted: false, deletedAt: 0, data: c })
      for (const t of state.db.call('planTombstones', {}) || []) out.push({ entity: 'plan', id: t.id, updatedAt: t.updatedAt || 0, deleted: true, deletedAt: t.deletedAt || 0, data: null })
      for (const f of state.db.call('filterList', {}) || []) out.push({ entity: 'filter', id: String(f.id), updatedAt: f.updatedAt || 0, deleted: false, deletedAt: 0, data: f })
      for (const t of state.db.call('filterTombstones', {}) || []) out.push({ entity: 'filter', id: String(t.id), updatedAt: t.updatedAt || 0, deleted: true, deletedAt: t.deletedAt || 0, data: null })
      // Meta entity (GAP-A fix 2026-09-19): meta has no list-read op (db.js is size-ratcheted), so
      // syncable meta keys are enumerated from their oplog pointers (latest local ts per key, one
      // paged oplog scan) and read via getMeta. Legacy pre-oplog meta keys are not covered here — they
      // surface once any device rewrites them; meta tombstones propagate via increments only (a pointer whose value is already gone reads as deleted in hydrateRow).
      const metaCache = syncApply.createHydrationCache(state)
      const metaTs = metaCache.metaTs()
      for (const key of metaTs.keys()) {
        if (isMachineLocalMetaKey(key) || isSyncBlobMetaKey(key)) continue
        const v = metaCache.meta(key)
        if (v == null) continue // deleted: tombstones are carried by the increment pointers
        out.push({ entity: 'meta', id: key, updatedAt: metaTs.get(key) || 0, deleted: false, deletedAt: 0, data: { key, value: v } })
      }
      return out
    },
    /** Fresh-device path. P3a: merge-apply (non-destructive) — see header scope cuts. */
    replaceAll (rows) {
      for (const r of rows || []) applyRowSafe(r)
      flushPendingWrites()
    }
  }
}

/* ---------- engine + node lifecycle (lazy; only while enabled) ---------- */
/**
 * Symmetric LWW tie-breaks (merge.mjs compareRecency): inbound rows are stamped with the
 * SENDING device's id (the segment envelope's deviceId) so a full tie resolves to the same
 * winner on both peers. Without this the local side has no deviceId at all and tie outcomes
 * depended on which side happened to be applying (loop fix 2026-09-18).
 */
function withPeerDeviceId (body) {
  if (body && typeof body === 'object' && body.deviceId && Array.isArray(body.rows)) {
    return { ...body, rows: body.rows.map(r => ({ ...r, deviceId: body.deviceId })) }
  }
  return body
}

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

/* ---------- security ring persistence (survives restarts; recent ring stays ephemeral) ---------- */
function loadSecurityLog () {
  try { const v = JSON.parse(settingGet(K_SECURITY_LOG) || '[]'); return Array.isArray(v) ? v.slice(-20) : [] } catch { return [] }
}
let securityPersistTimer = null
function scheduleSecurityPersist () {
  // Write-throttled to <=1 write/sec: an attacker spraying pair-requests must not turn the
  // settings table into a write amplifier.
  if (securityPersistTimer) return
  securityPersistTimer = setTimeout(() => {
    securityPersistTimer = null
    try {
      if (!state.node) return
      settingPut(K_SECURITY_LOG, JSON.stringify(state.node.getStatus().security.slice(-20)))
    } catch (e) { log.warn('[LanSync] security log persist failed:', e.message) }
  }, SECURITY_PERSIST_MIN_MS)
  securityPersistTimer.unref?.()
}

/* Change-triggered sync: local writes kick a debounced immediate round instead of waiting up
 * ROUND_INTERVAL_MS for the next periodic one. Floor-guarded so bulk imports fire one round,
 * not one per write. */
const KICK_DEBOUNCE_MS = 300
const KICK_FLOOR_MS = 1500
let kickTimer = null
let lastKickRoundAt = 0
function kickSyncRound (reason) {
  if (!state || !state.node) return
  const since = Date.now() - lastKickRoundAt
  const delay = Math.max(KICK_DEBOUNCE_MS, since < KICK_FLOOR_MS ? KICK_FLOOR_MS - since : 0)
  clearTimeout(kickTimer)
  kickTimer = setTimeout(() => {
    kickTimer = null
    lastKickRoundAt = Date.now()
    runRound()
  }, delay)
  kickTimer.unref?.()
}
async function runRound () {
  if (!state || !state.node) return null
  try {
    const t0 = Date.now()
    const r = await state.node.startSyncRound()
    log.info('[LanSync] round done in ' + (Date.now() - t0) + 'ms, confirmed ' + (r && r.confirmed) + '/' + (r && r.peers))
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

/* ---------- Round-1 P0 (2026-09-21): paired-peer persistence + address hygiene ---------- */
/** Normalize a wire/host address to a dialable form: strip IPv4-mapped IPv6 (::ffff:a.b.c.d);
 *  return null for junk (scope-less link-local, 169.254.*, virtual ranges). */
function normalizeHost (host) {
  let h = String(host || '').trim()
  if (h.startsWith('::ffff:')) h = h.slice(7)
  return isDialableHost(h) ? h : null
}
function loadPairedPeers () {
  try {
    const v = JSON.parse(settingGet(K_PAIRED_PEERS) || '{}')
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : {}
  } catch { return {} }
}
/** Merge a peer record keyed by deviceId. Writes ONLY on a real change (connection events fire
 *  per dial — this must not turn into a settings-table write amplifier). Returns true when written. */
function persistPairedPeer (entry) {
  try {
    if (!entry || !entry.deviceId || typeof entry.deviceId !== 'string') return false
    const all = loadPairedPeers()
    const prev = all[entry.deviceId] || {}
    const next = {
      deviceId: entry.deviceId,
      name: entry.name || prev.name || entry.deviceId,
      // ACTUAL TCP address first (the caller passes socket remote addresses), previous value as
      // fallback; undialable junk never overwrites a working address.
      host: normalizeHost(entry.host) || prev.host || null,
      port: (Number.isInteger(entry.port) && entry.port > 0 && entry.port <= 65535) ? entry.port : (prev.port || DEFAULT_PORT),
      pairedAt: prev.pairedAt || Date.now(),
    }
    if (prev.host === next.host && prev.port === next.port && prev.name === next.name) return false
    all[entry.deviceId] = next
    settingPut(K_PAIRED_PEERS, JSON.stringify(all))
    return true
  } catch (e) { log.warn('[LanSync] paired-peer persist failed:', e.message); return false }
}
function removePairedPeer (deviceId) {
  try {
    const all = loadPairedPeers()
    if (all[deviceId]) { delete all[deviceId]; settingPut(K_PAIRED_PEERS, JSON.stringify(all)) }
  } catch (e) { log.warn('[LanSync] paired-peer remove failed:', e.message) }
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
  state.deviceId = deviceId // symmetric tie-break stamping (see withPeerDeviceId / sync-apply)
  // P1-4 (2026-09-19 data-safety round): per-node write buffers + applied bookkeeping — a fresh
  // start never inherits buffered (uncommitted) rows from a previous node instance.
  state.pendingWrites = { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] }
  state.applied = null
  state.node = createLanSyncNode({
    deviceId,
    peerProgress: state.peerWatermarks,
    name: settingGet(K_DEVICE_NAME) || deviceName,
    pairingSecret: settingGet(K_PAIRING_SECRET),
    securityLog: loadSecurityLog(),
    verifyPairingCode: code => !!state.pairingCode && state.pairingCode.expiresAt > Date.now() &&
      (() => { const a = Buffer.from(String(code)); const b = Buffer.from(String(state.pairingCode.code)); return a.length === b.length && timingSafeEqual(a, b) })(),
    ingestSegment: body => {
      // One lookup cache per segment message: a peer's first-sync push carries thousands of rows
      // and applyRowInner must not re-read a full entity list per row (same O(n^2) trap as
      // hydration — 2026-09-18 drill: server handlers ran 30-60s and starved every round).
      state.applyCache = createHydrationCache()
      try {
        const r = state.engine.ingestSegment(withPeerDeviceId(body))
        // P0-1 (2026-09-19 data-safety round): a failed bulk flush (poison row) must NOT be acked
        // as applied — the rows were dropped from the buffer. Stamp the ingest result so the
        // server role keeps appliedToSeq below this segment and the sender force-arms its
        // snapshot trigger; the data remains recoverable via the next snapshot.
        const flush = flushPendingWrites()
        if (flush && flush.ok === false) r.flushFailed = true
        emitAppliedRound() // P0-1: refresh open views + settings hot-apply after a round applied rows
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
        for (const r of withPeerDeviceId(body).rows || []) applyRowSafe(r)
        // P0-1: same flush-failure honesty as the streaming path — fail loudly so the watermark
        // never advances over rows that were dropped.
        const flush = flushPendingWrites()
        if (flush && flush.ok === false) throw new Error('snapshot flush failed (rows dropped, snapshot will retry)')
        emitAppliedRound()
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
        for (const r of withPeerDeviceId(body).rows || []) applyRowSafe(r)
        // P0-1: a failed flush during a streamed snapshot must fail the ROUND (throw) — the pull
        // watermark advances only at snapshot-end, so a failed chunk keeps the watermark put and
        // the next round re-requests the (idempotent) snapshot instead of acking dropped rows.
        const flush = flushPendingWrites()
        if (flush && flush.ok === false) throw new Error('snapshot chunk flush failed (rows dropped, snapshot will retry)')
        emitAppliedRound()
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
    // Attachment file pull (feature): after each confirmed round the client asks this for the
    // attachment keys referenced by todo rows but missing on disk, and requests the files over
    // the same encrypted session (att-transfer.js: hash-verified, atomic write, capped batch).
    getMissingAttachmentKeys: () => missingAttachmentKeys(state),
    // P1-8 (2026-09-19 UX review): a pulled attachment file landed on disk — tell the renderer so
    // EpAttachments can re-attempt image loads / refresh the list without a manual view change.
    onAttachmentArrived: key => emitSyncEvent('attachments-arrived', { key: String(key || '') }),
  })
  state.node.on('round-error', info => {
    log.warn('[LanSync] round error:', info && info.error)
    emitSyncEvent('round-error', { deviceId: info && info.peer, detail: info && info.error && info.error.message })
    notifyRenderers('round-error')
  })
  // Server-role failures (round-3 review, loud EADDRINUSE): a fixed-port collision or another
  // listener-level error must be VISIBLE — log.error + Device Center syncEvent + status
  // lastError (the node already records err.message into its getStatus().lastError).
  state.node.on('server-error', err => {
    log.error('[LanSync] server error:', err && err.message)
    emitSyncEvent('server-error', { detail: err && err.message, code: err && err.code })
    notifyRenderers('round-error')
  })
  state.node.on('round-done', info => emitSyncEvent('round-done', { deviceId: info && info.peer, applied: info && info.applied }))
  // Snapshot-request protocol activity for the Device Center feed (sent = we served a peer's
  // snapshot-request; received = we recovered via a peer's full snapshot).
  state.node.on('snapshot-sync', info => emitSyncEvent('snapshot-sync', {
    deviceId: info && info.peer, direction: info && info.direction, rows: info && info.rows,
  }))
  state.node.on('peer-online', p => { emitSyncEvent('peer-online', { deviceId: p.deviceId, deviceName: p.name, host: p.host }); kickSyncRound('peer-online') })
  state.node.on('peer-offline', p => emitSyncEvent('peer-offline', { deviceId: p.deviceId, deviceName: p.name, host: p.host }))
  state.node.on('pair-throttled', info => emitSyncEvent('pair-throttled', { ip: info && info.ip }))
  // Security-ring persistence: pair-throttled / auth-rejected entries survive restarts via
  // settings_rows (bounded to the node's 20-entry ring, write-throttled).
  state.node.on('security-entry', () => scheduleSecurityPersist())
  // Inbound two-way confirm request: hold it for the human (respond callback comes from the
  // transport, which owns the 60s auto-reject timer) and surface it to the renderer.
  state.node.on('pair-request', info => {
    state.pendingPair = { ...info, at: Date.now() }
    emitSyncEvent('pair-request', { deviceId: info && info.deviceId, deviceName: info && info.deviceName, host: info && info.host })
    notifyRenderers('pair-request')
    // OS-level notification: the user must notice a pairing request even with the settings
    // page (or the whole window) closed. Best-effort and capability-guarded.
    try {
      const { Notification } = require('electron')
      if (Notification.isSupported()) {
        const who = [info && info.deviceName, info && info.host].filter(Boolean).join(' · ')
        const i18nM = require('./i18n')
        const n = new Notification({
          title: i18nM.mt('pairNotifyTitle'),
          body: who ? i18nM.mt('pairNotifyBody', { who }) : i18nM.mt('pairNotifyBodyUnknown'),
          silent: false,
        })
        n.on('click', () => { try { notifyRenderers('pair-request-focus') } catch { /* noop */ } })
        n.show()
      }
    } catch (e) { log.warn('[LanSync] pair-request notification failed:', e.message) }
  })
  state.node.on('pair-accepted', info => emitSyncEvent('pair-accepted', { host: info && info.host, port: info && info.port }))
  state.node.on('pair-rejected', info => emitSyncEvent('pair-rejected', { host: info && info.host, port: info && info.port, reason: info && info.reason }))
  // Inbound pairing completed (manual code or confirmed): tell the renderer it succeeded AND
  // (round-1 P0) immediately register + persist the peer from the ACTUAL TCP remote address —
  // the inbound side always knows the peer's reachable address from its own socket.
  state.node.on('paired-inbound', info => {
    emitSyncEvent('pair-accepted', { deviceId: info && info.deviceId, host: info && info.host })
    try {
      if (!info || !info.deviceId || info.deviceId === state.deviceId) return
      const myPort = (state.node && state.node.getStatus().port) || DEFAULT_PORT
      persistPairedPeer({ deviceId: info.deviceId, name: info.deviceName, host: info.host, port: myPort })
      if (state.node) state.node.addPeer({ deviceId: info.deviceId, name: info.deviceName, host: normalizeHost(info.host) || undefined, port: myPort })
      kickSyncRound('paired-inbound')
    } catch (e) { log.warn('[LanSync] paired-inbound persist failed:', e.message) }
  })
  // Round-1 P0: an authenticated connection proves the peer's ACTUAL reachable address — refresh
  // the persisted record (and the live node entry) from socket remoteAddress, never from the
  // stale/cached discovery value. Change-gated inside persistPairedPeer (no write amplification).
  state.node.on('peer-connected', p => {
    try {
      if (!p || !p.deviceId || p.deviceId === state.deviceId) return
      const myPort = (state.node && state.node.getStatus().port) || DEFAULT_PORT
      if (persistPairedPeer({ deviceId: p.deviceId, host: p.host, port: myPort }) && state.node) {
        const h = normalizeHost(p.host)
        if (h) state.node.addPeer({ deviceId: p.deviceId, host: h, port: myPort })
      }
    } catch (e) { log.warn('[LanSync] peer-connected persist failed:', e.message) }
  })
  state.node.on('peer-unauthorized', info => {
    log.warn('[LanSync] unauthorized peer rejected (terminal until re-pair):', info && info.deviceId, 'from', info && info.host, info && info.error)
    // P1-3b: terminal state — the Device Center renders peers[].peerState === 'unpaired'
    // (status payload) as "已被对方解除配对,请重新配对". Emitted ONCE per rejection; the node
    // stops dialing that peer until user action.
    emitSyncEvent('peer-unauthorized', { deviceId: info && info.deviceId, host: info && info.host, terminal: true })
  })
  // restore manually added peers (node peer table is memory-only; settings_rows is the authority)
  for (const mp of manualPeers()) {
    try { state.node.addPeer({ deviceId: 'manual-' + mp.host + ':' + mp.port, host: mp.host, port: Number(mp.port) }) } catch (e) { log.warn('[LanSync] manual peer restore failed:', e.message) }
  }
  // Round-1 P0: restore PAIRED peers — without this the peer table was memory-only and
  // `sync status` reported peers:(none) after every restart even though pairing state survived.
  for (const p of Object.values(loadPairedPeers())) {
    try {
      if (!p || !p.deviceId || p.deviceId === deviceId || !p.host) continue
      state.node.addPeer({ deviceId: p.deviceId, name: p.name, host: p.host, port: Number(p.port) || DEFAULT_PORT })
    } catch (e) { log.warn('[LanSync] paired peer restore failed:', e.message) }
  }
  state.node.start()
  state.pendingToSeq = 0
  // Auto round: 10s after enable/boot, then every 5 minutes (only while enabled). unref'd:
  // the round timers must never keep the process alive past quit (item 2026-09-18 P2).
  const startTimer = setTimeout(() => { runRound() }, START_DELAY_MS); startTimer.unref?.()
  const roundTimer = setInterval(() => { runRound() }, ROUND_INTERVAL_MS); roundTimer.unref?.()
  state.timers.push(startTimer, roundTimer)
  log.info('[LanSync] node started for', deviceId)
}

async function stopSync () {
  if (!state.node) return
  for (const t of state.timers) { clearTimeout(t); clearInterval(t) }
  state.timers = []
  const n = state.node
  // P2 2026-09-20: the security-ring persist is write-throttled to <=1 write/sec — pending
  // throttled entries lived only in the node's memory ring and were LOST when the app quit
  // inside the throttle window (the unref'd timer never fires). Flush synchronously BEFORE the
  // node is torn down; quit/disable/unpair all funnel through here.
  try {
    if (securityPersistTimer) { clearTimeout(securityPersistTimer); securityPersistTimer = null }
    // Round-1 P0: guard getStatus — a stale/mocked node reference threw
    // `n.getStatus is not a function` and masked the flush with a warning.
    if (n && typeof n.getStatus === 'function') settingPut(K_SECURITY_LOG, JSON.stringify(n.getStatus().security.slice(-20)))
  } catch (e) { log.warn('[LanSync] security log flush on stop failed:', e.message) }
  state.node = null
  state.pendingPair = null
  // P1-4 (2026-09-19 data-safety round): the engine (and its hydration caches) used to be nulled
  // BEFORE the node stopped — an in-flight ingestSegment (round still running on a live socket)
  // hit `state.engine.ingestSegment of null` TypeError. Stop the node FIRST (its stop() awaits
  // the server close, which quiesces in-flight rounds), THEN tear down the engine.
  try { await n.stop() } catch (e) { log.warn('[LanSync] stop failed:', e.message) }
  state.engine = null
  state.applyCache = null
  log.info('[LanSync] node stopped')
}

/** Quit-chain hook (src/main/index.js before-quit): stop the node + round timers so they never
 *  outlive the DB handle. Fire-and-forget async — the watermark/security persists happen
 *  synchronously via db.call inside startSyncRound/stop ordering, before the server close await. */
function stopSyncForQuit () {
  try { if (state && state.node) stopSync().catch(() => {}) } catch { /* sync never initialized */ }
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

/* ---------- P0-1/P1-2/P1-5 (2026-09-19 UX review): post-round renderer refresh ----------
 * Inbound rows were applied to the DB silently: 'lan-sync-changed' had zero consumers and the
 * LAN apply path never broadcast the events the local-write path sends, so open views stayed
 * stale until restart. After every ingest that applied rows we:
 *   - re-baseline the external-write watcher (our own sync writes touch the WAL; without this
 *     the watcher fires a full 'external-db-write' reload on top of ours),
 *   - broadcast 'todos-changed' / 'tomato-records-changed' (the SAME channels the local-write
 *     path uses — the renderer's echo-suppression window dedupes the double reload),
 *   - for settings: fold applied rows into the db.settingsState blob (P1-2a: otherwise the
 *     renderer's next whole-blob mirror re-stamps stale fields over newer rows = the per-round
 *     "settings conflict … local copy superseded" churn) and hot-apply the patch to every live
 *     window via the existing 'external-settings-changed' channel,
 *   - emit AT MOST ONE 'sync-conflict' syncEvent per round (P1-5).
 * Echo loops: rows the local renderer itself just wrote arrive back as identical-content no-ops
 * (applyRowInner returns false -> nothing is marked applied -> no broadcast).
 */
const DATA_CHANNEL_KINDS = ['todo', 'category', 'plan', 'filter', 'meta'] // ride 'todos-changed' like local writes do
function sendToRenderers (channel, msg) {
  try {
    const senders = state.getWindowSenders ? state.getWindowSenders() : []
    for (const s of senders) { try { if (s && !s.isDestroyed()) s.send(channel, msg) } catch { /* dying sender */ } }
  } catch { /* renderer notification is best-effort */ }
}

/** P1-2a / F1 (2026-09-20): fold applied setting rows back into the blob they came from so
 *  blob-vs-rows converge (no re-stamp churn). The settings_rows key IS the source blob's field
 *  name (db-sync-schema's setMeta bridge mirrors each blob's top-level fields row-for-row), so
 *  the source blob is known statically: the habits blob (renderer store/habits.js persist shape)
 *  carries exactly schemaV/habits/moments/savedAt; every other key lives in the settings blob.
 *  Folding into the WRONG blob made applied habits fields (habits/moments/savedAt) vanish from
 *  db.habitsState — the receiving habits store reads only that blob and its next persist()
 *  re-mirrored the stale blob over the fresh rows with a fresh savedAt (stale clobber of the peer).
 *  Guards against re-stamping newer rows backwards: the fold goes through setMeta, whose bridge
 *  (db-sync-schema registerOps) runs mergeDoc -> putRow, which is a strict identical-content
 *  no-op (the rows already hold these exact values, so no updatedAt is re-stamped), and the blob
 *  meta keys themselves never sync (isSyncBlobMetaKey), so the fold cannot echo.
 *  Best-effort: a corrupt blob skips the fold (rows stay the sync truth).
 *  Round-2 P1 (2026-09-21): a MISSING blob no longer skips the fold — on a fresh-paired device
 *  the blob is absent, the hot-apply deliberately does not persist, and nothing else rebuilt the
 *  blob from rows: restart lost the whole habits view, and the next local persist wrote the
 *  renderer's stale/empty blob over the peer's fresh rows (data loss). When the blob is missing
 *  but applied rows exist, the blob is now MATERIALIZED from the rows (fold = create).
 *  Returns the parsed patches per blob for the renderer hot-apply broadcasts. */
const HABITS_BLOB_KEY = 'db.habitsState'
const HABITS_BLOB_FIELDS = new Set(['schemaV', 'habits', 'moments', 'savedAt'])
function foldIntoBlob (blobKey, entries) {
  if (!entries.length) return
  try {
    let doc = null
    try { doc = JSON.parse(state.db.call('getMeta', blobKey)) } catch { doc = null }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      // Round-2 P1: materialize instead of skip. The habits blob carries the renderer store's
      // persist shape (schemaV/habits/moments/savedAt); every other blob is the settings blob.
      if (blobKey === HABITS_BLOB_KEY) doc = { schemaV: 1, habits: [], moments: [], savedAt: 0 }
      else doc = {}
      log.info('[LanSync] materializing missing blob from applied rows:', blobKey)
    }
    for (const [k, v] of entries) {
      if (v === undefined) delete doc[k] // tombstone: drop the field from the blob
      else doc[k] = v
    }
    state.db.call('setMeta', [blobKey, JSON.stringify(doc)])
  } catch (e) { log.warn('[LanSync] settings blob fold failed:', blobKey, e.message) }
}

function foldSettingsIntoBlob (patch) {
  const settings = []
  const habits = []
  for (const k of Object.keys(patch || {})) {
    if (syncApply.isMachineLocalSettingKey(k)) continue
    ;(HABITS_BLOB_FIELDS.has(k) ? habits : settings).push([k, patch[k]])
  }
  foldIntoBlob(BLOB_SETTINGS_KEY, settings)
  foldIntoBlob(HABITS_BLOB_KEY, habits)
  const toPatch = list => { const p = {}; for (const [k, v] of list) if (v !== undefined) p[k] = v; return p }
  return { settingsPatch: toPatch(settings), habitsPatch: toPatch(habits) }
}

function emitAppliedRound () {
  const round = syncApply.consumeAppliedRound(state)
  if (!round) return
  // Sync writes are main-process writes: re-baseline the external-write watcher so its next poll
  // does not mistake them for CLI writes and fire a second (undo-stack-wiping) full reload.
  try { if (state.resyncExternalWatch) state.resyncExternalWatch() } catch { /* best-effort */ }
  const at = Date.now()
  if (round.kinds.some(k => DATA_CHANNEL_KINDS.includes(k))) {
    sendToRenderers('todos-changed', { reason: 'lan-sync-apply', op: round.kinds.join(','), at })
  }
  if (round.kinds.includes('tomato')) {
    sendToRenderers('tomato-records-changed', { reason: 'lan-sync-apply', at })
  }
  const settingKeys = Object.keys(round.settingsPatch || {})
  if (settingKeys.length) {
    // F1 (2026-09-20): fold each applied row into ITS source blob (settings vs habits) and
    // hot-apply each on its own channel. external-habits-changed mirrors external-settings-changed
    // 1:1 (S2 renderer wiring contract):
    //   channel: 'external-habits-changed'
    //   payload: flat object of APPLIED habits-blob fields -> parsed values, e.g.
    //            { habits: [...], moments: [...], savedAt: 1712345678901 }
    //            (keys omitted when the applied row was a tombstone = field deleted).
    //            Consumed like external-settings-changed: merge the fields into the habits store
    //            state; savedAt LWW in store/habits.js already dedupes stale applications.
    const { settingsPatch, habitsPatch } = foldSettingsIntoBlob(round.settingsPatch)
    // Settings hot-apply path reuses the CLI settings watcher's channel: the renderer dispatches
    // settings/update, which syncs LS/config.json/shortcuts and mirrors the blob back (now
    // value-identical to the rows, so the bridge stamps nothing — the churn loop stays dead).
    if (Object.keys(settingsPatch).length) sendToRenderers('external-settings-changed', settingsPatch)
    if (Object.keys(habitsPatch).length) sendToRenderers('external-habits-changed', habitsPatch)
  }
  // P1-5: one conflict toast per round, max.
  if (round.conflicts && round.conflicts.length) {
    const c = round.conflicts[0]
    emitSyncEvent('sync-conflict', { entity: c.entity, name: c.name, applied: c.applied, count: round.conflicts.length })
  }
}

/* ---------- P1-6 (2026-09-19 data-safety round): recovery vs persisted watermarks ---------- */
/**
 * Invalidate every persisted per-peer push watermark after a DB RECOVERY/restore rebuilt the
 * database in an OLDER oplog seq space: stale watermarks would sit above the restored rows and
 * they would never be pushed. Clearing the map makes the next round re-push the full retained
 * oplog window to every peer (merge-apply is idempotent, §4.1), and the peers' snapshot trigger
 * re-syncs anything already pruned from our rebuilt oplog. Safe to call before initLanSync
 * (no-op for the live map) — the settings row is the persistence authority.
 */
function invalidateSyncWatermarks (reason) {
  try {
    settingPut(K_PEER_WATERMARKS, JSON.stringify({}))
  } catch (e) { log.warn('[LanSync] watermark invalidation persist failed:', e.message) }
  try {
    if (state && state.peerWatermarks && typeof state.peerWatermarks.clear === 'function') state.peerWatermarks.clear()
  } catch (e) { log.warn('[LanSync] live watermark map clear failed:', e.message) } // round-2 P1: no silent swallow
  log.warn('[LanSync] peer watermarks invalidated (' + String(reason || 'recovery') + ') — full re-push + peer re-snapshot on next round')
  try { kickSyncRound('watermarks-invalidated') } catch { /* node not started yet */ }
}

/* ---------- P1-3 (2026-09-19 UX review): unpair a device ---------- */
/**
 * Remove a paired device: drop its manual peer record + push watermark and REVOKE the shared
 * pairing secret. Documented consequence (surfaced in the confirm dialog): pairing uses a single
 * shared secret, so rotating it disconnects EVERY previously paired device — the unpaired peer's
 * authenticated hello now fails (peer-unauthorized = syncing with it is paused) and both sides
 * must re-pair to resume.
 */
async function syncUnpairPeerOp (p) {
  const deviceId = String((p && p.deviceId) || '').trim()
  if (!deviceId) throw new Error('syncUnpairPeer: deviceId is required')
  if (!state.node) throw new Error('syncUnpairPeer: sync is not enabled')
  // Resolve host/port from the live status so the manual-peer record (keyed by host:port) can go.
  let host = null
  let port = null
  try {
    const peer = (state.node.getStatus().peers || []).find(x => x && x.deviceId === deviceId)
    if (peer) { host = peer.host; port = peer.port }
  } catch { /* status read is best-effort; the rest still applies */ }
  if (host) {
    const rest = manualPeers().filter(x => !(x.host === host && Number(x.port) === Number(port)))
    settingPut(K_MANUAL_PEERS, JSON.stringify(rest))
    try { state.node.removePeer(String('manual-' + host + ':' + port)) } catch { /* older nodes: entry dies with the next restart */ }
  }
  // Round-1 P0: drop the persisted paired-peer record too (it keyed the stale address the manual
  // record mirrored); re-pairing then starts from a clean table instead of merging into it.
  removePairedPeer(deviceId)
  // Drop the per-peer push watermark (a stale watermark must not survive a revoked pairing).
  try {
    const wm = loadPeerWatermarks()
    if (wm[deviceId] != null) {
      delete wm[deviceId]
      settingPut(K_PEER_WATERMARKS, JSON.stringify(wm))
      if (state.peerWatermarks && typeof state.peerWatermarks.delete === 'function') state.peerWatermarks.delete(deviceId)
    }
  } catch (e) { log.warn('[LanSync] watermark drop failed:', e.message) }
  // Revoke the shared secret: the removed peer (and any other existing peer) can no longer
  // authenticate until re-paired. Restart so the node advertises/authenticates with the new one.
  settingPut(K_PAIRING_SECRET, generatePairingSecret())
  state.pairingCode = null
  // P1-4 (2026-09-19 data-safety round): best-effort tell the unpaired peer while a connection
  // may still be live — it can then forget OUR peer record and enter its terminal unpaired
  // state instead of auth-retrying forever. Never blocks the unpair flow. Round-1 P0: guard the
  // method existence (a stale/older node reference threw `notifyUnpaired is not a function`).
  if (state.node && typeof state.node.notifyUnpaired === 'function') {
    try { const notified = state.node.notifyUnpaired(deviceId); log.info('[LanSync] unpaired notify to', deviceId, notified ? 'delivered' : 'no live connection (peer will discover via auth rejection)') } catch (e) { log.warn('[LanSync] unpaired notify failed:', e.message) }
  }
  await stopSync()
  if (settingGet(K_ENABLED) === true) startSync()
  notifyRenderers('peer-unpaired')
  emitSyncEvent('peer-unpaired', { deviceId, host })
  log.info('[LanSync] unpaired', deviceId, '- shared secret revoked (all peers must re-pair)')
  return { ...getSettingsPayload(), unpaired: deviceId }
}

/* ---------- IPC op handlers (registered into db.OPS via db-sync-ops) ---------- */
/**
 * Enable/disable the node. ASYNC, and the stop MUST be awaited before a start (round-3 review):
 * syncSetEnabled(off) without awaiting left the old TCP server still bound while startSync()
 * immediately re-listened on the fixed port -> EADDRINUSE -> (pre-fix) silent ephemeral fallback
 * -> an undiscoverable node. The op is IPC-dispatched, so returning a promise is fine.
 */
async function syncSetEnabledOp (p) {
  const enabled = !!(p && p.enabled)
  const wasEnabled = settingGet(K_ENABLED) === true
  if (enabled === wasEnabled && state.node === null && enabled === false) return getSettingsPayload()
  settingPut(K_ENABLED, enabled)
  if (enabled) {
    if (!settingGet(K_PAIRING_SECRET)) settingPut(K_PAIRING_SECRET, generatePairingSecret())
    if (state.node) await stopSync() // rapid off->on: release the old server/port BEFORE rebinding
    startSync()
  } else {
    await stopSync()
  }
  notifyRenderers('enabled-changed')
  return getSettingsPayload()
}

function getSettingsPayload () {
  const { deviceId, deviceName } = ensureIdentity()
  return {
    enabled: settingGet(K_ENABLED) === true,
    deviceId,
    deviceName,
    hasPairingSecret: !!settingGet(K_PAIRING_SECRET)
  }
}

/** Pending inbound pair request surfaced to the renderer (contract: renderer reads
 *  status.pendingPair on mount and shows the confirm dialog; syncPairRespond answers it). */
function pendingPairPayload () {
  const p = state.pendingPair
  if (!p || typeof p.respond !== 'function') return null
  return { deviceId: p.deviceId || null, deviceName: p.deviceName || null, host: p.host || null, at: p.at || Date.now() }
}

function getStatusPayload () {
  const s = getSettingsPayload()
  const pendingPair = pendingPairPayload()
  if (!state.node) {
    return {
      ...s, listening: false, port: null, peers: [], recent: [], security: [],
      lastRoundAt: null, lastError: null, pendingPair,
      self: { deviceId: s.deviceId, deviceName: s.deviceName, port: null },
    }
  }
  const st = state.node.getStatus()
  return {
    ...s, listening: st.listening, port: st.port,
    // Round-2 P1: attach the machine-local display alias (sync.peerAlias.<deviceId>) per peer —
    // the alias is set from this device's Device Center only and never syncs ('sync.' namespace
    // is machine-local), and it wins over the advertised device name in the renderer.
    peers: (st.peers || []).map(p => ({ ...p, deviceName: p.deviceName || p.name, alias: peerAliasOf(p && p.deviceId) })),
    recent: st.recent, security: st.security,
    lastRoundAt: st.lastRoundAt, lastError: st.lastError, pendingPair,
    self: st.self || { deviceId: s.deviceId, deviceName: s.deviceName, port: st.port },
  }
}

/* ---------- per-peer machine-local display alias (round-2 P1) ---------- */
const K_PEER_ALIAS_PREFIX = 'sync.peerAlias.'
function peerAliasOf (deviceId) {
  if (!deviceId) return null
  const v = settingGet(K_PEER_ALIAS_PREFIX + String(deviceId))
  const s = typeof v === 'string' ? v.trim().slice(0, 40) : ''
  return s || null
}

/* ---------- Round-2 P1 (F7, 2026-09-21): missing-attachment key collection ----------
 * Only LIVE todos may re-pull files: getAll({deleted:null}) returned ALL rows including
 * recycle-bin tombstones, so a deleted todo's files were re-requested from the peer every
 * round forever (orphans GC on hard purge). Injectable existsFn/attachDir for tests. */
function missingAttachmentKeys (st, inject = {}) {
  try {
    const fs = require('node:fs')
    const path = require('node:path')
    const { collectMissingKeys } = require('./lan-sync/att-transfer')
    const dir = inject.attachDir || require('./attachments').attachDir()
    const exists = inject.existsSync || (key => fs.existsSync(path.join(dir, path.basename(String(key)))))
    return collectMissingKeys(st.db.call('getAll', { deleted: 0 }), exists)
  } catch { return [] }
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
    syncSetEnabled: syncSetEnabledOp,
    syncPairWithCode: async p => {
      const code = String((p && p.code) || '').trim()
      if (!/^\d{6}$/.test(code)) throw new Error('syncPairWithCode: 6-digit code required')
      if (!state.node) throw new Error('syncPairWithCode: sync is not enabled')
      const r = await state.node.pairWith(p && p.deviceId || undefined, code)
      settingPut(K_PAIRING_SECRET, String(r.secret))
      // Round-1 P0: persist the paired peer from the address the pair ACTUALLY succeeded on (the
      // dialed host:port), so the record survives restart and re-pairing overwrites any stale one.
      if (r.peer && r.peer.deviceId) {
        persistPairedPeer({ deviceId: r.peer.deviceId, name: r.peer.name, host: r.peer.host, port: r.peer.port })
      }
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
    // P1-3: unpair a device (Device Center peer card). Deletes the peer record + push watermark
    // and revokes the shared pairing secret — every previously paired device must re-pair.
    syncUnpairPeer: p => syncUnpairPeerOp(p),
    // Round-2 P1: machine-local per-peer display alias for Device Center (sync.peerAlias.<id>).
    syncSetPeerAlias: p => {
      const deviceId = String((p && p.deviceId) || '').trim()
      if (!deviceId) throw new Error('syncSetPeerAlias: deviceId is required')
      const alias = String((p && p.alias) || '').trim().slice(0, 40)
      const key = K_PEER_ALIAS_PREFIX + deviceId
      if (alias) settingPut(key, alias)
      else state.db.call('settingsRowDelete', { key }) // empty string clears the alias
      return { deviceId, alias: alias || null }
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
    },
    // X4 (2026-09-20): meta conflict backup list/restore for the renderer (impl in
    // sync-conflict-backups.js — this file is at its size ratchet). Machine-local keys only.
    ...require('./sync-conflict-backups').ops(() => (op, p) => state.db.call(op, p))
  })
}

/** Called once from src/main/index.js after db init. Never auto-enables sync.
 *  opts.resyncExternalWatch (P0-1): re-baseline hook for the external-write watcher — sync's own
 *  main-process writes touch the WAL and must not surface as "external CLI writes". */
function initLanSync ({ db, getWindowSenders, resyncExternalWatch } = {}) {
  const peerWatermarks = createTrackedWatermarks()
  state = { db, getWindowSenders, node: null, engine: null, timers: [], pendingToSeq: 0, peerWatermarks, localUserId: null, pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] }, pendingPair: null, applied: null, resyncExternalWatch: typeof resyncExternalWatch === 'function' ? resyncExternalWatch : null }
  registerOps()
  // Running-tomato announcements (feature): wire the announce module to the db + identity,
  // and relay remotely-applied announces to the renderer as 'tomato-announce' syncEvents.
  // The announce key itself travels as a regular meta entity row (see sync-apply.js).
  try {
    const tomatoAnnounce = require('./tomato-announce')
    tomatoAnnounce.init({
      dbCall: (op, p) => state.db.call(op, p),
      getIdentity: () => { const s = getSettingsPayload(); return { deviceId: s.deviceId, deviceName: s.deviceName } },
      kickRound: kickSyncRound,
    })
    tomatoAnnounce.onRemoteAnnounce(v => emitSyncEvent('tomato-announce', v))
  } catch (e) { log.warn('[LanSync] tomato-announce wiring failed:', e.message) }
  // v1 watermark cleanup (round-3 review): the pre-v2 'sync.peerWatermarks' row is dead data in
  // the RECEIVER's seq space (v2 lives under 'sync.peerWatermarks.v2'); delete it once.
  try {
    if (settingGet('sync.peerWatermarks') != null) state.db.call('settingsRowDelete', { key: 'sync.peerWatermarks' })
  } catch (e) { log.warn('[LanSync] v1 watermark cleanup failed:', e.message) }
  try {
    if (settingGet(K_ENABLED) === true) startSync()
  } catch (e) { log.warn('[LanSync] startup enable failed:', e.message) }
}

module.exports = { initLanSync, stopSyncForQuit, kickSyncRound, invalidateSyncWatermarks }

// Test-only hooks: applyRowInner/flushPendingWrites operate on the module-level `state` singleton;
// unit tests swap in a mock state via __test.setState. Production paths never touch __test.
module.exports.__test = {
  setState: s => { state = s },
  applyRow: row => applyRowSafe(row),
  allRows: () => createLocalStoreAdapter().allRows(),
  flushPendingWrites,
  syncSetEnabled: syncSetEnabledOp,
  localUserId,
  // watermark persistence surface (2026-09-19 regression tests): the live map <-> settings_rows
  // round-trip is the restart-survival contract for per-peer push watermarks.
  persistPeerWatermarks,
  createTrackedWatermarks,
  loadPeerWatermarks,
  // P0-1/P1-2/P1-5 test surface: post-round applied bookkeeping -> renderer broadcasts.
  emitAppliedRound: () => emitAppliedRound(),
  // P1-3 test surface: unpair deletes peer record + watermark + revokes the shared secret.
  unpairPeer: p => syncUnpairPeerOp(p),
  // Round-1 P0 test surface: paired-peer table persistence + address hygiene.
  persistPairedPeer,
  removePairedPeer,
  loadPairedPeers,
  normalizeHost,
  // P1-4/P1-6 test surface: stop ordering (engine alive until the node stopped) + watermark
  // invalidation (recovery path clears persisted per-peer progress).
  stopSync,
  invalidateSyncWatermarks,
  // Round-2 P1 test surface: peer alias op registration + live-todo attachment key collection.
  registerOps,
  missingAttachmentKeys,
}
