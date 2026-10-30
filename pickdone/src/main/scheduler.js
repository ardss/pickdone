/**
 * Reminder scheduler — native setTimeout one-shot timers, rebuilt from the DB after restart
 * Semantics: reminder_time is minute-precise; past-due instances are NOT filtered by a renderer flag —
 * they fire exactly once through the firedReminders watermark (markFired/loadFiredFromMeta below).
 * Multiple reminders: a task can carry reminderOffsets (minute offsets, negative = earlier, relative to the main reminder remindAt);
 * scheduling expands [main reminder, ...offset times]; job key `taskId:offset`, offsets are inherited automatically across repeat renewals.
 * Note: node-schedule was used early on, but only one-shot absolute times are scheduled here, so native setTimeout + overflow rescheduling suffices.
 */
const { Notification } = require('electron')
const i18nM = require('./i18n')
const path = require('path')
const log = require('electron-log')
require('./log-isolation') // test isolation: redirect electron-log file transport into TODO_DB_DIR/TODO_USER_DATA_DIR

const MAX_TIMEOUT = 2 ** 31 - 1 // Node's per-setTimeout cap (~24.8 days); longer reminders are rescheduled in segments
const jobs = new Map() // `${taskId}:${offset}` -> timeout handle
// LRU set: firedReminders uses a Map to preserve insertion order for LRU eviction (prevents memory bloat on long-running processes);
// it is also batch-persisted to meta every 60s (key|firedTs joined by \x1f), restored after restart by loadFiredFromMeta —
// preventing the double-fire bug where "after a crash the watermark causes the catch-up path to re-fire the same instant" or "exceeding 1000 clears the set so already-fired reminders get re-fired".
const FIRED_META_KEY = 'firedReminders:'
const FIRED_MAX = 2000
const firedReminders = new Map() // key -> {ts, written}
function markFired (key) {
  if (firedReminders.size >= FIRED_MAX) {
    // D6 P2 (2026-09-21): the old eviction took the OLDEST entry regardless of its written
    // flag. Under sustained reminder traffic the 60s debounced flush means up to a minute of
    // unwritten watermarks sits at the map head — evicting one of those dropped a fired
    // reminder's watermark on the floor and it re-fired after restart (exactly the bug the
    // LRU was built to prevent). Partition the eviction: the oldest WRITTEN entry goes first
    // (its watermark is safely persisted, so losing the in-memory entry is harmless); only
    // when EVERY entry is still unwritten (pathological all-pending burst) fall back to the
    // oldest entry — the memory bound must still hold.
    let victim
    for (const [k, v] of firedReminders) {
      if (v && v.written) { victim = k; break }
    }
    if (victim === undefined) {
      // R3-stability (2026-09-26): all-unwritten fallback — flush FIRST so the victim's watermark
      // (and every other pending one) is persisted before the eviction; deleting an unwritten
      // entry here used to drop that watermark on the floor and re-fire it after restart.
      // D21 (P3 2026-10-02): coalesce the flush. flushFiredNow() is a synchronous SQLite write;
      // inside markFired it ran PER EVICTION, so a catch-up burst (every reminder past-due after
      // sleep) with an all-unwritten map did one SQLite commit per markFired call.
      // M8B fix 5 (P3): D21 went too far — with a pending 60s/30s timer the eviction deleted an
      // UNWRITTEN watermark that the pending timer would only persist a minute later, and that
      // entry re-fired after a crash inside the window (exactly the loss the flush-first order
      // exists to prevent). flushFiredNow() already coalesces (clears the timer, single commit,
      // marks written); BOTH arms flush now — one extra SQLite commit per all-unwritten eviction
      // is the cost of not dropping the watermark on the floor.
      // M8B fix 5 intent kept: the pending timer must not defer the evicted watermark — both
      // cases flush, so the vacuous conditional collapses to a single unconditional call.
      flushFiredNow()
      // C9 (P3 2026-10-02): the bound must hold PER ADMISSION. The old code skipped the eviction
      // when the flush failed ("let the map exceed FIRED_MAX by one; it self-heals") — under a
      // SUSTAINED persist failure every further markFired repeated that path and the map grew
      // without bound (the LRU was suspended exactly when the process was struggling). Evict the
      // oldest entry regardless; if it was still unwritten, log the potential re-fire (the
      // fire-and-forget-of-one tradeoff) — the memory ceiling is never traded away.
      victim = firedReminders.keys().next().value
      const v = victim !== undefined ? firedReminders.get(victim) : null
      if (v && !v.written) log.warn('[Scheduler] persist failing: evicting UNWRITTEN fired-reminder watermark (may re-fire after restart):', victim)
    }
    if (victim !== undefined) firedReminders.delete(victim)
  }
  firedReminders.set(key, { ts: Date.now(), written: false })
  schedulePersistFired()
}
let _persistTimer = null
// M-10 (2026-09-20): a failed flushFiredNow used to silently drop the persist — already-fired
// reminders then re-fired after restart. On setMeta failure: log + re-arm a 30s retry, max 3.
let _persistRetries = 0
function schedulePersistFired () {
  if (_persistTimer) return
  _persistTimer = setTimeout(() => { flushFiredNow() }, 60_000)
  if (_persistTimer && _persistTimer.unref) _persistTimer.unref()
}
/** Persist pending fired reminders immediately (called on quit: quitting within the 60s debounce window would resend reminders after restart) */
/** D18 (2026-10-02) wire-format helpers (pure, unit-testable): the old `${key}|${ts}` packing
 *  joined the key to its timestamp with '|', so a peer-controlled taskId CONTAINING '|' shifted
 *  the split on load — the entry silently split into garbage and the reminder re-fired. The
 *  format is now JSON; the read side keeps backward compatibility with the legacy packed blobs
 *  (payload not starting with '[' → legacy split parse, which also still tolerates the '|' the
 *  legacy format itself could not). */
