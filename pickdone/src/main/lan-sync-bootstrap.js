/* P3a LAN sync bootstrap (2026-09-16, docs/sync/同步整体方案-2026-09-15.md §9).
 * Extracted from index.js for the size ratchet: index.js keeps one thin require+call after db init. * * Responsibilities: *   - Device identity: deviceId (UUID, persisted in settings_rows 'sync.deviceId' on first run),
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
 * Known P3a scope cuts (documented, not silent) — STATUS UPDATE 2026-09-25, two of the three
 * original cuts have since been CLOSED (M3 + B16, see sync-apply.js):
 *   - CLOSED (M3 2026-09-20): category/plan/filter tombstones ARE hydrated now — allRows() pushes
 *     them (planTombstones/filterTombstones/categoriesAllRows below) and sync-apply.js applies
 *     tombstone winners per entity; deletions propagate as real delete-wins rows, not skipped
 *     pointers.
 *   - CLOSED (B16 2026-09-24): conflictCopy is materialized for todos (recycle-bin row) AND for
 *     plan/filter/category/setting/meta (machine-local metaConflictBackup.<entity>:<id> backups,
 *     restorable via syncConflictBackupsList/Restore — see sync-conflict-backups.js).
 *   - Still open: applySnapshot/replaceAll is implemented as merge-apply (non-destructive) because
 *     the round protocol never sends snapshot-request in P3a; a true destructive reset is deferred.
 */
const { randomUUID, timingSafeEqual } = require('node:crypto')
const os = require('node:os')
const log = require('electron-log')
require('./log-isolation') // test isolation: redirect electron-log file transport into TODO_DB_DIR/TODO_USER_DATA_DIR
const { createEngine } = require('../../shared/sync-core/engine.mjs')
const { SYNC_SCHEMA_VERSION } = require('../../shared/sync-core/merge.mjs')
// B3 (daily 2026-09-24): the habits-blob field set is the SHARED family contract
// (shared/settings-families.mjs — the same module cli/lib.js stripHabitsFamily and the
// renderer whitelist consume). The hand-copied literal here could drift from the shared
// set and route an applied row into the WRONG blob on fold.
const { HABITS_BLOB_FIELDS } = require('../../shared/settings-families.mjs')
const { generatePairingSecret } = require('../../shared/sync-core/pairing.mjs') // derivePairingCode moved with syncGetPairingCode to lan-sync/pair-ops.js
const { createLanSyncNode } = require('./lan-sync/index')
const { DEFAULT_PORT } = require('./lan-sync/transport')
const { isDialableHost } = require('./lan-sync/discovery') // isPlausibleHost dropped with the retired syncAddPeer chain (2026-09-23)
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
function settingPut (key, value) { return busWrite('settingsRowPut', { key, value }) }

