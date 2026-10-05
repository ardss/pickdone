/** Shared guard/helpers for IPC handler modules (pure relocation from index.js registerIpc). */
const fs = require('fs')
const path = require('path')
const log = require('electron-log')
require('../log-isolation') // test isolation: redirect electron-log file transport into TODO_DB_DIR/TODO_USER_DATA_DIR

/** Dangerous-channel guard: only the main window may call (lock-screen/float/quick-add and all other renderer windows are rejected) */
function makeAssertMainWindow (getMainWindow) {
  return (e) => {
    const w = getMainWindow()
    if (!w || e.sender !== w.webContents) {
      log.warn('[IPC] 拒绝非主窗调用危险通道, sender:', e.sender.id)
      throw new Error('forbidden: main window only')
    }
  }
}

/** Adversarial-review convergence (2026-09-25 ④): boolean twin of makeAssertMainWindow — "is this
 *  IPC event's sender the main window's webContents". Single source for the ownership test so the
 *  throw-style and boolean-style gates cannot drift (destroyed-window safe like the throw twin). */
function makeSenderIsMain (getMainWindow) {
  return (e) => {
    const w = getMainWindow()
    return !!(w && !w.isDestroyed() && e && e.sender === w.webContents)
  }
}

/** D6 P2 (2026-09-21): key classifier for the command-bus 'ls-mirror' fanout hook. The hook must
 *  decide "is this commit machine-local (kick no sync round)" from the payload, and payloads are
 *  shape-polymorphic across manifest commands:
 *    - single row objects:      { key, ... }                       → payload.key
 *    - row-list commands:       settingsRowPutMany / upsertMany …  → payload[0].key (per-element!)
 *    - pair/string arrays:      setMeta ['k','v'], string-key list → payload[0] IS the key
 *    - bare string payloads:    meta.delete 'someKey'              → the string itself
 *  The old `Array.isArray(payload) ? payload[0] : payload.key` classified setting.putMany's row
 *  OBJECT as the key (never local → machine-local writes kicked pointless sync rounds) and saw
 *  undefined for string payloads. Pure: returns the key candidate or undefined. */
function classifyCommitKey (payload) {
  if (typeof payload === 'string') return payload
  if (Array.isArray(payload)) {
    if (!payload.length) return undefined
    const first = payload[0]
    if (first && typeof first === 'object' && !Array.isArray(first)) return first.key
    return first
  }
  if (payload && typeof payload === 'object') return payload.key
  return undefined
}

/** Arch review 2026-09-22 rec #5 (ls-mirror observability): a FAILED notifySyncChange kick
 * must not be lost silently — a lost kick means the change never reaches peers until some
 * later write happens to kick again. makeSyncKick wraps the notify so a throwing kick is
 * COUNTED, DEFERRED, and retried ONE-SHOT: on the next kick (re-kick on next commit) and via
 * a short timer (timerMs, unref'd so it never holds the process open). The retry slot holds
 * the OLDEST lost op — a newer op is dropped in favor of it only when the slot retry also
 * fails (still bounded: exactly one pending op, one timer, one next-commit retry).
 * Returns { kick, deferredCount } for unit tests. */
function makeSyncKick (notify, { timerMs = 750, setTimeout: st = setTimeout, clearTimeout: ct = clearTimeout } = {}) {
  let deferred = null // oldest lost op awaiting its one-shot retry
  let timer = null
  let deferredCount = 0
  const attempt = op => {
    try { notify(op); return true } catch { return false }
  }
  const retry = () => {
    timer = null
    if (deferred == null) return
    const op = deferred
    deferred = null
    if (!attempt(op)) requeue(op) // still failing: re-arm (bounded: one slot)
  }
  const requeue = op => {
    deferredCount++
    if (deferred == null) deferred = op // keep the OLDEST lost kick; newer losses only count
    if (!timer) timer = st(retry, timerMs)
    if (timer && typeof timer.unref === 'function') timer.unref()
  }
  return {
    kick (op) {
      if (deferred != null) retry() // re-kick the lost op on the next commit first
      if (!attempt(op)) requeue(op)
    },
    get deferredCount () { return deferredCount },
  }
}

/** Ownership test for attachment filenames (P2 2026-09-17). saveAttachment names files
 *  `${taskId}_${Date.now()}_${name}`, so a bare startsWith(taskId + '_') let a task whose id is a
 *  prefix of another id ('a' vs 'a_b') delete the other task's files. The segment right after the
 *  id must be the all-digit timestamp: 'a_b_1.png' fails for id 'a' ('b' is not digits) while
 *  'a_173…_x.png' matches. Exported for unit tests. */