function packFiredEntries (entries) { return JSON.stringify(entries) }
function parseFiredEntries (raw) {
  const s = String(raw || '')
  if (s.startsWith('[')) {
    try {
      const arr = JSON.parse(s)
      if (Array.isArray(arr)) return arr.filter(p => Array.isArray(p) && p.length === 2).map(([k, ts]) => [String(k), ts])
    } catch { /* fall through to legacy parse below */ }
  }
  const out = []
  for (const pair of s.split('\x1f')) {
    const i = pair.lastIndexOf('|') // legacy: split on the LAST '|' so keys containing '|' keep their tail intact
    if (i <= 0) continue
    out.push([pair.slice(0, i), pair.slice(i + 1)])
  }
  return out
}
function flushFiredNow () {
  if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null }
  if (!firedReminders.size) return
  const entries = []
  for (const [k, v] of firedReminders) entries.push([k, v.ts])
  try {
    const db = require('./db.js')
    if (typeof db.call === 'function') {
      const packed = packFiredEntries(entries)
      // Phase-2 command bus (docs/refactor-command-bus.md): the watermark persist commits through
      // meta.put like every other write. The key is machine-local (manifest localKeys), so the
      // 'ls-mirror' subscriber skips it — the watermark never kicked sync and still must not.
      require('./command-bus').commit('meta', 'put', [FIRED_META_KEY, packed], { preserveStamp: true })
      for (const [, v] of firedReminders) if (v) v.written = true
      _persistRetries = 0
    }
  } catch (e) {
    // M-10: log + bounded 30s retry backoff instead of the old silent drop; the in-process LRU
    // still dedupes meanwhile. After 3 failed retries give up (the next markFired re-arms the
    // 60s debounce anyway).
    log.warn('[Scheduler] fired-reminder persist failed, will retry:', e && e.message)
    if (_persistRetries < 3) {
      _persistRetries++
      _persistTimer = setTimeout(() => { flushFiredNow() }, 30_000)
      if (_persistTimer && _persistTimer.unref) _persistTimer.unref()
    }
  }
}
/** Restore firedReminders from meta at startup, so already-fired reminders are not re-fired by the catch-up path after restart.
 * r3 fix (2026-09-28): a corrupted timestamp used to fall back to Date.now() — the entry looked
 * "just fired", so the catch-up path silently swallowed that reminder FOREVER (single-sided
 * permanent loss with no trace). The tolerance direction is now the safe one: a corrupt entry is
 * DROPPED (worst case after restart = one re-fire by catch-up, which the LRU dedupes within a
 * run), never converted into a fake fresh watermark. */
