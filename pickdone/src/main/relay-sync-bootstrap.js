'use strict'
/**
 * Relay sync bootstrap (Sync v2, 2026-10-10) — the app-side wiring for the OPTIONAL
 * HTTPS relay transport. Extracted from index.js doctrine: index.js keeps one thin
 * require+call after db init; everything else lives here.
 *
 * Responsibilities:
 *   - Build the dependency-injected adapter (relay-sync-adapter.js) from real app surfaces:
 *     settings door (db.js relaySettingGet/Put — machine-local, never oplog-captured),
 *     device identity (LAN sync's sync.deviceId when initialized), revision store bridge
 *     (db-revisions exportToStore), electron-log.
 *   - Register db-sync-ops handlers (relayGetSettings/relaySetEnabled/relayGetStatus/
 *     relaySyncNow/relayForget) so db.call reaches them; the db.js OPS delegates are the
 *     gate-visible surface. NOT renderer-whitelisted this slice: main/CLI only (the Device
 *     Center UI + three-way whitelist rows are a follow-up slice with the ux worktree).
 *   - Lifecycle: lazy like LAN sync — never auto-enables; if the flag was left on by a
 *     previous session, resume polling (adapter.start) without throwing at boot.
 *
 * Production gates (see adapter header): loopback-only until TLS + enrollment + key-pairing
 * service exist; TODO_RELAY_ALLOW_REMOTE=1 is the explicit unlock for pre-gate testing.
 */

const { randomUUID } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const path = require('node:path')
const log = require('electron-log')
require('./log-isolation') // test isolation: redirect electron-log file transport into TODO_DB_DIR/TODO_USER_DATA_DIR

const { createRelayAdapter } = require('./relay-sync-adapter')

let st = null // { adapter }

/* ---------- injected deps (real app surfaces) ---------- */

/**
 * Machine-local state door, META-backed: the relay adapter's config/secrets (bearer
 * deviceSecret, E2E root key, durable ACK cursor) persist under the 'sync.relay.*' META
 * namespace — the same class as LAN sync's 'sync.pushCursor' bookkeeping. The 'sync.'
 * prefix is machine-local per shared/machine-local-keys.mjs (egress hydration + ingress
 * apply both skip it), so nothing here ever reaches a peer; the local oplog rows are the
 * same trusted posture as LAN sync's pairingSecret. Writes go through the command bus
 * ('meta'/'put' → setMeta) — the single sanctioned write door (check-command-bus), never
 * raw db.call write literals.
 */
const KEY_PREFIX = 'sync.relay.'
const settingsGet = key => {
  const dbm = require('./db')
  const v = dbm.call('getMeta', KEY_PREFIX + key)
  return v == null ? null : String(v)
}
const settingsPut = (key, value) => {
  require('./command-bus').commit('meta', 'put', [KEY_PREFIX + key, String(value)])
}

/** Device identity: ONE stable nodeId shared with LAN sync when it is initialized (its
 *  ensureIdentity also stamps the db write author). Fallback for lan-sync-less hosts
 *  (tests): a self-managed sync.relay.nodeId. */
function resolveNodeId () {
  try {
    const { ensureIdentity } = require('./lan-sync-bootstrap')
    const id = ensureIdentity()
    if (id && id.deviceId) return id.deviceId
  } catch { /* lan-sync lazy-not-initialized: fall through to the self-managed id */ }
  let id = settingsGet('nodeId')
  if (!id) {
    id = randomUUID()
    settingsPut('nodeId', id)
    log.info('[RelaySync] fallback device identity created:', id)
  }
  return id
}

/** Revision store bridge: the app DB's recorded v2 revision DAG → a sync-core store.
 *  Full re-export per round (correct, reuses the recorder's only public bridge); an
 *  incremental feed is the engine worktree's follow-up (documented slice gap). */
async function loadStore () {
  const merge = await import(pathToFileURL(path.join(__dirname, '..', '..', 'shared', 'sync-core', 'causality', 'merge.mjs')).href)
  const rev = require('./db').__revisionsForTests
  return rev.exportToStore(merge.createRevisionStore, merge.applyEnvelope)
}

