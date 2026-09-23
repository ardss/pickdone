'use strict'

/**
 * Running-tomato cross-device announcements (feature: a focus countdown started on one
 * device is visible LIVE on paired LAN-sync peers).
 *
 * Mechanism: the device running a focus writes its runtime under the meta key
 *   tomatoRunAnnounce.<deviceId>
 * (JSON value, see buildAnnounceValue). The key is deliberately NOT covered by any
 * machine-local meta filter in sync-apply.js, so it propagates through the regular
 * `meta` entity (LWW via setMeta, PR #76). Receiving devices learn about it two ways:
 *   - the sync apply path (sync-apply.js) calls emitRemoteAnnounce after landing one of
 *     these keys, which fans out to subscribers (lan-sync-bootstrap turns it into a
 *     'tomato-announce' syncEvent for the renderer);
 *   - on startup the renderer pulls the current snapshot via listAnnounces() (oplog
 *     pointer scan + getMeta reads — db.js is size-ratcheted and has no meta list op).
 * Display-only: receivers never auto-start or ring. Staleness is self-healing: a peer
 * that crashed mid-focus never wrote its idle announce, but the entry expires by TTL.
 *
 * Pure Node (no Electron imports) and requireable from unit tests: db access is
 * injected via init(), listeners are plain callbacks.
 */

const KEY_PREFIX = 'tomatoRunAnnounce.'
// F-A4: shared text sanitizer (pure Node, no Electron) — see buildAnnounceValue.
const { sanitizeText } = require('./sanitize')
// Staleness TTL factor (spec): an entry older than 2x its planned duration is dead even
// if startedAt+plannedSec is still in the future (covers clock skew between peers).
const STALE_AGE_FACTOR = 2

let dbCall = null // injected: (op, params) => any  (main-process db.call)
let getIdentity = null // injected: () => ({ deviceId, deviceName })
let kickRound = null // injected: (reason) => void  (lan-sync-bootstrap.kickSyncRound)
const remoteListeners = new Set()

function init ({ dbCall: db, getIdentity: ident, kickRound: kick } = {}) {
  dbCall = typeof db === 'function' ? db : null
  getIdentity = typeof ident === 'function' ? ident : null
  kickRound = typeof kick === 'function' ? kick : null
}

function keyFor (deviceId) { return KEY_PREFIX + String(deviceId) }
function isAnnounceKey (key) { return String(key || '').startsWith(KEY_PREFIX) }

/**
 * Announce payload builder (pure, unit-tested). Shape contract with the renderer store:
 * {deviceId, deviceName, status:'running'|'idle', startedAt, plannedSec, at,
 *  attachTodoId?, attachTodoTitle?}. `at` is the write timestamp — receivers use it for
 * the TTL rule. Idle announcements drop the attach fields (nothing to link to).
 */
function buildAnnounceValue ({ deviceId, deviceName, status, startedAt, plannedSec, attachTodoId, attachTodoTitle, at } = {}) {
  const now = Number(at) || Date.now()
  // Review follow-up to F-A4 (2026-09-24): deviceName/deviceId are PEER-CONTROLLED too (a
  // device names itself at pairing) and deviceName is rendered verbatim in peer UI chips —
  // sanitize them through the same choke point as the attach fields (transport.js
  // cleanDeviceName caps names at 40 for the same log-forging reason). parseAnnounce re-runs
  // this builder, so remote values are re-sanitized on receive; legit ids/names are
  // alphanumeric + CJK and pass through unchanged.
  const base = {
    deviceId: sanitizeText(String(deviceId || ''), 128),
    deviceName: sanitizeText(String(deviceName || ''), 40),
    status: status === 'running' ? 'running' : 'idle',
    startedAt: Number(startedAt) || 0,
    plannedSec: Math.max(0, Number(plannedSec) || 0),
    at: now,
  }
  if (base.status === 'running' && attachTodoId) {
    base.attachTodoId = sanitizeText(String(attachTodoId || ''), 120) // same clamp as the title (ids are short; unbounded String() was the same injection surface)
    // Domain-1 F-A4 (2026-09-23): the title used to pass through bare String() — an
    // unclamped 32MB title written into meta then kickRound-synced to EVERY peer (single row
    // blowing the 32MB line-framing budget) plus control-char injection into peer UIs/logs.
    // sanitizeText (single source, same as system.js/transport.js) strips control/RTL/bidi
    // chars and truncates. parseAnnounce re-runs buildAnnounceValue, so REMOTE announce
    // values are re-sanitized on this side too — one choke point covers both directions.
    base.attachTodoTitle = sanitizeText(String(attachTodoTitle || ''), 120)
  }
  return base
}