function loadFiredFromMeta (db) {
  try {
    const raw = db.call('getMeta', FIRED_META_KEY)
    if (!raw || typeof raw !== 'string') return
    for (const [k, ts] of parseFiredEntries(raw)) {
      if (!k || !ts) { log.warn('[Scheduler] fired-reminder watermark: malformed entry dropped:', JSON.stringify(String(k) + '|' + String(ts)).slice(0, 80)); continue }
      const n = parseInt(ts, 10)
      if (!Number.isFinite(n) || n <= 0) {
        log.warn('[Scheduler] fired-reminder watermark: corrupt timestamp for ' + k + ' — entry dropped so catch-up can re-fire it')
        continue
      }
      if (!firedReminders.has(k)) firedReminders.set(k, { ts: n, written: true })
    }
  } catch (e) { log.warn('[Scheduler] fired-reminder watermark load failed (catch-up will re-fire as needed):', e && e.message) }
}

let dingFile = null

function setSoundFile (f) { dingFile = f }

// D10 (2026-09-27): lock-aware show entry, wired by index.js (setShowMainEntry(showMainOrLock)).
// The reminder notification click used to call win.show()/win.focus() DIRECTLY — clicking any
// reminder unlocked a locked app to its full contents, bypassing the security lock that every
// other entry point (tray click / second-instance / quick-add) honors.
let showMainEntry = null
function setShowMainEntry (fn) { showMainEntry = typeof fn === 'function' ? fn : null }
/** D6 (P2 2026-10-22): notification-click locate. Focusing alone left the user staring at
 *  whatever view was last open — the clicked task was nowhere in sight. After the focus path
 *  runs, push the taskId to the renderer over the same fire-and-forget webContents.send shape
 *  as 'shortcut-conflict' (preload wraps it with a disposer, onReminderOpenTask); the renderer
 *  routes to the task's view and opens the edit panel. The renderer additionally ignores the
 *  push while ui.isLocked (the lock-aware gate may have shown the lock screen, never the data). */
function pushOpenTask (taskId) {
  if (!taskId) return
  try {
    const win = require('./window-ref').getMainWindow()
    if (win && !win.isDestroyed()) win.webContents.send('reminder-open-task', { taskId: String(taskId) })
  } catch (e) { log.warn('[Reminder] open-task push failed:', e && e.message) }
}

/** Notification-click focus path (exported for unit tests): routes through the lock-aware
 *  showMainOrLock when wired; bare-window fallback only when index.js never wired it.
 *  D6 (P2 2026-10-22): optional taskId — after focusing, pushOpenTask hands it to the renderer. */
function focusMainFromNotification (taskId) {
  let shown = false
  if (showMainEntry) { try { showMainEntry(); shown = true } catch (e) { log.warn('[Reminder] showMainOrLock failed', e) } }
  if (!shown) {
    // M2b (P2 2026-10-23): the old bare fallback `win.show(); win.focus()` fired when the lock-aware
    // entry threw (or was never wired), and it bypassed the security lock — clicking a reminder on a
    // locked app revealed its full contents. The scheduler cannot probe the lock state here (index.js
    // wires only showMainOrLock via setShowMainEntry; the security-lock instance is module-private to
    // index.js), so the fallback now FAILS CLOSED: nothing is shown, the failure is logged, and the
    // renderer's ui.isLocked gate (see pushOpenTask) still covers the task-locate push.
    try { log.warn('[Reminder] show entry unavailable/failed — keeping the window hidden (lock-safe fallback)', taskId || '') } catch { /* logging is best-effort */ }
  }
  pushOpenTask(taskId)
}

/** Truncate by code points, not UTF-16 code units: slicing at a fixed index could split a
 *  surrogate pair (emoji etc.) into lone surrogates — mojibake in the OS notification. */
function clipText (v, max) {
  const s = String(v == null ? '' : v)
  const pts = Array.from(s)
  return pts.length > max ? pts.slice(0, max).join('') : s
}

/** B4 (daily 2026-09-25): notificationTimeoutInterval — the renderer settings key
 * (store/settings.js DEFAULT_SETTINGS, SettingsModal radio 30s/2min/5min, CLI-settable) had NO
 * main-process consumer: every Notification this process created used the OS default duration,
 * so the user's "notification display duration" choice was an orphan setting. Bounds/default
 * mirror shared/settings-manifest.mjs (min 30000 / max 300000 / default 300000); anything outside
 * the range (corrupt blob, junk from a degraded host) falls back to the declared default. */
