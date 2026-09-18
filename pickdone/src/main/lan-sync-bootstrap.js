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
const K_PEER_WATERMARKS = 'sync.peerWatermarks.v2' // {deviceId: highestSeqThatPeerAcked} — per-peer push progress (survives restarts)
const K_SECURITY_LOG = 'sync.securityLog' // last 20 security-ring entries (pair-throttled / auth-rejected), JSON — survives restarts
const SECURITY_PERSIST_MIN_MS = 1000 // write-throttle: at most one security-log write per second
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
/* The apply/hydration/flush pipeline lives in ./sync-apply.js (line ratchet, round-3 review);
 * the delegates below bind the bootstrap's module-level `state` singleton to it. */
const syncApply = require('./sync-apply')
const { isMachineLocalSettingKey } = syncApply
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
        // 'sync.' = identity namespace; 'securityLock*' = password/question ciphertext — both
        // must never leave this device (round-3 review: the settingsState bridge mirrors
        // securityLock rows into settings_rows).
        if (isMachineLocalSettingKey(r.key)) continue
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
const KICK_DEBOUNCE_MS = 2500
const KICK_FLOOR_MS = 10000
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
  state.deviceId = deviceId // symmetric tie-break stamping (see withPeerDeviceId / sync-apply)
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
        for (const r of withPeerDeviceId(body).rows || []) applyRowSafe(r)
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
        for (const r of withPeerDeviceId(body).rows || []) applyRowSafe(r)
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
  state.node.on('peer-online', p => emitSyncEvent('peer-online', { deviceId: p.deviceId, deviceName: p.name, host: p.host }))
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
  // Inbound pairing completed (manual code or confirmed): tell the renderer it succeeded.
  state.node.on('paired-inbound', info => emitSyncEvent('pair-accepted', { deviceId: info && info.deviceId, host: info && info.host }))
  state.node.on('peer-unauthorized', info => log.warn('[LanSync] unauthorized peer rejected:', info && info.deviceId, 'from', info && info.host, info && info.error))
  // restore manually added peers (node peer table is memory-only; settings_rows is the authority)
  for (const mp of manualPeers()) {
    try { state.node.addPeer({ deviceId: 'manual-' + mp.host + ':' + mp.port, host: mp.host, port: Number(mp.port) }) } catch (e) { log.warn('[LanSync] manual peer restore failed:', e.message) }
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
  if (securityPersistTimer) { clearTimeout(securityPersistTimer); securityPersistTimer = null }
  const n = state.node
  state.node = null
  state.engine = null
  state.pendingPair = null
  try { await n.stop() } catch (e) { log.warn('[LanSync] stop failed:', e.message) }
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
    peers: st.peers, recent: st.recent, security: st.security,
    lastRoundAt: st.lastRoundAt, lastError: st.lastError, pendingPair,
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
    syncSetEnabled: syncSetEnabledOp,
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
  state = { db, getWindowSenders, node: null, engine: null, timers: [], pendingToSeq: 0, peerWatermarks, localUserId: null, pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] }, pendingPair: null }
  registerOps()
  // v1 watermark cleanup (round-3 review): the pre-v2 'sync.peerWatermarks' row is dead data in
  // the RECEIVER's seq space (v2 lives under 'sync.peerWatermarks.v2'); delete it once.
  try {
    if (settingGet('sync.peerWatermarks') != null) state.db.call('settingsRowDelete', { key: 'sync.peerWatermarks' })
  } catch (e) { log.warn('[LanSync] v1 watermark cleanup failed:', e.message) }
  try {
    if (settingGet(K_ENABLED) === true) startSync()
  } catch (e) { log.warn('[LanSync] startup enable failed:', e.message) }
}

module.exports = { initLanSync, stopSyncForQuit, kickSyncRound }

// Test-only hooks: applyRowInner/flushPendingWrites operate on the module-level `state` singleton;
// unit tests swap in a mock state via __test.setState. Production paths never touch __test.
module.exports.__test = {
  setState: s => { state = s },
  applyRow: row => applyRowSafe(row),
  flushPendingWrites,
  syncSetEnabled: syncSetEnabledOp,
  localUserId,
}