/** Pull-side materialization bridge (relay-sync-apply.js): received envelopes → local
 *  DAG + business todos, BEFORE the adapter commits its durable cursor. Throwing fails
 *  the round so the cursor replays — never ack what did not land (spec §18). */
function applyPulled (received, store, nodeId) {
  return require('./relay-sync-apply').applyPulledEnvelopes(received, store, nodeId)
}

/* ---------- IPC op handlers (registered into db.OPS via db-sync-ops) ---------- */

function registerOps (adapter) {
  require('./db-sync-ops').register({
    relayGetSettings: () => adapter.status(),
    relayGetStatus: () => adapter.status(),
    relaySetEnabled: p => {
      if (p && p.enabled) {
        // the relay transport's payload IS the v2 revision DAG — with the recorder flag off
        // there is nothing to push. Flip it on here (machine-local op, revisionsFlag doctrine);
        // disable() leaves it on deliberately: recording without a transport is inert, and
        // keeping history makes a re-enable continuity-preserving.
        try { require('./db').call('revisionsFlag', { on: true }) } catch (e) { log.warn('[RelaySync] revisionsFlag flip failed:', e && e.message) }
        // P1 backfill (2026-10-11 delivery audit): recording is record-only-forward, so a
        // v1-era row (predating the flag) had no revision — it never entered the push DAG AND
        // its missing head let the first pulled remote envelope claim causalCurrent over a
        // concurrent untracked local edit (silent newer-local loss). Record every live row
        // that has no revision once, right after the flag is on. Idempotent by construction.
        try {
          const bf = require('./db').call('revisionsBackfillUnrecorded', { entity: 'todo' })
          if (bf && bf.backfilled) log.info(`[RelaySync] backfilled ${bf.backfilled} v1-era todo row(s) into the revision DAG`)
        } catch (e) { log.warn('[RelaySync] v1 revision backfill failed:', e && e.message) }
        return adapter.enable({ account: p.account, baseUrl: p.baseUrl, rootKey: p.rootKey })
      }
      return adapter.disable()
    },
    relaySyncNow: () => adapter.round(),
    relayForget: () => adapter.forget(),
  })
}

/**
 * Called once from src/main/index.js right after initLanSync. Never auto-enables: it only
 * resumes polling when a previous session left the flag on (the user's persisted intent).
 */
function initRelaySync () {
  if (st) return st // idempotent: re-init keeps the running adapter (mirrors LAN sync singleton)
  const adapter = createRelayAdapter({
    nodeId: resolveNodeId(),
    settingsGet,
    settingsPut,
    loadStore,
    applyPulled,
    log,
  })
  registerOps(adapter)
  if (adapter.status().enabled) {
    // boot resume is fire-and-forget: a relay that is down at boot must not fail startup
    try { adapter.start() } catch (e) { log.warn('[RelaySync] resume failed:', e && e.message) }
  }
  st = { adapter }
  return st
}

function adapterOrNull () { return st ? st.adapter : null }

/** Quit path: stop the poller and let an in-flight round settle (its durable-state persist
 *  must beat the db close), mirroring stopSyncForQuit's await-the-stop contract. */
async function stopForQuit () {
  if (!st) return
  st.adapter.stop()
  try { await st.adapter.whenIdle() } catch { /* round already failed into lastError */ }
}

/** Local-write kick (wired next to the LAN sync kick in index.js notifySyncChange): debounced
 *  by the adapter's inFlight coalescing; no-op before init or while disabled/paused. */
function kickRelayRound (reason) {
  const a = adapterOrNull()
  if (!a) return
  try { a.kick() } catch (e) { log.warn('[RelaySync] kick failed (' + String(reason || '') + '):', e && e.message) }
}

module.exports = { initRelaySync, stopForQuit, kickRelayRound }

// Test-only hooks: tests re-init against a fresh db by resetting the module singleton.
module.exports.__test = {
  reset () { if (st) { try { st.adapter.stop() } catch {} } st = null },
  getState: () => st,
}