const NOTIFY_TIMEOUT_DEFAULT = 300000
const NOTIFY_TIMEOUT_MIN = 30000
const NOTIFY_TIMEOUT_MAX = 300000
function timeoutFromInterval (raw) {
  const v = Number(raw)
  return Number.isFinite(v) && v >= NOTIFY_TIMEOUT_MIN && v <= NOTIFY_TIMEOUT_MAX ? v : NOTIFY_TIMEOUT_DEFAULT
}
/** Notification options honoring the setting. `timeout` (ms) is honored on Windows 7/8 and Linux;
 *  `timeoutType: 'default'` keeps OS-native dismissal where the OS owns toast duration (Win10+).
 *  db may be null in degraded hosts — the default duration applies. */
function notifyTimeoutOpts (db) {
  let raw = null
  try { raw = JSON.parse((db && db.call && db.call('getMeta', 'db.settingsState')) || 'null') } catch { /* degraded host: default duration */ }
  return { timeout: timeoutFromInterval(raw && raw.notificationTimeoutInterval), timeoutType: 'default' }
}
/** Same options, self-sourcing the app DB (for call sites without an injected db handle). */
function notifyTimeoutOptsForApp () { return notifyTimeoutOpts(require('./db.js')) }

/** Display prefix for offsets ("30 minutes early" etc.); 0 = main reminder with no prefix; 'x<ts>' = extra absolute reminder with no prefix */
function offsetLabel (offset) {
  if (!offset || (typeof offset === 'string' && offset[0] === 'x')) return ''
  const abs = Math.abs(offset)
  const unit = i18nM.mt(abs >= 1440 ? 'remindUnitDay' : abs >= 60 ? 'remindUnitHour' : 'remindUnitMin')
  const t = abs >= 1440 ? (abs / 1440) : abs >= 60 ? (abs / 60) : abs
  return i18nM.mt(offset > 0 ? 'remindOffsetLate' : 'remindOffsetEarly', { t, u: unit }) + ' · '
}

function fire (todo, offset) {
  try {
    // Strip control chars/RTL overrides + truncate: prevent line breaks from breaking notification layout and visual spoofing
    // eslint-disable-next-line no-control-regex -- control characters are exactly the target of this sanitization; the rule does not apply here
    const clean = v => require('./sanitize').stripDangerous(v)
    const n = new Notification({
      title: clipText(clean((offset ? offsetLabel(offset) : '') + (todo.taskContent || '')), 60) || i18nM.mt('todoRemindTitle'),
      body: clipText(clean(todo.taskDescribe), 140) || i18nM.mt('todoRemindBody'),
      icon: path.join(__dirname, '../../assets/icon.png'),
      silent: true,
      ...notifyTimeoutOptsForApp()
    })
    n.on('click', () => {
      // D10 (2026-09-27): route through the lock-aware gate — a locked app must not be revealed
      // by clicking a reminder notification (see focusMainFromNotification above).
      // D6 (P2 2026-10-22): the click now also carries the taskId so the renderer locates the task.
      focusMainFromNotification(todo.taskId)
    })
    // D22 symmetry (c-wave 2026-10-13, mirrors handlers/system.js:64-69): an OS-level delivery
    // failure surfaces as an UNHANDLED 'failed' event on the Notification object — under
    // Electron's unhandled-event policy that can crash the main process. Attach the listener
    // BEFORE show(); the failure is logged (warn, not error — a missed toast is degraded, not
    // fatal) and flips the local result so a synchronously-detected failure returns false and
    // does not consume the catch-up watermark. (Electron fires 'failed' asynchronously in
    // production — there the listener's job is crash prevention; the watermark stays optimistic,
    // same contract as the IPC notification channel.)
    let deliveryFailed = false
    if (typeof n.on === 'function') {
      n.on('failed', (err) => {
        deliveryFailed = true
        try { log.warn('[Reminder] delivery failed:', todo.taskId, err && (err.message || err)) } catch { /* logging is best-effort */ }
      })
    }
    n.show()
    // Notification sound — M2b (P3 2026-10-23): a synchronously-detected delivery failure must not
    // play the chime (notify without notification). An ASYNCHRONOUS 'failed' (the production shape)
    // lands after this line has already run: the sound cannot be un-played — accepted tradeoff,
    // the watermark/catch-up semantics above still treat it as failed.
    const { sound } = require('./notify-sound')
    if (!deliveryFailed && sound && dingFile) sound(dingFile)
    // F-B8 (dw wave 3): task titles no longer go to main.log (plaintext side channel — same nature
    // as the index.js plain-bak cleanup); the taskId is enough to correlate a reminder with its task.
    log.info('[Reminder] fired:', todo.taskId, offset || 0)
    // D22: fire result gates the watermark (see the call sites in scheduleTask/reloadAll);
    // a 'failed' event observed before this point reports false so the reminder stays
    // catch-up-eligible and retries on the next reloadAll.
    return !deliveryFailed
  } catch (e) {
    log.error('[Reminder] fire failed', e)
    return false // D22: a failed fire must NOT consume the catch-up watermark — the next reloadAll retries
  }
}