// D3 (2026-09-24): implementation moved to the electron-free domain module
// src/main/attachment-ownership.js (the CLI requires it without dragging electron-log in);
// re-exported here so every existing consumer (handlers/*, tests) keeps its import path.
const { ownsAttachmentFile } = require('../attachment-ownership')

/** Purge disk attachments after hard delete (filename prefix = taskId_, same rule as saveAttachment): warn-only on failure, never blocking.
 *  Lifecycle (2026-10-02): after the bulk unlink the device-local alias map is pruned — entries
 *  whose target file this purge just removed must die with it, or they keep resolving the dead
 *  logical key to a missing file forever (leak + blocks the missing-file re-pull). */
function purgeAttachmentFiles (attachDir, ids) {
  if (!ids || !ids.length) return
  try {
    const dir = attachDir()
    for (const f of fs.readdirSync(dir)) {
      if (ids.some(id => ownsAttachmentFile(f, id))) {
        try { fs.unlinkSync(path.join(dir, f)) } catch (err) { log.warn('[Purge] 附件删除失败:', f, err.message) }
      }
    }
    try { require('../attachments').pruneMissingAliases() } catch { /* alias prune is best-effort */ }
  } catch (err) { log.warn('[Purge] 附件目录遍历失败:', err.message) }
}

/** Pure decision for the startup meta GC (extracted 2026-09-19 from index.js for unit testing —
 *  the P1 fix itself is the `deleted: 0` filter at the getAll call site in index.js, so the
 *  deleted/live boundary stays observable here): given meta keys, live categories and todo rows,
 *  returns the orphan keys to delete. A repeatId referenced only by a recycle-bin row anchors its
 *  rule ONLY if the caller passes deleted rows in — index.js passes `deleted: 0`, so deleted tasks
 *  never keep repeatRule meta alive. Pure: returns keys, never performs IO.
 *  M-11 (2026-09-20): per-task tomato estimate keys (`tomatoEstimateState:<taskId>`) are GC'd too
 *  — the X2 split created one meta row per task but nothing ever removed them, so purged tasks
 *  leaked their keys forever. A key whose taskId is absent from the live todos set is dead.
 *  D15-B5 (2026-10-03): `projectDocs:<catId>` follows the projectDeadline/projectStatus lifecycle —
 *  a purged category's documents row can never be read again.
 *  D15-B6 (2026-10-03): `catFiltersBak` is bounded. The renderer stamps its keys
 *  `catFiltersBak.<deletedAt>.<id>` (category.js backupDoomedFilters), so age is decidable from the
 *  key: past the recover window (the same 30-day fallback the tombstone expiry uses) the filters
 *  can no longer be restored by recover and the row is dead. Legacy unstamped keys
 *  (`catFiltersBak.<id>` — the CLI twin's shape, and pre-fix renderer backups) have an unknowable
 *  age and are conservatively kept UNLESS the id is live again (a recovered category deletes its
 *  own backup in recover; a live id with a leftover backup is a stale re-created-id orphan). */
