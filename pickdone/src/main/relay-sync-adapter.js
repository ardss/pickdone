'use strict'
/**
 * Relay sync adapter (Sync v2, spec §16-§18/§33/§54/§65) — the OPTIONAL main-process
 * bridge between the app's revision store and the HTTPS relay transport.
 *
 * Design contract (relay worktree slice, 2026-10-10):
 *   - DEFAULT OFF. Nothing runs, nothing is stored, until enable() is called AND the
 *     'sync.relay.enabled' flag is set; the flag alone is inert until initRelaySync wires
 *     the adapter (relay-sync-bootstrap.js). Mirrors the LAN sync lazy-lifecycle doctrine.
 *   - E2E MANDATORY: every round derives an AEAD data key (sync-crypto/e2e.mjs, HKDF root →
 *     data key) and hands it to the relay client, so the relay only ever stores opaque
 *     'e1.*' ciphertext (spec §3/§33). There is NO plaintext fallback code path: a missing
 *     root key fails the round instead of degrading the transport. Remote sync without E2E
 *     is the exact "cloud plaintext sync" hazard this adapter exists to prevent.
 *   - AUTH: per-device bearer credential (relay /v1/device/register, shown once). The
 *     adapter persists it (settings door) and re-ATTACHES it on restart — an attach that
 *     blind-re-registered would 409 against the relay's secret-rotation guard. A 401 (relay
 *     lost its registry) recovers by re-registering through the client and persisting the
 *     ROTATED secret via the onDeviceSecret hook.
 *   - ACK/CURSOR PERSISTENCE (spec §18 cursor-commit rule): cursor + pushed-set are only
 *     persisted AFTER a successful round; a crash mid-round reverts to the last durable
 *     snapshot and replays — safe because push dedupes by opId (relay appendEnvelope) and
 *     applyEnvelope classifies replays as duplicate/ignored.
 *   - RETRY IDEMPOTENCY: network throws / 5xx / 429 are retried with bounded backoff;
 *     4xx is permanent (409 rotation conflict, 413...) and surfaces as lastError with local
 *     state untouched. Progress inside a failed round is discarded, not half-marked.
 *   - PRODUCTION DEPLOYMENT GATE (deliberate, not an oversight): remote (non-loopback)
 *     relays are refused unless TODO_RELAY_ALLOW_REMOTE=1. The remaining gates for real
 *     deployments — TLS termination in front of the relay, an enrollment secret on
 *     /v1/device/register, and a real key-pairing/account service (spec Step 14+) — do NOT
 *     exist yet; until they do, only loopback/LAN tests with locally-generated or manually
 *     shared root keys are sanctioned (see docs gap in the slice report).
 *
 * Pure dependency-injected CommonJS: no Electron, no db handle, no timers that survive
 * stop(). The bootstrap (relay-sync-bootstrap.js) owns the app wiring.
 */

const { randomBytes } = require('node:crypto')
const { pathToFileURL } = require('node:url')
const path = require('node:path')

// Machine-local settings keys — the 'sync.' namespace is never hydrated to peers
// (sync-apply-hydrate skips it), and these live under the relay-scoped settings door
// (db.js OPS.relaySettingGet/Put force the 'sync.relay.' prefix), so secrets can neither
// egress nor be overwritten by a peer.
const K = {
  ENABLED: 'enabled',        // '1' | '0' | absent (absent == OFF)
  ACCOUNT: 'account',        // relay account id (user-chosen, opaque to the relay schema)
  BASE_URL: 'baseUrl',       // relay origin
  ROOT_KEY: 'rootKey',       // 64-hex account root key → HKDF data key (NEVER leaves the device)
  ENROLLMENT: 'enrollment',  // operator-issued registration secret (relays with enrollment set reject open registration)
  DEVICE_SECRET: 'deviceSecret', // per-device bearer credential from /v1/device/register
  STATE: 'state',            // JSON {cursor, pushed:[revisionId]} — durable ACK/cursor (spec §18)
}