/* ---------- identity ---------- */
function ensureIdentity () {
  let deviceId = settingGet(K_DEVICE_ID)
  if (!deviceId || typeof deviceId !== 'string') {
    deviceId = randomUUID()
    settingPut(K_DEVICE_ID, deviceId)
    log.info('[LanSync] device identity created:', deviceId)
  }
  // Provenance stamp (protocol v3): from here on, local todo writes are authored. The db side
  // loads the persisted identity at init too — this covers first-boot creation.
  try { require('./db-rows').setSyncAuthor(deviceId) } catch { /* stamping is best-effort */ }
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
const { SYNC_OPLOG_KEEP, oplogKeepLimit } = require('./db-oplog') // D3 2026-09-24: oplog page size derives from the ring retention (was bare 10000s)
const createHydrationCache = () => syncApply.createHydrationCache(state)
const localUserId = () => syncApply.localUserId(state)
const applyRowSafe = row => syncApply.applyRowSafe(state, row)
// Arch review 2026-09-22 rec #1 (twin-door convergence): manifest-op writes route through the
// same injected-ingress bus as sync-apply.js (hookless, payload-verbatim, preserveStamp) —
// only reads and the non-manifest sync-engine bookkeeping ops (appendOplogPointers /
// seedSyncOplog) stay on the raw db.call surface.
const busWrite = (op, payload) => syncApply.busWrite(state, op, payload)
const flushPendingWrites = () => syncApply.flushPendingWrites(state)
const readMaxOplogSeq = () => syncApply.readMaxOplogSeq(state)


// Egress/ingress surface extracted to ./lan-sync-egress.js (structure-size ratchet). The
// factory closes over THIS module's state singleton via getState (state is assigned in
// initLanSync, after this require line runs — the accessor defers to call time).
const { createLocalStoreAdapter, withPeerDeviceId, ingestSnapshotAssembled, ingestSnapshotChunked, buildSegmentsWrapped } = require('./lan-sync-egress').createEgressSurface({
  getState: () => state, log, emitSyncEvent, syncApply, busWrite, flushPendingWrites, finalizeIngest,
  oplogKeepLimit, SYNC_OPLOG_KEEP, CURSOR_META_KEY, SYNC_SCHEMA_VERSION
})

/* ---------- engine + node lifecycle (lazy; only while enabled) ---------- */
/**
 * Symmetric LWW tie-breaks (merge.mjs compareRecency): inbound rows are stamped with the
 * SENDING device's id (the segment envelope's deviceId) so a full tie resolves to the same
 * winner on both peers. Without this the local side has no deviceId at all and tie outcomes
 * depended on which side happened to be applying (loop fix 2026-09-18).
 */

/* ---------- S3/S6 (2026-10-03): per-peer watermark store — ONE owner for
 * 'sync.peerWatermarks.v2' (lan-sync/watermark-store.js) built on the shared read-throw/
 * abort-write settings-map-store helper. loadPeerWatermarks now THROWS on an unreadable row
 * (D15 C1 contract, previously silently {} for this key) and persistPeerWatermarks skips while
 * degraded (never writes a map derived from a failed read over the durable row). */
const createJsonSettingStore = require('./lan-sync/settings-map-store')
const createPeerWatermarkStore = require('./lan-sync/watermark-store')
const watermarkSettingStore = createJsonSettingStore({ settingGet, settingPut, log, key: K_PEER_WATERMARKS, name: 'peer watermarks', defaultValue: '{}' })
const watermarkStore = createPeerWatermarkStore({ settingGet, settingPut, log, key: K_PEER_WATERMARKS, store: watermarkSettingStore })

/** Load persisted per-peer push watermarks (throws on a settings read failure — S6). */
function loadPeerWatermarks () { return watermarkStore.load().map }

function persistPeerWatermarks () { return watermarkStore.persist(state && state.peerWatermarks) }

/* ---------- security ring persistence (survives restarts; recent ring stays ephemeral) ---------- */
// S6 (2026-10-03): the security ring is the second member of the settings-backed whole-store
// class — the same read-throw/abort-write contract that D15 C1 gave sync.peers and S3 gave the
// watermark store: a failed read latches degraded and BOTH writers (the throttled tick and the
// stopSync flush) then skip, so a corrupt read can never shrink/erase the durable 20-entry ring.
const securitySettingStore = createJsonSettingStore({ settingGet, settingPut, log, key: K_SECURITY_LOG, name: 'security log', defaultValue: '[]', validate: v => Array.isArray(v) })
function loadSecurityLog () {
  try {
    const v = securitySettingStore.load()
    return Array.isArray(v) ? v.slice(-20) : []
  } catch (e) {
    log.warn('[LanSync] security log seeded empty — persistence stays degraded until a successful read:', e.message)
    return []
  }
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
      // S6: abort the whole-array write while degraded — never derive a write from a failed read.
      if (!securitySettingStore.canPersist()) return
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

// (2026-09-23) persistManualPeer removed with the syncAddPeer IPC chain it only served; the
// K_MANUAL_PEERS restore loop stays as a legacy drain for data written before manual entry was retired.

/* ---------- Round-1 P0 (2026-09-21): paired-peer persistence + address hygiene.
 * Extracted to lan-sync/paired-peers.js (structure size ratchet) — settings access is
 * injected, so the swappable module-level `state` (__test.setState) still applies. */
const { normalizeHost, loadPairedPeers, persistPairedPeer, removePairedPeer } =
  require('./lan-sync/paired-peers')({
    settingGet, settingPut, log, isDialableHost, DEFAULT_PORT, K_PAIRED_PEERS,
    // S3: a successful persist of a peer record (both pairing ops + paired-inbound funnel
    // here) is the only event that clears that id's watermark revocation.
    onPeerPersisted: (id) => {
      const wm = state && state.peerWatermarks
      if (wm && typeof wm.reinstate === 'function') wm.reinstate(id)
    },
  })

/** Map wrapper exposing .raw() for persistence; seeded from settings_rows via the watermark
 *  store (S3/S6: read-throw on a failed read, revocation filtering on every writer). */
function createTrackedWatermarks () { return watermarkStore.createTracked() }

/** S3/S6 test surface: the same store wiring over an INJECTED db handle, so regression tests
 *  can drive corrupt-read/degraded-persist scenarios against a fresh settings table without
 *  swapping the module-level state singleton. */
function makeWatermarkStoresForDb (db) {
  const get = key => { const row = db.call('settingsRowsAll', {}).find(r => r.key === key && !r.deleted); return row ? row.value : null }
  const put = (key, value) => db.call('settingsRowPut', { key, value })
  const store = createJsonSettingStore({ settingGet: get, settingPut: put, log, key: K_PEER_WATERMARKS, name: 'peer watermarks', defaultValue: '{}' })
  return { store, wm: createPeerWatermarkStore({ settingGet: get, settingPut: put, log, key: K_PEER_WATERMARKS, store }) }
}

async function startSync () {
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
    // Test-only bind override: unit tests pin {port, host} (state.syncBindOverride) to drive
    // the EADDRINUSE fail-closed path hermetically (Windows only refuses a double bind when
    // both sockets use the same specific host, so tests must pin both). Production leaves it
    // unset and the node binds transport.DEFAULT_PORT on all interfaces.
    ...(state && state.syncBindOverride) || {},
    name: settingGet(K_DEVICE_NAME) || deviceName,
    pairingSecret: settingGet(K_PAIRING_SECRET),
    // F1 (2026-09-28 drill): per-pair secret lookup for server-side hello auth — prefer the
    // peer's own secret from the paired-peer table; null falls back to the global secret.
    // S1 (2026-10-03) read-failure taxonomy: loadPairedPeers THROWS on a settings read failure
    // (paired-peers.js D15 C1 contract: a read throw is not the same as never paired) and that
    // throw now propagates. The old catch{ return null } collapsed read-failure into
    // record-absent, so both sides fell back to the global secret, the verify mismatched the
    // per-pair auth code, and a transient read failure landed the peer in the TERMINAL unpaired
    // state. Consumers branch on the class: transport answers hello-ack 'secret-unavailable'
    // (no unauthorized classification, no per-IP failure count) and client-round aborts the
    // round as a retryable failure. secretFor is consumed at exactly two sites (transport.js
    // hello verify + client-round dial auth), both fed this same resolver.
    secretFor: (id) => {
      const rec = loadPairedPeers()[String(id)]
      return (rec && rec.secret) ? String(rec.secret) : null
    },
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
        return finalizeIngest(r)
      } finally { state.applyCache = null }
    },
    // d12 (2026-10-02): receivers extracted to module level (ingestSnapshotAssembled /
    // ingestSnapshotChunked) so the schemaVersion gate is unit-testable via __test; see the
    // function comments there for the crash/watermark semantics.
    ingestSnapshot: ingestSnapshotAssembled,
    // Streaming snapshot receiver: the node calls this PER received snapshot-chunk, so the
    // full snapshot never materializes in memory and pendingWrites flush per chunk (bounded
    // buffers). Crash semantics unchanged: the pull watermark still advances only at
    // snapshot-end, and chunk-merge-apply is idempotent.
    ingestSnapshotChunk: ingestSnapshotChunked,
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
  // Node event wiring lives in lan-sync/node-events.js (2026-09-27 size ratchet) — same
  // injected-deps pattern as paired-peers/peer-extras; getState keeps __test.setState effective.
  const nodeEvents = require('./lan-sync/node-events')({
    getState: () => state, emitSyncEvent, notifyRenderers, kickSyncRound, scheduleSecurityPersist,
    persistPairedPeer, normalizeHost, loadPairedPeers, manualPeers, DEFAULT_PORT, log,
  })
  nodeEvents.wireNodeEvents()
  // Inbound two-way confirm request: hold it for the human (respond callback comes from the
  // transport, which owns the 60s auto-reject timer) and surface it to the renderer.
  state.node.on('pair-request', info => {
    // A7: wrap respond so ANY resolution — renderer accept/reject via syncPairRespond, or the
    // transport's 60s auto-reject firing this closure directly — also clears state.pendingPair.
    // Without this, an already-dead request could be re-surfaced to the renderer with a fresh
    // countdown even though its window had long elapsed.
    const record = {
      ...info,
      at: Date.now(),
      respond: (...args) => {
        if (state.pendingPair === record) state.pendingPair = null
        return info.respond(...args)
      }
    }
    state.pendingPair = record
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
          ...require('./scheduler').notifyTimeoutOptsForApp() // B4: honor notificationTimeoutInterval on the pairing notification too
        })
        n.on('click', () => { try { notifyRenderers('pair-request-focus') } catch { /* noop */ } })
        n.show()
      }
    } catch (e) { log.warn('[LanSync] pair-request notification failed:', e.message) }
  })
  nodeEvents.restorePeers(deviceId)
  state.node.start()
  // Audit D2-c/D3: the old flow returned right after node.start(), so an EADDRINUSE on the
  // fixed sync port left the toggle reporting ON while the server was dead (rounds ran as
  // 'confirmed 0/0' no-ops). Fail closed: enable only succeeds once the TCP server has
  // actually bound the port; on bind error (or a 5s listen timeout) tear the node back down
  // and rethrow so syncSetEnabledOp propagates the failure to the renderer's toggle.
  try {
    await new Promise((resolve, reject) => {
      const onListen = p => { cleanup(); resolve(p) }
      const onServerError = err => { cleanup(); reject(new Error(`sync server failed to bind: ${err && err.message}`)) }
      const timer = setTimeout(() => { cleanup(); reject(new Error('sync server did not reach listening within 5s')) }, 5000)
      timer.unref?.()
      const cleanup = () => {
        clearTimeout(timer)
        try { state.node.off('listening', onListen) } catch { /* node torn down */ }
        try { state.node.off('server-error', onServerError) } catch { /* node torn down */ }
      }
      state.node.once('listening', onListen)
      state.node.once('server-error', onServerError)
    })
  } catch (e) {
    log.error('[LanSync] start failed — sync stays OFF:', e.message)
    await stopSync()
    throw e
  }
  state.pendingToSeq = 0
  // Auto round: 10s after enable/boot, then every 5 minutes (only while enabled). unref'd:
  // the round timers must never keep the process alive past quit (item 2026-09-18 P2).
  const startTimer = setTimeout(() => { runRound() }, START_DELAY_MS); startTimer.unref?.()
  const roundTimer = setInterval(() => { runRound() }, ROUND_INTERVAL_MS); roundTimer.unref?.()
  state.timers.push(startTimer, roundTimer)
  log.info('[LanSync] node started for', deviceId)
}