/** Write one announce value under this device's key (best-effort: never throws). */
function writeAnnounce (value) {
  if (!dbCall || !value || !value.deviceId) return false
  try {
    dbCall('setMeta', [keyFor(value.deviceId), JSON.stringify(value)])
    if (kickRound) kickRound('tomato-announce') // product decision: announces sync IMMEDIATELY
    return true
  } catch (e) {
    try { require('electron-log').warn('[TomatoAnnounce] write failed:', e && e.message) } catch { /* noop */ }
    return false
  }
}

/** Renderer entry (IPC 'tomato-run-announce'): compose + write from the live runtime fields. */
function announceFromRenderer (payload = {}) {
  if (!getIdentity) return false
  const { deviceId, deviceName } = getIdentity()
  return writeAnnounce(buildAnnounceValue({
    deviceId, deviceName,
    status: payload.status,
    startedAt: payload.startedAt,
    plannedSec: payload.plannedSec,
    attachTodoId: payload.attachTodoId,
    attachTodoTitle: payload.attachTodoTitle,
  }))
}

/** Quit hook: flip this device's announce to idle if a focus is mid-flight. Best-effort
 *  and synchronous (db.call) so it lands before the will-quit DB close; the peers' TTL
 *  rule covers a crash where this write never happens. */
function announceIdleForQuit () {
  if (!dbCall || !getIdentity) return false
  const { deviceId, deviceName } = getIdentity()
  let cur = null
  try { cur = parseAnnounce(dbCall('getMeta', keyFor(deviceId))) } catch { /* no prior announce */ }
  if (!cur || cur.status !== 'running') return false
  return writeAnnounce(buildAnnounceValue({ deviceId, deviceName, status: 'idle', startedAt: 0, plannedSec: 0 }))
}

/** Parse a stored announce value; malformed/foreign shapes resolve to null (trust boundary). */
function parseAnnounce (raw) {
  if (raw == null) return null
  let v = raw
  if (typeof raw === 'string') { try { v = JSON.parse(raw) } catch { return null } }
  if (!v || typeof v !== 'object') return null
  if (!v.deviceId || (v.status !== 'running' && v.status !== 'idle')) return null
  const out = buildAnnounceValue(v)
  return out.deviceId ? out : null
}

/**
 * Staleness rule (spec, unit-tested): an entry is dead when
 *   - startedAt + plannedSec < now (the focus has run out), or
 *   - the entry's age exceeds 2x plannedSec (peer died without writing idle; clock-skew
 *     headroom folded in). Idle entries and zero-duration entries are always stale.
 */
function isStaleAnnounce (v, now = Date.now()) {
  if (!v || v.status !== 'running' || !v.startedAt || !v.plannedSec) return true
  const plannedMs = v.plannedSec * 1000
  if (v.startedAt + plannedMs < now) return true
  return now - (v.at || v.startedAt) > plannedMs * STALE_AGE_FACTOR
}

/** Remaining seconds of a running announce (floor semantics, consistent with the local clock). */
function remainSecOfAnnounce (v, now = Date.now()) {
  if (!v || v.status !== 'running' || !v.startedAt || !v.plannedSec) return 0
  return Math.max(0, Math.floor((v.startedAt + v.plannedSec * 1000 - now) / 1000))
}