// Fire exit point is injectable (unit tests replace it with a spy, no electron Notification needed); production always uses the real fire
let fireImpl = fire
function setFireForTest (fn) { fireImpl = fn || fire }

function cancel (taskId) {
  for (const [k, h] of jobs) {
    if (k === taskId || k.startsWith(taskId + ':')) { clearTimeout(h); jobs.delete(k) }
  }
}

/** Unified scheduling for the main reminder plus all offset times (offset 0 = main reminder).
 *  Only future times are scheduled: delay<=0 always returns silently — the caller reloadAll only passes future times;
 *  already-past offsets passed by scheduleOne (e.g. attaching "1 day early" to tomorrow's task) should not pop a notification immediately,
 *  nor enter the catch-up window (reloadAll sets the watermark lastSeen=now, so past times are never re-fired). */
function scheduleTask (todo, offset, remindTs) {
  const delay = remindTs - Date.now()
  if (delay <= 0) return
  const key = todo.taskId + ':' + (offset || 0)
  const h = setTimeout(() => {
    jobs.delete(key)
    if (remindTs > Date.now()) scheduleTask(todo, offset, remindTs) // overflow segmentation: reschedule the remaining interval
    // Timer-triggered firings also enter the dedup set: otherwise the next write-triggered reloadAll would re-notify since the reminder satisfies the catch-up window (ts>lastSeen and unrecorded)
    // D22 (P3): the watermark is written only after fire SUCCEEDED (fireImpl !== false) — a failed
    // notification used to be watermarked first and never retried (the catch only logged).
    else { if (fireImpl(todo, offset) !== false) markFired(key) }
  }, Math.min(delay, MAX_TIMEOUT))
  if (h.unref) h.unref() // do not keep the process alive
  jobs.set(key, h)
}

/** All reminder times of a task: [[offset, ts], ...]; offsets cannot be anchored without a main reminder, so skip.
 *  Multiple reminders: extra absolute reminders (reminderExtra, independent of the main anchor) are also scheduled, with an x key prefix to avoid collisions */
function reminderInstances (t) {
  const out = []
  if (t.reminderTime) {
    out.push([0, t.reminderTime])
    for (const o of (t.reminderOffsets || [])) {
      const ts = t.reminderTime + o * 60000
      if (ts > 0) out.push([o, ts])
    }
  }
  for (const ts of (t.reminderExtra || [])) {
    if (Number.isFinite(ts) && ts > 0) out.push(['x' + ts, ts])
  }
  return out
}

/** Edge-trigger fingerprint of every reminder-bearing task (2026-09-18 DESKTOP incident: the
 *  external-write watcher kept kicking reloadAll with UNCHANGED reminder inputs — the rebuild
 *  wrote reminderLastSeenAt, which touched the DB again, feeding the watcher back — flooding
 *  the log ~800x with "0 future reminders"). When the reminder inputs are unchanged since the
 *  last rebuild, the live timers are still exactly right (runtime-due reminders fire via their
 *  own scheduled timers and are deduped by firedReminders), so a rebuild is a no-op.
 *  D22 (P1 pin): completion state is encoded BY PRESENCE — a task flipping complete drops its part
 *  (and an un-completed task regains it), so either direction of a complete flip changes the
 *  fingerprint and forces the teardown/rebuild that clears (or restores) the live timers. Exported
 *  for regression tests; do not weaken the `|| t.complete` skip. */
let lastRebuildFingerprint = null
function rebuildFingerprint (todos) {
  const parts = []
  for (const t of todos) {
    if ((!t.reminderTime && !(t.reminderExtra || []).length) || t.complete) continue
    parts.push(`${t.taskId}:${t.reminderTime || 0}:${(t.reminderOffsets || []).join(',')}:${(t.reminderExtra || []).join(',')}`)
  }
  return parts.join('|')
}