const CAT_FILTERS_BAK_RETENTION_MS = 30 * 86400000
function computeMetaGc (metaKeys, categories, todos, opts = {}) {
  const now = Number(opts.now) || Date.now()
  const retentionMs = Number(opts.catFiltersBakRetentionMs) || CAT_FILTERS_BAK_RETENTION_MS
  const live = new Set((categories || []).map(c => String(c.id || c.categoryId)))
  // D22 (P3): repeatRule keys stay keyed to LIVE rows only (deliberate P1 decision 2026-09-19 —
  // a rule referenced only by recycle-bin rows is dead) — hence the deleted filter here.
  const liveRids = new Set((todos || []).filter(t => !t.deleted).map(t => t.repeatId).filter(Boolean))
  // D22 (P3): per-TASK meta families (tomatoEstimateState / planChipsSnapshot / snowDedup) must
  // survive while the row is still restorable from the recycle bin: a tombstoned row is one
  // restore click away from being live again, and restore never reseeds its estimate. The old
  // caller fed getAll({deleted: 0}) only, so every startup wiped the estimate of every binned
  // row. Tombstoned ids therefore join liveTaskIds (they physically die — and their keys with
  // them — only at purgeRecycleBin/hardDelete, which now cascade these keys).
  const liveTaskIds = new Set((todos || []).map(t => String(t.taskId)))
  const dead = []
  for (const k of metaKeys || []) {
    let m = k.match(/^repeatRule:(.+)$/)
    if (m && !liveRids.has(m[1])) { dead.push(k); continue }
    m = k.match(/^tomatoEstimateState:(.+)$/)
    if (m && !liveTaskIds.has(m[1])) { dead.push(k); continue }
    // D11 finding 5: the two orphan families the startup backstop never covered — per-delete
    // hooks exist (db-meta-gc.cjs deleteChipsSnapshotKeysFor / deleteSnowDedupKeysFor) but keys
    // orphaned BEFORE those hooks landed (or via any un-instrumented path) leaked forever.
    // Same lifecycle rule as tomatoEstimateState above: the owning task id is gone from the live
    // set → the key can never be read again.
    //   - planChipsSnapshot:<taskId> — the renderer's per-task chip restore snapshot.
    //   - snowDedup:<taskId>:<dedupKey> — the bumpSnow idempotency fence (one row per focus
    //     session; written once, read only when that task bumps again).
    m = k.match(/^planChipsSnapshot:(.+)$/)
    if (m && !liveTaskIds.has(m[1])) { dead.push(k); continue }
    m = k.match(/^snowDedup:(.+?):/)
    if (m && !liveTaskIds.has(m[1])) { dead.push(k); continue }
    m = k.match(/^(?:projectDeadline|projectMilestones):(.+)$/)
    if (m && !live.has(m[1])) dead.push(k)
    // D10 (2026-09-27): per-category project fields follow the same lifecycle rule as
    // projectDeadline/projectMilestones above — a purged category leaves its status/flag rows dead.
    m = k.match(/^projectStatus:(.+)$/)
    if (m && !live.has(m[1])) { dead.push(k); continue }
    m = k.match(/^projectCategoryFlag:(.+)$/)
    if (m && !live.has(m[1])) { dead.push(k); continue }
    // D15-B5: project documents die with their category, same rule as projectStatus above.
    m = k.match(/^projectDocs:(.+)$/)
    if (m && !live.has(m[1])) { dead.push(k); continue }
    // D15-B6: stamped `catFiltersBak.<deletedAt>.<id>` — bounded by the recover window; the
    // unstamped legacy shape is GC'd only when its id is live again (stale recovered/re-created
    // leftover — recover itself deletes the backup it consumed).
    m = k.match(/^catFiltersBak\.(\d+)\.(\d+)$/)
    if (m) { if (now - Number(m[1]) > retentionMs) dead.push(k); continue }
    m = k.match(/^catFiltersBak\.(.+)$/)
    if (m && live.has(m[1])) { dead.push(k); continue }
    // D10 (2026-09-27): `catProjectMetaBak.pending.<id>` is a bracketed softDelete→rename roundtrip
    // crash marker — the roundtrip either completed or never started, and this GC runs at startup
    // before any NEW softDelete can mint a marker, so every pending marker is dead. The NON-pending
    // `catProjectMetaBak.<id>` is deliberately left alone: it anchors the recovery entry of
    // soft-deleted categories, which a live-only category set cannot see.
    if (/^catProjectMetaBak\.pending\./.test(k)) { dead.push(k); continue }
    // D19-DOM1 (2026-10-02): tomato run-announce family rule. `tomatoRunAnnounce.<deviceId>`
    // rows are written per paired device and propagated via the meta entity; a device that is
    // unpaired elsewhere (or whose pairing was removed without the announce-delete hook firing)
    // left its row forever. When the caller supplies `pairedDeviceIds`, a row whose deviceId is
    // neither paired nor THIS device is unreadable garbage → GC-able. The rule is INERT when the
    // option is omitted (legacy callers/tests, or a paired-table read failure at the call site):
    // without a trustworthy paired set nothing is deleted.
    m = k.match(/^tomatoRunAnnounce\.(.+)$/)
    if (m && opts.pairedDeviceIds) {
      const id = m[1]
      const paired = opts.pairedDeviceIds instanceof Set ? opts.pairedDeviceIds : new Set(opts.pairedDeviceIds)
      if (!paired.has(id) && id !== opts.ownDeviceId) dead.push(k)
      continue
    }
  }
  return dead
}