/** Env gate that unlocks non-loopback relays (production pre-condition, see header). */
const REMOTE_GATE_ENV = 'TODO_RELAY_ALLOW_REMOTE'

const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const ROOT_KEY_RE = /^[0-9a-f]{64}$/
/** Durable pushed-set cap: beyond this, oldest entries are dropped on persist. Dropping is
 *  SAFE by design — a dropped id re-pushes next round and the relay dedupes by opId. The cap
 *  bounds the settings row, not correctness. */
const MAX_PERSISTED_PUSHED = 20000

const START_DELAY_MS = 5000
const ROUND_INTERVAL_MS = 5 * 60 * 1000
const RETRY_MAX = 3
const RETRY_BASE_MS = 500

function isLoopbackBaseUrl (raw) {
  try {
    const u = new URL(String(raw))
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false
    const h = u.hostname
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'
  } catch { return false }
}

function defaultSleep (ms) { return new Promise(r => setTimeout(r, ms)) }
async function defaultImportModules () {
  const [client, e2e] = await Promise.all([
    import(pathToFileURL(path.join(__dirname, '..', '..', 'shared', 'sync-transport', 'https', 'relay-client.mjs')).href),
    import(pathToFileURL(path.join(__dirname, '..', '..', 'shared', 'sync-crypto', 'e2e.mjs')).href),
  ])
  return { createRelayClient: client.createRelayClient, deriveDataKey: e2e.deriveDataKey }
}

/** Retryable = transport-level uncertainty. 4xx answers are DECISIONS (auth, rotation guard,
 *  validation) — retrying them verbatim would hammer a policy rejection; replaying them is
 *  still safe, just pointless. Network throws carry no status → retryable. A pull-side
 *  business apply failure is DETERMINISTIC local state (the client flags it noRetry) —
 *  re-running the identical failing apply under backoff would just burn 3 rounds. */
function isRetryable (e) {
  if (!e) return false
  if (e.noRetry) return false
  if (e.status == null) return true
  return e.status >= 500 || e.status === 429
}

/**
 * @param {object} deps
 * @param {string} deps.nodeId stable device id (shared with LAN sync's sync.deviceId when available)
 * @param {(key: string) => string|null} deps.settingsGet machine-local door read (raw string|null)
 * @param {(key: string, value: string) => void} deps.settingsPut machine-local door write
 * @param {() => Promise<object>} deps.loadStore async bridge → a sync-core revision store
 *   (createRevisionStore shape) holding the app's recorded revisions for this round
 * @param {(received: Array<{envelope: object, status: string}>, store: object, nodeId: string) => Promise<object>|object} [deps.applyPulled]
 *   pull-side materialization bridge (relay-sync-apply via the bootstrap): ingest the
 *   round's received envelopes into the local DAG + business tables. OPTIONAL — absent
 *   (or a bare-transport host) the adapter stays the pre-materialization transport-only
 *   slice. Runs strictly BEFORE the durable cursor commit: a throw fails the round and
 *   the cursor replays (spec §18 — never ack what did not land).
 * @param {{info?:Function,warn?:Function,error?:Function}} [deps.log]
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {() => number} [deps.now]
 * @param {object} [deps.env] process.env stand-in for gate tests
 * @param {() => Promise<{createRelayClient:Function, deriveDataKey:Function}>} [deps.importModules]
 * @param {(ms: number) => Promise<void>} [deps.sleep]
 * @param {number} [deps.retryMax] attempts per network step (default 3)
 * @param {number} [deps.retryBaseMs] backoff base (default 500, doubles per attempt)
 * @param {number} [deps.pushChunkBytes] relay-client per-POST budget override (tests)
 * @param {number} [deps.roundIntervalMs] polling cadence override (tests)
 * @param {number} [deps.fetchTimeoutMs] per-request abort budget forwarded to the relay client
 *   (default 30000; a half-dead relay used to hang each POST on undici's ~300s default)
 */