/** Full rebuild: iterate non-deleted/future tasks that have a reminder time.
 *  Missed catch-up: reminders that came due while the app was closed (last run's watermark < reminder time ≤ now) fire once immediately,
 *  watermark stored in meta as reminderLastSeenAt; completed tasks are neither re-fired nor scheduled. */
function reloadAll (db) {
  // P0 2026-09-19: the fingerprint check MUST run before any teardown. The previous order cleared
  // every live reminder timer, THEN computed the fingerprint and early-returned when unchanged —
  // every no-op rebuild killed all live future reminder timers (silent reminder loss until some
  // later input change rebuilt them). Now: read inputs -> fingerprint -> return untouched on a
  // no-op; only a real change tears jobs down and rebuilds.
  // Sharp-review fix: on first run (no watermark) do not catch up — prevents a one-time bombardment of historical reminders from old databases;
  // firedReminders dedups at runtime — write-triggered reloadAll will not re-notify already-fired reminders.
  let lastSeen = 0
  let firstRun = false
  try {
    const raw = db.getMeta('reminderLastSeenAt')
    if (raw == null) firstRun = true
    lastSeen = parseInt(raw || '0', 10) || 0
  } catch {
    // C4 (P1 2026-09-24): the comment claimed "read failure treated as first run" but the catch left
    // firstRun=false — a throwing getMeta (transient DB trouble) then made every historical reminder
    // past `lastSeen=0` look catchable and re-fire all at once. Actually set the flag.
    firstRun = true /* read failure treated as first run */
  }
  let todos
  try {
    todos = db.queryTodos({ deleted: 0, orderBy: 'remindAt ASC' })
  } catch (e) {
    // P2 2026-10-09: a transient DB read failure (e.g. SQLITE_BUSY at boot) used to propagate out
    // of reloadAll and, via index.js's whenReady chain, escalate to showErrorBox + process exit —
    // a reminder-rebuild read must never take the app down. Degrade to a warn and keep the
    // existing timers (teardown happens only below, after this point): the fingerprint is not
    // advanced, so the next write/watch tick retries the rebuild.
    log.warn('[Reminder] reloadAll: queryTodos failed; keeping existing timers this round:', e && e.message)
    return
  }
  // Edge-trigger: unchanged reminder inputs -> the current timers are still correct; skip the
  // teardown AND the watermark write (the write is what re-touches the DB and fed the watcher
  // loop on DESKTOP). First run always rebuilds (lastRebuildFingerprint === null).
  const fingerprint = rebuildFingerprint(todos)
  if (lastRebuildFingerprint !== null && fingerprint === lastRebuildFingerprint) return
  for (const h of jobs.values()) clearTimeout(h)
  jobs.clear()
  // Restore firedReminders from meta (prevents "already-fired reminders being re-fired by the catch-up path after restart")
  loadFiredFromMeta(db)
  const now = Date.now()
  if (firstRun) { try { db.setMeta(['reminderLastSeenAt', String(now)]) } catch {} }
  let future = 0
  let missed = 0
  // D22 (P3): a failed catch-up fire must not be swallowed by the rebuild watermark either —
  // lastSeen normally advances to `now`, which puts the reminder behind the catch-up window
  // forever. On any failure, roll the watermark back to just before the EARLIEST failed reminder
  // (already-fired ones stay deduped by firedReminders, so the retry cannot double-fire them).
  let earliestFailedTs = Infinity
  for (const t of todos) {
    if ((!t.reminderTime && !(t.reminderExtra || []).length) || t.complete) continue
    for (const [offset, ts] of reminderInstances(t)) {
      const key = t.taskId + ':' + (offset || 0)
      if (ts > now) {
        scheduleTask(t, offset, ts)
        future++
      } else if (firedReminders.has(key)) {
        // fired at runtime or caught up (the set is meta-persisted) — deduped, never re-fired
      } else if (!firstRun && (ts > lastSeen || (offset === 0 && Number(t.createTime || 0) > lastSeen))) {
        // D22 (P3): fire first, watermark only on success — a throwing notification path left the
        // old order (markFired before fire) permanently swallowing the reminder (no catch-up retry).
        // [J7 2026-10-22] born-past-due: the `ts > lastSeen` window alone can never cover a MAIN
        // reminder created already-due (CLI --reminder <past>, edit-panel past pick, peer sync) —
        // its due moment predates a frontier written before the row existed, so needsCatchUp said
        // "fire" while this loop said "already seen" and the reminder was swallowed forever.
        // Exemption: offset===0 rows CREATED after the frontier were never seen by any sweep —
        // fire once through the same fire-then-watermark path. Guardrails: offset/extras keep the
        // never-fire-past semantics (a degenerate past offset on a future anchor is an anchoring
        // artifact, see scheduleOne); createTime <= lastSeen (peer-synced history) stays swallowed
        // (D22 anti-bombardment); firstRun still skips everything; a failed fire still rolls the
        // frontier to ts-1 so the retry stays in-window.
        if (fireImpl(t, offset) !== false) markFired(key)
        else if (ts < earliestFailedTs) earliestFailedTs = ts
        missed++
      }
    }
  }
  try { db.setMeta(['reminderLastSeenAt', String(earliestFailedTs < Infinity ? Math.min(now, earliestFailedTs - 1) : now)]) } catch { /* watermark write failure only affects catch-up dedup */ }
  log.info('[Reminder] scheduler rebuild done: %d future reminders, %d missed reminders re-fired', future, missed)
  // d-wave fix (2026-10-14): advance the fingerprint ONLY on a fully-successful round. Pre-fix it
  // advanced before the catch-up loop, so a failed fire stranded the reminder: the next reloadAll
  // saw unchanged inputs and early-returned, retrying never. Keeping the OLD fingerprint on
  // failure forces the next rebuild to run again; firedReminders dedups the already-fired
  // instances, so the retry cannot double-fire (markFired semantics unchanged).
  if (earliestFailedTs === Infinity) lastRebuildFingerprint = fingerprint
}