/** D7 (2026-09-22, main-ipc-1): pure key filter for 'notify-settings-updated' config writes.
 *  The float window is a legitimate writer on this channel (its white-noise choice rides it),
 *  but a TRAPPED float window must not be able to: disable the security lock
 *  ({enableSecurityLock:false} → isLocked() reads config in real time, the lock silently dies on
 *  next launch), swap the lock password/question, re-register global shortcuts
 *  (shortcutKeySettings), flip the OS login item (runWhenComputerStart) or bump schemaV past what
 *  this build understands. The main window keeps its full surface (the settings page legitimately
 *  toggles enableSecurityLock / shortcutKeySettings / runWhenComputerStart). schemaV plus the
 *  prototype-pollution trio are stripped for EVERY sender. Pure: returns a new object, never the
 *  input. Exported for unit tests. */
const FLOAT_FORBIDDEN_SETTINGS_KEYS = new Set([
  'enableSecurityLock', 'securityLockPassword', 'securityLockQuestion',
  'shortcutKeySettings', 'runWhenComputerStart'
])
function stripForbiddenSettingsKeys (patch, { float } = {}) {
  const clean = { ...(patch && typeof patch === 'object' ? patch : {}) }
  delete clean.schemaV
  delete clean.constructor
  delete clean.prototype
  if (float) for (const k of FLOAT_FORBIDDEN_SETTINGS_KEYS) delete clean[k]
  return clean
}

/** D10 (2026-09-27): tomatoLiveText freshness lease. The renderer pushes the tray countdown
 *  text once per second; when the main-window renderer dies mid-pomodoro nothing clears the
 *  last text, so quitFromTray's "focus in progress" confirm fired on EVERY quit forever.
 *  The text is now a lease: live only while a push arrived within TTL_MS (10s). Pure. */
const TOMATO_LIVE_TTL_MS = 10_000
function isLiveTextFresh (text, lastUpdateAt, now = Date.now(), ttlMs = TOMATO_LIVE_TTL_MS) {
  if (!String(text || '').trim()) return false
  if (!Number.isFinite(lastUpdateAt) || lastUpdateAt <= 0) return false
  return now - lastUpdateAt < ttlMs
}

/** D11 finding 12-windows: shell.openExternal returns a PROMISE — the `try { shell.openExternal(u) }
 *  catch {}` pattern cannot catch an async rejection, and the fire-and-forget calls produced an
 *  UNHANDLED REJECTION in the main process on every blocked/failed open (window-open handler,
 *  child navigation guard, will-navigate XSS guard). Single helper: http(s)-gated, rejection-
 *  logged, never throws. Pure control flow over the injected shell/logger — unit-testable. */
function openExternalSafely (shell, url, logger = log) {
  const u = String(url || '')
  if (!/^https?:/i.test(u)) return false
  try {
    const p = shell.openExternal(u)
    if (p && typeof p.catch === 'function') {
      p.catch(err => { try { (logger || console).warn('[Window] openExternal failed:', u, err && err.message) } catch { /* logging is best-effort */ } })
    }
    return true
  } catch (err) {
    try { (logger || console).warn('[Window] openExternal threw:', u, err && err.message) } catch { /* best-effort */ }
    return false
  }
}

/** D10 (2026-09-27): renderer crash relaunch policy. The in-process crashReloadCount resets on
 *  did-finish-load AND on every app.relaunch() (fresh process ⇒ 0 again), so a renderer crashing
 *  deterministically at startup looped crash→3 reloads→relaunch forever. The relaunch branch is
 *  now gated by a counter persisted across processes (windows.js marker file) and cleared by a
 *  60s post-load health window: past the cap the app gives up and shows a fatal-error dialog
 *  instead of spawning relaunch storm after relaunch storm. Pure. */
const CRASH_RELAUNCH_CAP = 3
function crashRelaunchDecision (persistedRelaunchCount, { cap = CRASH_RELAUNCH_CAP } = {}) {
  return Number(persistedRelaunchCount) >= cap ? 'give-up' : 'relaunch'
}

module.exports = { makeAssertMainWindow, makeSenderIsMain, purgeAttachmentFiles, ownsAttachmentFile, computeMetaGc, classifyCommitKey, makeSyncKick, stripForbiddenSettingsKeys, FLOAT_FORBIDDEN_SETTINGS_KEYS, isLiveTextFresh, TOMATO_LIVE_TTL_MS, crashRelaunchDecision, CRASH_RELAUNCH_CAP, openExternalSafely }