/**
 * S5 (2026-10-03): ONE restart path owning the fail-closed 'sync enabled ⇒ node listening'
 * contract (the same invariant syncSetEnabledOp enforces via the startSync throw). The four
 * pairing/rename restart sites in pair-ops previously used fire-and-forget startSync().catch(log)
 * — a bind failure after a pairing/rename/unpair left K_ENABLED=true with state.node=null
 * (the enabled-without-listening dead-toggle state the D2-c contract exists to prevent), and
 * the failure was swallowed into log.error. Any future restart site routed through this helper
 * inherits the invariant.
 *
 * preserveEnabled=false means the caller already knows sync is disabled (no restart at all);
 * preserveEnabled=true awaits the start and, on failure, applies the same fail-closed rollback
 * syncSetEnabledOp uses (K_ENABLED=false + renderer notify) and RETHROWS so the IPC op rejects
 * like syncSetEnabledOp does.
 */
async function restartSync ({ preserveEnabled = true } = {}) {
  await stopSync()
  if (!preserveEnabled) return
  try {
    await startSync()
  } catch (e) {
    log.error('[LanSync] restart failed — sync stays OFF:', e.message)
    try { settingPut(K_ENABLED, false); notifyRenderers('enabled-changed') } catch { /* rollback is best-effort; the rethrow still surfaces */ }
    throw e
  }
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
    // S6: the flush also aborts while degraded — a corrupt read must never shrink the ring.
    if (n && typeof n.getStatus === 'function' && securitySettingStore.canPersist()) settingPut(K_SECURITY_LOG, JSON.stringify(n.getStatus().security.slice(-20)))
  } catch (e) { log.warn('[LanSync] security log flush on stop failed:', e.message) }
  state.node = null
  state.pendingPair = null
  // P1-4 (2026-09-19 data-safety round): the engine (and its hydration caches) used to be nulled
  // BEFORE the node stopped — an in-flight ingestSegment (round still running on a live socket)
  // hit `state.engine.ingestSegment of null` TypeError. Stop the node FIRST (its stop() awaits
  // the server close, which quiesces in-flight rounds), THEN tear down the engine.
  try { await n.stop() } catch (e) { log.warn('[LanSync] stop failed:', e.message) }
  // Round-3 stability (2026-09-26): the in-flight quit round's peer acks landed in
  // state.peerWatermarks AFTER the last runRound persist — flushing only the security ring let
  // quit-time watermark confirmations die with the process. Persist here while the handle is open.
  try { persistPeerWatermarks() } catch (e) { log.warn('[LanSync] watermark flush on stop failed:', e.message) }
  state.engine = null
  state.applyCache = null
  log.info('[LanSync] node stopped')
}