function scheduleOne (todo) {
  cancel(todo.taskId)
  if ((!todo.reminderTime && !(todo.reminderExtra || []).length) || todo.delete || todo.complete) return
  // P2 2026-10-09: the old guard returned when the MAIN reminder was past and there were no
  // reminderExtra entries — but a reminderTime+offsets task with a PAST main anchor and a FUTURE
  // offset instance hit the return and the write-triggered fast path (handlers/todo.js upsert,
  // after cancel()) silently dropped every future offset reminder. Return only when EVERY
  // instance (main + offsets + extras, all expanded by reminderInstances) is already past;
  // scheduleTask itself no-ops past instances (delay <= 0), so scheduling them is harmless.
  const now = Date.now()
  const instances = reminderInstances(todo)
  if (instances.length && instances.every(([, ts]) => ts <= now)) return
  for (const [offset, ts] of instances) scheduleTask(todo, offset, ts)
}

/** P1 2026-09-19 (fast-path gate for handlers/todo.js): true only when the task has a PAST reminder
 *  instance that has NOT been recorded as fired — i.e. reloadAll's catch-up path (watermark +
 *  re-fire) is still needed for it. A past instance already in firedReminders (fired at runtime or
 *  caught up after restart; the set is meta-persisted) is fully deduped, so a single-task
 *  scheduleOne is sufficient and the full reloadAll (whole-table scan + all timers torn down) can
 *  be skipped. */
function needsCatchUp (todo, now = Date.now()) {
  if (!todo || todo.complete || todo.delete) return false
  for (const [offset, ts] of reminderInstances(todo)) {
    if (ts <= now && !firedReminders.has(todo.taskId + ':' + (offset || 0))) return true
  }
  return false
}

module.exports = {
  init: () => {}, reloadAll, scheduleOne, fire, setSoundFile, flushFiredNow,
  setShowMainEntry, focusMainFromNotification,
  reminderInstances, needsCatchUp, clipText, notifyTimeoutOpts, notifyTimeoutOptsForApp, timeoutFromInterval,
  rebuildFingerprint, // D22 2026-10-02 test surface: a complete flip must change the fingerprint
  setFireForTest,
  loadFiredFromMeta, // r3 2026-09-28 test surface: corrupt watermark entries are dropped, not faked fresh
  packFiredEntries, parseFiredEntries, // D18 2026-10-02 test surface: separator-safe watermark wire format
  _jobs: jobs,
  _fired: firedReminders,
  _markFired: markFired,
  _clearStateForTest () { for (const h of jobs.values()) clearTimeout(h); jobs.clear(); firedReminders.clear(); lastRebuildFingerprint = null }
}