/**
 * Sync-apply hook: called by sync-apply.js AFTER an inbound tomatoRunAnnounce.* meta key
 * landed via setMeta. Fans out to subscribers (bootstrap -> renderer syncEvent). The
 * local device's own echoes (peer ack round-trips) are dropped by deviceId comparison.
 */
function emitRemoteAnnounce (key, rawValue) {
  if (!isAnnounceKey(key)) return
  const v = parseAnnounce(rawValue)
  if (!v) return
  let localId = null
  try { localId = getIdentity ? getIdentity().deviceId : null } catch { /* not initialized */ }
  if (localId && v.deviceId === localId) return
  for (const fn of [...remoteListeners]) {
    try { fn(v) } catch (e) { try { require('electron-log').warn('[TomatoAnnounce] listener failed:', e && e.message) } catch { /* noop */ } }
  }
}

/** Subscribe to remotely-applied announces; returns an unsubscribe function. */
function onRemoteAnnounce (fn) {
  if (typeof fn !== 'function') return () => {}
  remoteListeners.add(fn)
  return () => remoteListeners.delete(fn)
}

/**
 * Startup snapshot for the renderer: every currently-stored announce (running or idle —
 * the renderer filters staleness). db.js has no meta list op (size ratchet), so the keys
 * are enumerated from their oplog pointers (one paged scan) and read via getMeta.
 *
 * P2 2026-09-20: the full oplog re-scan ran on EVERY IPC call while the oplog only ever grows.
 * The pointer enumeration is now cached behind an oplog-seq watermark: re-scan only the NEW
 * seqs (usually zero rows) and reuse the deviceId map. Values are still read fresh via
 * getMeta per call (cheap KV reads, always current). The cache is per-process memory only,
 * so a node/DB restart simply rebuilds it from seq 0 — correctness is unaffected.
 */
let announceCache = { watermark: 0, ids: new Map() } // deviceId -> latest pointer ts
function listAnnounces () {
  if (!dbCall) return []
  try {
    let since = announceCache.watermark
    for (let i = 0; i < 100; i++) {
      const rows = dbCall('syncOplogSince', { sinceSeq: since, limit: 10000 }) || []
      for (const r of rows) {
        if (r.entity === 'meta' && isAnnounceKey(r.entityId)) {
          const id = String(r.entityId).slice(KEY_PREFIX.length)
          if (r.ts > (announceCache.ids.get(id) || 0)) announceCache.ids.set(id, r.ts)
        }
      }
      if (rows.length < 10000) {
        since = rows.length ? rows[rows.length - 1].seq : since
        break
      }
      since = rows[rows.length - 1].seq
    }
    announceCache.watermark = since
  } catch (e) {
    try { require('electron-log').warn('[TomatoAnnounce] list failed:', e && e.message) } catch { /* noop */ }
    return []
  }
  const out = []
  for (const id of announceCache.ids.keys()) {
    try {
      const v = parseAnnounce(dbCall('getMeta', keyFor(id)))
      if (v) out.push(v)
      // The meta row is gone (device unpaired / key evicted): drop the id from the pointer
      // cache too — otherwise every later poll keeps issuing a getMeta for a dead key forever.
      else announceCache.ids.delete(id)
    } catch { /* individual read failure: skip the entry (id kept, retried next poll) */ }
  }
  return out
}

/** Test-only: reset injected deps + listeners (production never calls this). */
function __reset () {
  dbCall = null; getIdentity = null; kickRound = null; remoteListeners.clear()
  announceCache = { watermark: 0, ids: new Map() }
}

module.exports = {
  KEY_PREFIX,
  STALE_AGE_FACTOR,
  init,
  keyFor,
  isAnnounceKey,
  buildAnnounceValue,
  writeAnnounce,
  announceFromRenderer,
  announceIdleForQuit,
  parseAnnounce,
  isStaleAnnounce,
  remainSecOfAnnounce,
  emitRemoteAnnounce,
  onRemoteAnnounce,
  listAnnounces,
  __reset,
}