/** Quit-chain hook (src/main/index.js will-quit flushNow): stop the node + round timers so they never
 *  outlive the DB handle. Returns the stop promise so the quit chain can AWAIT it before dbm.close() — the settle-point persists above must beat the close. */
function stopSyncForQuit () {
  try { if (state && state.node) return stopSync().catch(() => {}) } catch { /* sync never initialized */ }
}

/* R7-B P2: the quit-time idle announce used to be written then killed by stopSyncForQuit
 * before the debounced kick ever fired — peers saw a "running" tomato ghost until TTL.
 * Ship the announce with an IMMEDIATE round (debounce cleared), best-effort within the
 * will-quit flush window (500ms floor / 2s cap); the peers' TTL rule still covers a crash. */
function shipQuitRound () {
  try {
    if (!state || !state.node) return false
    clearTimeout(kickTimer)
    kickTimer = null
    lastKickRoundAt = Date.now()
    runRound()
    return true
  } catch { return false }
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
 * working). Types:
 * peer-online, peer-offline, peer-unauthorized, peer-unpaired, pair-request, pair-accepted,
 * pair-rejected, pair-throttled, snapshot-sync, round-done, round-error, server-error,
 * sync-conflict, flush-quarantined, tomato-announce, attachments-arrived,
 * egress-hydration-failed, oplog-append-failed.
 * (r4 2026-09-28: that list is set-equality-gated against the actual emit sites —
 * tests/unit/main/fix-20260928-r4-main.test.mjs greps every emitSyncEvent('<type>') and fails
 * on any drift in either direction.)
 */