function createRelayAdapter ({
  nodeId, settingsGet, settingsPut, loadStore, applyPulled,
  log = {}, fetchImpl = global.fetch, now = Date.now,
  env = process.env, importModules = defaultImportModules,
  sleep = defaultSleep, retryMax = RETRY_MAX, retryBaseMs = RETRY_BASE_MS,
  pushChunkBytes, roundIntervalMs = ROUND_INTERVAL_MS, fetchTimeoutMs = 30_000,
} = {}) {
  if (!nodeId || typeof nodeId !== 'string') throw new Error('relay-adapter: nodeId required')
  if (typeof settingsGet !== 'function' || typeof settingsPut !== 'function') throw new Error('relay-adapter: settingsGet/settingsPut required')
  if (typeof loadStore !== 'function') throw new Error('relay-adapter: loadStore bridge required')

  const metrics = { lastRoundAt: null, lastError: null, lastResult: null, rounds: 0, pushedTotal: 0, pulledTotal: 0, quarantinedTotal: 0, appliedTotal: 0 }
  let polling = false
  // M2 P2 (2026-10-09): the timer registry used to be an append-only array — every schedule()
  // pushed the dead setTimeout handle and nothing ever removed it, so a long-lived process
  // accumulated hundreds of dead handles per day (poll tick + write-kicks). A Set with
  // fire-time self-removal keeps the registry equal to the LIVE pending timers only.
  const timers = new Set() // live pending timers only (fire-time self-removal; M2 2026-10-09)
  let inFlight = null // coalesce: timer tick + write-kick + manual op share one round
  let mods = null // cached { createRelayClient, deriveDataKey }

  const get = k => settingsGet(K[k])
  const put = (k, v) => settingsPut(K[k], String(v))
  const del = k => settingsPut(K[k], '')

  let lastPersistedStateJson = null // change gate: skip the durable write when nothing moved

  function loadPersistedState () {
    const raw = get('STATE')
    if (!raw) return { cursor: 0, pushed: [] }
    lastPersistedStateJson = raw
    try {
      const v = JSON.parse(raw)
      if (!v || typeof v !== 'object') return { cursor: 0, pushed: [] }
      return {
        cursor: Number.isFinite(v.cursor) && v.cursor > 0 ? Math.floor(v.cursor) : 0,
        pushed: Array.isArray(v.pushed) ? v.pushed.filter(x => typeof x === 'string').slice(0, MAX_PERSISTED_PUSHED) : [],
      }
    } catch (e) {
      // torn state row: reset to empty (re-push/re-pull is duplicate-safe) — never throw into the round
      if (log.warn) log.warn('[RelaySync] torn durable state, resetting (replay is idempotent): ' + (e && e.message))
      lastPersistedStateJson = null
      return { cursor: 0, pushed: [] }
    }
  }

  function persistState (state) {
    const pushed = state.pushed.length > MAX_PERSISTED_PUSHED
      ? state.pushed.slice(state.pushed.length - MAX_PERSISTED_PUSHED) // keep newest, drop oldest (re-push is dedupe-safe)
      : state.pushed
    const json = JSON.stringify({ cursor: state.cursor, pushed })
    // no-op rounds must not append an identical mega-row to the local meta/oplog every 5 minutes
    if (json === lastPersistedStateJson) return false
    put('STATE', json)
    lastPersistedStateJson = json
    return true
  }

  function status () {
    const enabled = get('ENABLED') === '1'
    return {
      enabled,
      nodeId,
      account: get('ACCOUNT'),
      baseUrl: get('BASE_URL'),
      hasRootKey: !!get('ROOT_KEY'),
      hasEnrollment: !!get('ENROLLMENT'),
      hasDeviceSecret: !!get('DEVICE_SECRET'),
      registered: !!get('DEVICE_SECRET'),
      cursor: loadPersistedState().cursor,
      polling,
      remoteGateEnv: REMOTE_GATE_ENV,
      remoteAllowed: String(env[REMOTE_GATE_ENV] || '') === '1',
      loopbackOnly: String(env[REMOTE_GATE_ENV] || '') !== '1',
      productionGate: 'remote relays additionally require: TLS termination + enrollment secret + account key-pairing service (not built yet); loopback tests only until then',
      ...metrics,
    }
  }

  async function ensureModules () {
    if (!mods) mods = await importModules()
    if (!mods || typeof mods.createRelayClient !== 'function' || typeof mods.deriveDataKey !== 'function') {
      throw new Error('relay-adapter: transport/e2e modules unavailable')
    }
    return mods
  }

  /** One retryable step: bounded backoff on retryable failures, immediate throw otherwise. */
  async function step (what, fn) {
    let lastErr = null
    for (let attempt = 1; attempt <= retryMax; attempt++) {
      try { return await fn() } catch (e) {
        lastErr = e
        if (attempt >= retryMax || !isRetryable(e)) break
        const delay = retryBaseMs * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 250)
        if (log.warn) log.warn(`[RelaySync] ${what} failed (attempt ${attempt}/${retryMax}), retrying in ${delay}ms: ` + (e && e.message))
        await sleep(delay)
      }
    }
    throw lastErr
  }

  /**
   * One idempotent sync round. Coalesced (timer/kick/manual share `inFlight`); never throws
   * into the scheduler — failures land in lastError and the durable state stays at the last
   * committed snapshot (crash-consistent by construction).
   */
  async function round () {
    if (inFlight) return inFlight
    inFlight = (async () => {
      if (get('ENABLED') !== '1') return { ok: false, skipped: 'disabled' }
      try {
        const account = get('ACCOUNT')
        const baseUrl = get('BASE_URL')
        const rootKey = get('ROOT_KEY')
        if (!account || !baseUrl) throw new Error('relay-adapter: enabled but account/baseUrl missing (config torn)')
        if (!rootKey || !ROOT_KEY_RE.test(rootKey)) throw new Error('relay-adapter: E2E root key missing — refusing to sync without encryption (no plaintext fallback exists)')
        const { createRelayClient, deriveDataKey } = await ensureModules()
        const dataKey = deriveDataKey(rootKey)
        const store = await loadStore()
        if (!store) throw new Error('relay-adapter: loadStore returned no revision store')
        const savedSecret = get('DEVICE_SECRET') || null
        // Pull-side materialization (relay-sync-apply via the bootstrap) now runs INSIDE
        // the client's cursor gate (2026-10-14): the gate fires after the pull frames are
        // decrypted+merged but BEFORE the ack/cursor commit, so a batch the business
        // layer could not fully materialize is never acked into relay GC. The old
        // post-round ordering let the client ack the full cursor first — relay gc()
        // then deleted the unmaterialized envelopes (settings/tomato/...) and their
        // remote changes were silently lost forever (LAN channel unaffected).
        let businessApplied = 0
        let businessSkipped = 0
        let warning = null
        const client = createRelayClient({
          nodeId, account, baseUrl, store, dataKey, fetchImpl,
          deviceSecret: savedSecret,
          enrollment: get('ENROLLMENT') || null,
          pushChunkBytes,
          fetchTimeoutMs,
          state: loadPersistedState(),
          onDeviceSecret: secret => { try { put('DEVICE_SECRET', secret) } catch (e) { if (log.warn) log.warn('[RelaySync] device secret persist failed: ' + (e && e.message)) } },
          // Cursor gate: walk the batch's decrypted frames in serverSeq order; advance
          // the cursor through frames the business layer vouches for ('ok' = materialized
          // or no-op) and STOP at the first 'blocked' frame (entity this slice cannot
          // materialize). Everything behind the stop is re-pulled next round — duplicate
          // pulls are idempotent (revisionId dedup + LWW no-ops); silent loss is not
          // recoverable. A missing/absent verdict map keeps the legacy advance-all
          // behavior (bare stub hosts in tests).
          onBeforeAck: typeof applyPulled === 'function'
            ? async ({ applied, fromSeq, items, ownIds }) => {
                const outcome = await applyPulled(items, client.store, nodeId)
                businessApplied = (outcome && outcome.businessApplied) || 0
                businessSkipped = (outcome && outcome.businessSkipped) || 0
                metrics.appliedTotal += businessApplied
                const verdicts = outcome && outcome.verdicts
                if (!(verdicts instanceof Map)) return applied // legacy stub: no per-frame verdicts → historical semantics
                const isOwn = id => !!(ownIds && ownIds.has(id))
                let safe = Math.max(0, (Number.isFinite(fromSeq) ? fromSeq : 1) - 1)
                let blocked = false
                for (const it of (Array.isArray(items) ? items : [])) {
                  const id = it.envelope && it.envelope.revisionId
                  // Own-device frames (this device pushed them) never hold the cursor:
                  // their content already lives in the local business tables + DAG, and
                  // the v2 recorder mints non-todo bookkeeping revisions on every write —
                  // holding on those would pin the cursor at the relay head forever.
                  if (verdicts.get(id) === 'blocked' && !isOwn(id)) { blocked = true; continue }
                  if (!blocked && Number.isFinite(it.serverSeq)) safe = Math.max(safe, it.serverSeq)
                }
                if (blocked) {
                  warning = `cursor held at seq ${safe} (relay head ${applied}): ` +
                    `${businessSkipped} pulled envelope(s) not yet materializable by this build ` +
                    `(non-todo entities) — re-pulled each round until per-entity materialization lands (re-pull is idempotent)`
                  if (log.warn) log.warn('[RelaySync] ' + warning)
                }
                return blocked ? safe : applied
              }
            : undefined,
        })
        if (!savedSecret) await step('register', () => client.register())
        const r = await step('round', () => client.round())
        // commit point (spec §18): persist ONLY past a fully successful round — a crash
        // before this line replays from the previous snapshot, which is duplicate-safe.
        persistState(client.state())
        metrics.lastRoundAt = now()
        metrics.lastError = null
        metrics.rounds++
        metrics.pushedTotal += r.pushed || 0
        metrics.pulledTotal += r.pulled || 0
        metrics.quarantinedTotal += r.quarantined || 0
        metrics.lastResult = { pushed: r.pushed || 0, pulled: r.pulled || 0, quarantined: r.quarantined || 0, cursor: r.cursor, regressionReset: !!r.regressionReset, businessApplied, businessSkipped, ...(warning ? { warning } : {}) }
        return { ok: true, ...metrics.lastResult }
      } catch (e) {
        metrics.lastError = (e && e.message) || String(e)
        metrics.lastRoundAt = now()
        if (log.warn) log.warn('[RelaySync] round failed: ' + metrics.lastError)
        return { ok: false, error: metrics.lastError }
      } finally {
        inFlight = null
      }
    })()
    return inFlight
  }

  function schedule (fn, ms) {
    // Self-removing: the handle leaves the registry the moment it fires (before fn runs), so
    // the registry tracks only live/pending timers (M2 2026-10-09 — see the timers declaration).
    const t = setTimeout(() => { timers.delete(t); fn() }, ms)
    if (typeof t.unref === 'function') t.unref() // never hold the process/test runner open
    timers.add(t)
    return t
  }

  function clearTimers () {
    for (const t of timers) clearTimeout(t)
    timers.clear()
  }

  function start () {
    if (polling) return
    polling = true
    const tick = () => {
      if (!polling) return
      round() // never throws (round swallows into lastError)
      schedule(tick, roundIntervalMs)
    }
    schedule(tick, START_DELAY_MS)
  }

  function stop () {
    polling = false
    clearTimers()
  }

  /** Write-kick: debounced by the inFlight coalescing — a burst of local writes collapses
   *  into at most one queued round plus the running one. */
  function kick () {
    if (!polling || inFlight) return
    schedule(() => { if (polling) round() }, 250)
  }

  /**
   * Enable relay sync for {account, baseUrl} with an E2E root key (generated on first
   * enable, or injected to simulate a shared-account pairing across devices in tests)
   * and an optional operator-issued enrollment secret (required by relays that closed
   * open registration). Fail-open on first-round connectivity (a relay that is
   * temporarily down must not block configuration) but strict on configuration
   * validity — bad input never persists.
   */
  async function enable ({ account, baseUrl, rootKey, enrollment } = {}) {
    account = String(account || '').trim()
    baseUrl = String(baseUrl || '').trim()
    if (!ACCOUNT_RE.test(account)) throw new Error('relay-adapter: account must match ' + ACCOUNT_RE.source)
    let u
    try { u = new URL(baseUrl) } catch { throw new Error('relay-adapter: baseUrl must be an absolute URL') }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('relay-adapter: baseUrl must be http(s)')
    if (u.username || u.password || u.search || u.hash) throw new Error('relay-adapter: baseUrl must be a bare origin (no credentials/query/hash)')
    const remoteAllowed = String(env[REMOTE_GATE_ENV] || '') === '1'
    if (!isLoopbackBaseUrl(baseUrl) && !remoteAllowed) {
      throw new Error(`relay-adapter: non-loopback relay refused (${REMOTE_GATE_ENV}=1 unlocks; production gates: TLS + enrollment + key-pairing service are not built yet)`)
    }
    if (rootKey != null && !ROOT_KEY_RE.test(String(rootKey))) throw new Error('relay-adapter: rootKey must be 64 hex chars')
    if (enrollment != null && String(enrollment).length > 512) throw new Error('relay-adapter: enrollment too long (max 512)')
    // An existing deviceSecret and durable cursor belong to one relay account/origin.
    // A silent rebind can reuse a wrong bearer token or skip remote history. Fail
    // BEFORE any settings writes; explicit forget/key migration requires review.
    const priorAccount = get('ACCOUNT')
    const priorBaseUrl = get('BASE_URL')
    const priorRootKey = get('ROOT_KEY')
    if (priorAccount && (priorAccount !== account || (priorBaseUrl && priorBaseUrl !== baseUrl))) {
      throw new Error('relay-adapter: different account or relay origin requires explicit forget; refusing to rebind existing identity')
    }
    if (rootKey != null && priorRootKey && String(rootKey) !== priorRootKey) {
      throw new Error('relay-adapter: different root key requires explicit key migration; refusing silent key rotation')
    }
    const key = rootKey != null ? String(rootKey) : (priorRootKey || randomBytes(32).toString('hex'))
    put('ACCOUNT', account)
    put('BASE_URL', baseUrl)
    if (enrollment != null) put('ENROLLMENT', String(enrollment)) // absent = keep the previously configured one
    put('ROOT_KEY', key)
    put('ENABLED', '1')
    // ensure the v2 revision recorder is recording: the relay transport's payload IS the
    // revision DAG — with the flag off there is nothing to push (inert locally, so it is
    // left on after disable; recording without a transport is harmless).
    if (log.info) log.info(`[RelaySync] enabled for account=${account} baseUrl=${baseUrl} (${remoteAllowed && !isLoopbackBaseUrl(baseUrl) ? 'REMOTE via env gate' : 'loopback'})`)
    const r = await round()
    start()
    return { ...status(), firstRound: r }
  }

  async function disable () {
    stop()
    put('ENABLED', '0')
    if (log.info) log.info('[RelaySync] disabled (config + secrets retained for re-enable)')
    return status()
  }

  /** Device removal: clear credential + durable state + config. Re-enabling starts a fresh
   *  device identity against the relay (new register). */
  async function forget () {
    stop()
    for (const k of Object.keys(K)) del(k)
    if (log.info) log.info('[RelaySync] forgot relay identity (secrets + durable state cleared)')
    return status()
  }

  return { nodeId, status, enable, disable, forget, round, start, stop, kick,
    /** Resolves when no round is in flight (quit path: persist must beat the db close). */
    whenIdle: () => (inFlight || Promise.resolve()).then(() => {}),
    // test/introspection surface
    __test: { K, loadPersistedState, persistState, metrics, MAX_PERSISTED_PUSHED,
      // M2 2026-10-09: bounded-timer-registry regression seam — live pending timers only.
      timers, schedule, clearTimers } }
}

module.exports = { createRelayAdapter, isLoopbackBaseUrl, isRetryable, SETTINGS_KEYS: K, REMOTE_GATE_ENV, MAX_PERSISTED_PUSHED }
