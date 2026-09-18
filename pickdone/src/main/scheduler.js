/**
 * Reminder scheduler — native setTimeout one-shot timers, rebuilt from the DB after restart
 * Semantics: reminder_time is minute-precise; "ignore after today" is filtered renderer-side by ignoreReminder's date.
 * Multiple reminders: a task can carry reminderOffsets (minute offsets, negative = earlier, relative to the main reminder remindAt);
 * scheduling expands [main reminder, ...offset times]; job key `taskId:offset`, offsets are inherited automatically across repeat renewals.
 * Note: node-schedule was used early on, but only one-shot absolute times are scheduled here, so native setTimeout + overflow rescheduling suffices.
 */
const { Notification } = require('electron')
const i18nM = require('./i18n')
const path = require('path')
const log = require('electron-log')

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
    const firstKey = firedReminders.keys().next().value
    if (firstKey !== undefined) firedReminders.delete(firstKey)
  }
  firedReminders.set(key, { ts: Date.now(), written: false })
  schedulePersistFired()
}
let _persistTimer = null
function schedulePersistFired () {
  if (_persistTimer) return
  _persistTimer = setTimeout(() => { flushFiredNow() }, 60_000)
  if (_persistTimer && _persistTimer.unref) _persistTimer.unref()
}
/** Persist pending fired reminders immediately (called on quit: quitting within the 60s debounce window would resend reminders after restart) */
function flushFiredNow () {
  if (_persistTimer) { clearTimeout(_persistTimer); _persistTimer = null }
  if (!firedReminders.size) return
  const entries = []
  for (const [k, v] of firedReminders) entries.push([k, v.ts])
  try {
    const db = require('./db.js')
    if (typeof db.call === 'function') {
      const packed = entries.map(([k, ts]) => `${k}|${ts}`).join('\x1f')
      db.call('setMeta', [FIRED_META_KEY, packed])
      for (const [, v] of firedReminders) if (v) v.written = true
    }
  } catch (e) { /* silent when db is unavailable; the in-process LRU still works */ }
}
/** Restore firedReminders from meta at startup, so already-fired reminders are not re-fired by the catch-up path after restart */
function loadFiredFromMeta (db) {
  try {
    const raw = db.call('getMeta', FIRED_META_KEY)
    if (!raw || typeof raw !== 'string') return
    for (const pair of String(raw).split('\x1f')) {
      const [k, ts] = pair.split('|')
      if (k && ts && !firedReminders.has(k)) firedReminders.set(k, { ts: parseInt(ts, 10) || Date.now(), written: true })
    }
  } catch (e) { /* silent on corrupted meta */ }
}

let dingFile = null

function setSoundFile (f) { dingFile = f }

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
      title: clean((offset ? offsetLabel(offset) : '') + (todo.taskContent || '')).slice(0, 60) || i18nM.mt('todoRemindTitle'),
      body: clean(todo.taskDescribe).slice(0, 140) || i18nM.mt('todoRemindBody'),
      icon: path.join(__dirname, '../../assets/icon.png'),
      silent: true
    })
    n.on('click', () => {
      const win = require('./window-ref').getMainWindow()
      if (win) { win.show(); win.focus() }
    })
    n.show()
    // Notification sound
    const { sound } = require('./notify-sound')
    if (sound && dingFile) sound(dingFile)
    log.info('[Reminder] 已触发提醒:', todo.taskId, offset || 0, todo.taskContent)
  } catch (e) {
    log.error('[Reminder] 触发失败', e)
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
    else { markFired(key); fireImpl(todo, offset) }
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
 *  own scheduled timers and are deduped by firedReminders), so a rebuild is a no-op. */
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
  } catch { /* read failure treated as first run */ }
  const todos = db.queryTodos({ deleted: 0, orderBy: 'remindAt ASC' })
  // Edge-trigger: unchanged reminder inputs -> the current timers are still correct; skip the
  // teardown AND the watermark write (the write is what re-touches the DB and fed the watcher
  // loop on DESKTOP). First run always rebuilds (lastRebuildFingerprint === null).
  const fingerprint = rebuildFingerprint(todos)
  if (lastRebuildFingerprint !== null && fingerprint === lastRebuildFingerprint) return
  lastRebuildFingerprint = fingerprint
  for (const h of jobs.values()) clearTimeout(h)
  jobs.clear()
  // Restore firedReminders from meta (prevents "already-fired reminders being re-fired by the catch-up path after restart")
  loadFiredFromMeta(db)
  const now = Date.now()
  if (firstRun) { try { db.setMeta(['reminderLastSeenAt', String(now)]) } catch {} }
  let future = 0
  let missed = 0
  for (const t of todos) {
    if ((!t.reminderTime && !(t.reminderExtra || []).length) || t.complete) continue
    for (const [offset, ts] of reminderInstances(t)) {
      const key = t.taskId + ':' + (offset || 0)
      if (ts > now) {
        scheduleTask(t, offset, ts)
        future++
      } else if (!firstRun && ts > lastSeen && !firedReminders.has(key)) {
        markFired(key)
        fireImpl(t, offset) // reminder that came due while the app was closed: fire immediately (each one only once)
        missed++
      }
    }
  }
  try { db.setMeta(['reminderLastSeenAt', String(now)]) } catch { /* watermark write failure only affects catch-up dedup */ }
  log.info('[Reminder] scheduler rebuild done: %d future reminders, %d missed reminders re-fired', future, missed)
}

function scheduleOne (todo) {
  cancel(todo.taskId)
  if ((!todo.reminderTime && !(todo.reminderExtra || []).length) || todo.delete || todo.complete) return
  if (todo.reminderTime && todo.reminderTime <= Date.now() && !(todo.reminderExtra || []).length) return
  for (const [offset, ts] of reminderInstances(todo)) scheduleTask(todo, offset, ts)
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
  reminderInstances, needsCatchUp,
  setFireForTest,
  _jobs: jobs,
  _fired: firedReminders,
  _markFired: markFired,
  _clearStateForTest () { for (const h of jobs.values()) clearTimeout(h); jobs.clear(); firedReminders.clear(); lastRebuildFingerprint = null }
}