function emitSyncEvent (type, payload) {
  try {
    const senders = state.getWindowSenders ? state.getWindowSenders() : []
    const msg = { type, at: Date.now(), ...(payload || {}) }
    for (const s of senders) { try { if (s && !s.isDestroyed()) s.send('syncEvent', msg) } catch { /* dying sender */ } }
  } catch { /* renderer notification is best-effort */ }
}

/** r3 fix (2026-09-28): db.js's oplog append-failure hook lands here. Exported separately so
 *  db.js can reach it through a lazy require before (or without) initLanSync — with `state`
 *  null this degrades to a no-op instead of throwing inside the oplog's catch. */
function emitOplogAppendFailure (info) {
  try { emitSyncEvent('oplog-append-failed', { count: info && info.count, error: info && info.error }) } catch { /* renderer notification is best-effort */ }
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
/* sendToRenderers / foldIntoBlob / foldSettingsIntoBlob / emitAppliedRound live in
 * lan-sync/apply-broadcast.js (2026-09-27 size ratchet) — same injected-deps factory pattern
 * as paired-peers/peer-extras; getState keeps __test.setState effective. DATA_CHANNEL_KINDS
 * and BLOB_SETTINGS_KEY stay declared HERE (cli/check-sync-matrix.cjs parses the kinds list
 * from this file's source). */
const applyBroadcast = require('./lan-sync/apply-broadcast')({
  getState: () => state, busWrite, syncApply, HABITS_BLOB_FIELDS, DATA_CHANNEL_KINDS,
  BLOB_SETTINGS_KEY, emitSyncEvent, log,
})
const { emitAppliedRound } = applyBroadcast

/**
 * P2-5 (round-7): shared ingest epilogue — flush the buffered writes, then (only on flush
 * success) emit the applied round to renderers. A failed flush DROPPED the buffered rows from
 * the DB: emitting todos-changed / external-settings-changed (and folding the settings patch
 * into the source blobs) would show renderers data the DB does not have and let a hot-applied
 * field into the blob diverge from the rows. The round result keeps its applied counts either
 * way (logs / ack honesty unchanged); snapshot paths throw so the round fails (watermark safe).
 */
function finalizeIngest (r, { snapshot = false, chunk = false } = {}) {
  const flush = flushPendingWrites()
  if (flush && flush.ok === false) {
    if (snapshot) throw new Error((chunk ? 'snapshot chunk ' : 'snapshot ') + 'flush failed (rows dropped, snapshot will retry)')
    r.flushFailed = true
  }
  // 2026-09-26 poison-row quarantine + stalled-watermark fix (Layer 1): rows a failing flush
  // dropped are parked under sync.flushQuarantine.<op> (machine-local meta). Since Layer 1 a
  // successful quarantine no longer sets flush.ok=false (that pinned the sender's push
  // watermark on a poison row forever — every round re-pushed the same segment), so this
  // surfacing moved OUT of the ok===false branch: the quarantine must stay visible via Device
  // Center even when the round acks. ok===false now means parking itself failed (log-only
  // drop) — flushFailed keeps the ack below the segment (watermark safe).
  if (flush && Array.isArray(flush.quarantined) && flush.quarantined.length) {
    r.quarantined = flush.quarantined
    emitSyncEvent('flush-quarantined', {
      ops: flush.quarantined.map(q => q.op),
      count: flush.quarantined.reduce((n, q) => n + (q.count || 0), 0),
    })
  }
  if (!(r && r.flushFailed)) emitAppliedRound() // P0-1: refresh open views + settings hot-apply after a round applied rows
  return r
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
  // S3: invalidation goes through the watermark store — the live map clears and the durable row
  // is rewritten {__revoked:[...]} (revocations survive recovery); a whole-map flush from any
  // writer then cannot resurrect a revoked pairing's watermark.
  try { watermarkStore.invalidate(state && state.peerWatermarks) } catch (e) { log.warn('[LanSync] watermark invalidation persist failed:', e.message) }
  log.warn('[LanSync] peer watermarks invalidated (' + String(reason || 'recovery') + ') — full re-push + peer re-snapshot on next round')
  try { kickSyncRound('watermarks-invalidated') } catch { /* node not started yet */ }
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
    // D2-c fail closed: await the bind — a failed startSync (EADDRINUSE) must surface as a
    // toggle error here, not leave K_ENABLED=true with a dead server. Roll the setting back so
    // a restart doesn't auto-enable a server that cannot bind.
    try {
      await startSync()
    } catch (e) {
      settingPut(K_ENABLED, false)
      throw e
    }
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

// Pending-pair payload helper; body in flush-quarantine-view.js (size-ratchet extraction).
// Payload/summary helpers; bodies in flush-quarantine-view.js (size-ratchet extraction).
const pendingPairPayload = () => require('./flush-quarantine-view').pendingPairPayload(state.pendingPair)
const flushQuarantineSummary = require('./flush-quarantine-view').summarizeFlushQuarantine

function getStatusPayload () {
  const s = getSettingsPayload()
  const pendingPair = pendingPairPayload()
  const flushQuarantine = flushQuarantineSummary(state.db)
  if (!state.node) {
    return {
      ...s, listening: false, port: null, peers: [], recent: [], security: [],
      lastRoundAt: null, lastError: null, pendingPair, flushQuarantine,
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
    // Read-only flush-quarantine summary (Device Center; re-apply op is a registered follow-up).
    flushQuarantine,
    lastRoundAt: st.lastRoundAt, lastError: st.lastError, pendingPair,
    self: st.self || { deviceId: s.deviceId, deviceName: s.deviceName, port: st.port },
  }
}

/* per-peer display alias + missing-attachment key collection: extracted to
   lan-sync/peer-extras.js (structure size ratchet) — injected settings keep the
   swappable module-level state (__test.setState) applicable through the closure. */
const { K_PEER_ALIAS_PREFIX, peerAliasOf, missingAttachmentKeys } = require('./lan-sync/peer-extras')({ settingGet })

/* Pairing / unpair IPC op bodies: extracted to lan-sync/pair-ops.js (2026-09-27 size ratchet) —
 * same injected-deps factory pattern; getState keeps the swappable module-level state
 * (__test.setState) applicable through the closures. */
const pairOps = require('./lan-sync/pair-ops')({
  getState: () => state, settingGet, settingPut, busWrite, getSettingsPayload, ensureIdentity,
  stopSync, startSync, runRound, persistPeerWatermarks, persistPairedPeer, removePairedPeer,
  restartSync, // S5: one fail-closed restart path for every pairing/rename/unpair restart site
  manualPeers, loadPeerWatermarks, notifyRenderers, emitSyncEvent,
  K_PAIRING_SECRET, K_DEVICE_NAME, K_MANUAL_PEERS, K_PEER_WATERMARKS, K_ENABLED,
  K_PEER_ALIAS_PREFIX, PAIRING_CODE_TTL_MS, DEFAULT_PORT, log,
})
const syncUnpairPeerOp = pairOps.syncUnpairPeerOp


function registerOps () {
  syncOps.register({
    // main-internal (not renderer-callable): one-time legacy-row oplog backfill, see startSync.
    seedSyncOplog: () => {
      if (settingGet('sync.seedDone')) return { seeded: 0 }
      // bare pointers only: content already lives locally; hydration on push reads the live rows.
      // D13 finding 6: each pointer carries the row's REAL age where the entity stores one
      // (allRows rows carry updatedAt) so the backfill does not stamp every legacy row
      // newest-here; meta keys (no stored age) get the epoch-oldest 1 — a peer's genuine edit
      // then wins the next LWW round (same doctrine as the D11 category-restore stamp).
      const seen = new Set()
      const rows = []
      for (const r of createLocalStoreAdapter().allRows()) {
        const k = r.entity + ':' + r.id
        if (seen.has(k)) continue
        seen.add(k)
        const ts = r.entity === 'meta' ? 1 : (Number(r.updatedAt) > 0 ? Number(r.updatedAt) : undefined)
        rows.push({ entity: r.entity, id: r.id, ts })
      }
      const res = state.db.call('appendOplogPointers', rows)
      settingPut('sync.seedDone', '1')
      return res
    },
    syncGetSettings: () => getSettingsPayload(),
    syncGetStatus: () => getStatusPayload(),
    syncSetEnabled: syncSetEnabledOp,
    // Pairing/unpair/alias/name op bodies live in lan-sync/pair-ops.js (2026-09-27 size
    // ratchet, injected-deps factory); registration stays here so the db.OPS whitelist gate
    // (cli/check-command-bus.cjs) keeps seeing the same surface.
    syncPairWithCode: pairOps.syncPairWithCode,
    syncPairRespond: pairOps.syncPairRespond,
    syncPairRequest: pairOps.syncPairRequest,
    // P1-3: unpair a device (Device Center peer card). Deletes the peer record + push watermark
    // and revokes the shared pairing secret — every previously paired device must re-pair.
    syncUnpairPeer: p => syncUnpairPeerOp(p),
    syncSetPeerAlias: pairOps.syncSetPeerAlias,
    syncGetPairingCode: pairOps.syncGetPairingCode,
    syncSetName: pairOps.syncSetName,
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
    if (settingGet('sync.peerWatermarks') != null) busWrite('settingsRowDelete', { key: 'sync.peerWatermarks' })
  } catch (e) { log.warn('[LanSync] v1 watermark cleanup failed:', e.message) }
  try {
    if (settingGet(K_ENABLED) === true) {
      // D2-c: startSync is async and fail-closed now — a bind failure at boot must be logged,
      // not become an unhandled rejection. K_ENABLED stays true so the toggle reflects the
      // user's intent, but getStatus().listening=false shows the device card the truth.
      startSync().catch(e => log.error('[LanSync] startup enable failed:', e.message))
    }
  } catch (e) { log.warn('[LanSync] startup enable failed:', e.message) }
}

module.exports = { initLanSync, stopSyncForQuit, kickSyncRound, shipQuitRound, invalidateSyncWatermarks, emitOplogAppendFailure,
  // D19-DOM1: production surface for the startup Meta GC's tomatoRunAnnounce family rule
  // (index.js reads the paired-device set + our own identity). Same functions as the __test
  // entries below — single source.
  loadPairedPeers, ensureIdentity }

// Test-only hooks: applyRowInner/flushPendingWrites operate on the module-level `state` singleton;
// unit tests swap in a mock state via __test.setState. Production paths never touch __test.
module.exports.__test = {
  setState: s => { state = s },
  applyRow: row => applyRowSafe(row),
  allRows: () => createLocalStoreAdapter().allRows(),
  // r2 2026-09-28 test surface: egress hydration failure counting (getRowsSince no longer
  // swallows hydrateRow exceptions).
  getRowsSince: seq => createLocalStoreAdapter().getRowsSince(seq),
  flushPendingWrites,
  syncSetEnabled: syncSetEnabledOp,
  localUserId,
  // watermark persistence surface (2026-09-19 regression tests): the live map <-> settings_rows
  // round-trip is the restart-survival contract for per-peer push watermarks.
  persistPeerWatermarks,
  createTrackedWatermarks,
  loadPeerWatermarks,
  // S3/S6 test surface: db-injectable store wiring (corrupt-read / degraded-persist scenarios).
  makeWatermarkStoresForDb,
  // S6 test surface: security-ring store contract (read-throw seeds empty + degrades writes).
  loadSecurityLog,
  scheduleSecurityPersist,
  // P0-1/P1-2/P1-5 test surface: post-round applied bookkeeping -> renderer broadcasts.
  emitAppliedRound: () => emitAppliedRound(),
  finalizeIngest,
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
  // S5 test surface: the ONE fail-closed restart path + the pair-ops handlers that route
  // through it (bind-failure rollback / op-rejection contract).
  restartSync,
  pairOps,
  invalidateSyncWatermarks,
  // Round-2 P1 test surface: peer alias op registration + live-todo attachment key collection.
  registerOps,
  missingAttachmentKeys,
  // d12 schemaVersion gate test surface: the snapshot receivers with the gate applied.
  ingestSnapshotAssembled,
  ingestSnapshotChunked,
}
