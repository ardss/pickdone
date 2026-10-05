/* Repeat-rules sub-module extracted from cli/lib.js (2026-09-27 size-ratchet split).
 * Factory-injected deps keep it decoupled from lib.js (no circular require), same pattern as lib-settings.cjs.
 * Repeat rules (meta repeatRule:<rid>; generation reuses the todo-core engine) + the shared renewal-instance constructor. */
module.exports = ({ open, commit, audit, CliError, dayjs, core, resolveTask, liveTasks, normKey, settingsDoc, chipsSnapshotForDelete, dayStartOf, clampEstimate, getEstimateOf, estimateKey }) => {
  /** F-B4 (dw wave 3): single constructor for CLI renewal instances — the done path (repeat renewal on
   *  complete) and repeatOn's future-instance expansion (expand) carried two ~40-line near-verbatim
   *  object literals. Behavior preserved exactly, including expand's historical estimate:0 (no silent
   *  behavior change; the done path keeps its live getEstimateOf readback). Sort keeps the legacy
   *  length-keyed bottom-insert convention (min-512 / empty-day 1024; see the inline note for why
   *  nextSort's own empty check is not used here). */
  function buildRenewalInstance (t, next, { estimate = 0, todoTime = next.todoTime, reminderTime, extra = {}, allRows = null } = {}) {
    const now = Date.now()
    // D22 (P3 perf, 2026-10-02): callers minting MANY instances in one pass (repeatOn's expansion
    // loop) pass a pre-fetched allRows — the per-call full queryTodos({deleted:0}) scan used to
    // run once per constructed instance.
    const sameDay = (allRows || open().call('queryTodos', { deleted: 0 })).filter(x => x.dayStart === dayStartOf(todoTime))
    const sameSorts = sameDay.map(x => x.taskSort).filter(v => v != null)
    // P2 2026-09-20 convention (renderer renewal: store/todo.js addToTop:false → nextSort): bottom-insert
    // min-512, empty day 1024. The EMPTY-day case is keyed on sameSorts.length, NOT nextSort's internal
    // `!minS && !maxS` check — a day whose existing sorts are all exactly 0 (midpoint arithmetic can
    // produce 0) must take the min-512 branch (-512), not the empty-day 1024 baseline (review fix).
    const taskSort = sameSorts.length ? Math.fround(Math.min(...sameSorts) - 512) : 1024
    let subs = null
    try { subs = t.subtasks ? JSON.parse(t.subtasks) : null } catch { /* keep null */ }
    return {
      complete: false, createTime: now, delete: false,
      // D18-DOM2 (B6 convergence): attachments now ride in via renewalCarryFields (image/files carry
      // from the template) — the old hard `image: null, files: null` literals here used to drop them.
      ...core.renewalCarryFields(t, next),
      reminderTime: reminderTime !== undefined ? reminderTime : next.reminderTime,
      estimate,
      subtasks: subs ? JSON.stringify(subs.map(s => ({ ...s, checked: false }))) : null,
      categoryId: t.categoryId,
      updateTime: now, syncTime: 0,
      taskContent: t.taskContent,
      taskDescribe: t.taskDescribe || '',
      taskId: core.genTaskId(t.userId, now),
      taskSort,
      todoTime,
      userId: t.userId, status: 'add', version: 0,
      ...extra
    }
  }

  /* ---------------- Renewal after completion (D18-DOM2 #1: shared by BOTH completion paths) ----------------
   * D18-DOM2 (#1, 2026-10-02): the subtask-driven parent completion (lib-subs.cjs checkSubtask)
   * never renewed the repeat chain, while the direct `done` path did — but the App renews on EVERY
   * completion route (store/todo.js toggleComplete → dispatch('ensureNextRepeatInstance'), which
   * also fires for the sub-check parent completion). The renewal block therefore moved here, out of
   * cli/lib.js toggleComplete, so both CLI completion paths mint the next instance through the same
   * shared repeat-core machinery (core.nextRepeatInstance + buildRenewalInstance — NOT a third
   * generator). @param t the row BEFORE the completion patch; @param completed the persisted
   * post-patch row (complete: true). Returns the renewed row, the existing idempotent twin, or null. */
  function renewRepeatAfterComplete (db, t, completed) {
    if (!t || !t.repeatId) return null
    const rid = t.repeatId
    const group = db.call('queryTodos', { deleted: 0, repeatId: rid })
    let rule = null
    try { rule = JSON.parse(db.call('getMeta', 'repeatRule:' + rid) || 'null') } catch { /* no rule means no renewal */ }
    const next = core.nextRepeatInstance(completed, group, rule, require('../shared/holidays.mjs').getHolidayList())
    if (!next) return null
    // Renewal-instance idempotency: skip when an instance with the same rid + same dayStart exists (prevents duplicate CLI runs + concurrent multi-window generation creating two)
    const existing = db.call('queryTodos', { deleted: 0, repeatId: rid, dayStartFrom: next.todoTime, dayStartTo: next.todoTime })
    if (Array.isArray(existing) && existing.length) return existing[0]
    // F3 P2 (D5 renderer parity): carry the LIVE meta estimate of the instance being renewed
    // (getEstimateOf) — the row's estimate COLUMN is dead post-X2 (bumpSnow writes accumulated
    // focus minutes into it), so clamping it 0-20 turned "focused 150 min" into "20 tomatoes".
    // Carry set: core.renewalCarryFields via buildRenewalInstance (F-B4, single source).
    const estimate = clampEstimate(getEstimateOf(t.taskId, t.estimate))
    const nt = buildRenewalInstance(t, next, { estimate })
    try {
      commit('todo', 'put', nt)
    } catch (e) {
      // D20-DOMB2 (2026-10-02): the UNIQUE index idx_todos_repeat_day (todos.recurGroupId +
      // scheduledDay, live rows only — db-migrations.js) can reject this insert AFTER the
      // completion write already persisted — a concurrent window/renderer minted the same
      // rid+day instance between the pre-check above and the commit. Same semantics as the
      // idempotent pre-check: resolve to the existing twin instead of throwing past the done
      // path. The SQLite message names the COLUMNS ("UNIQUE constraint failed: todos.
      // recurGroupId, todos.scheduledDay"), not the index — match both spellings.
      if (!/repeat_day|scheduledDay|UNIQUE/i.test(String((e && e.message) || e))) throw e
      const twin = db.call('queryTodos', { deleted: 0, repeatId: rid, dayStartFrom: next.todoTime, dayStartTo: next.todoTime })
      if (Array.isArray(twin) && twin.length) return twin[0]
      throw e // index says it exists but the read disagrees — surface the real error
    }
    // F3 P2: the estimate column is write-once at the DB layer (U-1) — the live value lives in the
    // per-task meta key `tomatoEstimateState:<taskId>`; copy it there so the renewal keeps its
    // estimate on both ends (renderer twin: setEstimate in ensureNextRepeatInstance).
    if (estimate > 0) {
      try {
        commit('meta', 'put', [estimateKey(nt.taskId), String(estimate)])
        commit('meta', 'put', ['tomatoEstimateStateAt', String(Date.now())]) // same stamp convention as setEstimate
      } catch { /* estimate is advisory */ }
    }
    return db.call('getById', nt.taskId)
  }

  /* ---------------- Repeat rules (meta repeatRule:<rid>; generation reuses the todo-core engine) ---------------- */
  function buildRepeatRule (opts) {
    // B9-P3 (2026-10-02, App parity): the App seeds a new rule from the synced settings doc's
    // repeatDefaultSettings (renderer/js/store/repeatSettings.js — field-granular via settings_rows);
    // the CLI seeded from core.REPEAT_DEFAULTS only, so a user's custom default interval/counts were
    // silently ignored by `repeat on`. Absent per-field values fall back to REPEAT_DEFAULTS.
    const userDefaults = (settingsDoc && settingsDoc().repeatDefaultSettings) || {}
    const rule = Object.assign({}, core.REPEAT_DEFAULTS, (userDefaults && typeof userDefaults === 'object') ? userDefaults : {})
    const type = opts.type || 'daily'
    const interval = Math.max(1, parseInt(opts.interval, 10) || 1)
    // count: 0 = unspecified → keep the engine defaults (day 90 / week 52 / month 24 / year 5, same as the renderer's RepeatModal form);
    // the old Math.max(1, …) coerced an absent --count to repeatDayCount=1, so `repeat on --type daily` generated ZERO future instances
    const count = parseInt(opts.count, 10) || 0
    if (type === 'daily') { rule.repeatType = 'day'; rule.repeatInterval = interval; if (count) rule.repeatDayCount = count }
    else if (type === 'weekly') {
      // Fix (2026-09-19): --interval was ignored for weekly (hardcoded 1) while daily/monthly honored it
      rule.repeatType = 'week'; rule.repeatInterval = interval
      if (opts.weekdays) rule.repeatWeekDays = String(opts.weekdays).split(/[,，]/).map(n => parseInt(n, 10)).filter(n => n >= 1 && n <= 7)
      if (count) rule.repeatWeekCount = count
    } else if (type === 'monthly') {
      rule.repeatType = 'month'; rule.repeatInterval = interval
      if (opts.monthday) rule.repeatMonthDays = [parseInt(opts.monthday, 10) || 1]
      if (count) rule.repeatMonthCount = count
    } else if (type === 'yearly') {
      rule.repeatType = 'year'; rule.repeatInterval = interval
      if (count) rule.repeatYearCount = count
    } else throw new CliError('--type accepts daily|weekly|monthly|yearly', 'USAGE')
    if (opts['skip-weekends'] != null) rule.skipWeekends = true
    if (opts['skip-holidays'] != null) rule.skipStatutoryHolidays = true
    return rule
  }
  function repeatOn (input, rule, count) {
    const t = resolveTask(input, liveTasks())
    if (t.complete) throw new CliError('task already completed; undo it before setting a repeat', 'INVALID_STATE')
    if (t.repeatId && String(t.repeatId).startsWith('repeat_')) throw new CliError('task already in a repeat group (' + t.repeatId + '); repeat off first, then re-set', 'ALREADY_REPEAT')
    const rid = 'repeat_' + t.userId + Date.now().toString(36) + Math.floor(Math.random() * 1e4)
    // Fix (2026-09-19): no CLI flags for the yearly anchor — a Jan-1 default rule is re-anchored from the task's todoTime (explicit anchors stay authoritative).
    if (rule.repeatType === 'year' && t.todoTime &&
        rule.repeatYearMonth === core.REPEAT_DEFAULTS.repeatYearMonth &&
        rule.repeatYearMonthDay === core.REPEAT_DEFAULTS.repeatYearMonthDay) {
      const anchor = dayjs(t.todoTime)
      rule.repeatYearMonth = anchor.month() + 1
      rule.repeatYearMonthDay = anchor.date()
    }
    // D22 (P3, 2026-10-02, App parity): weekly/monthly anchors derive from the task's date too —
    // only the yearly rule did, so `repeat on --type monthly` without --monthday minted every
    // instance on the 1st and weekly without --weekdays landed Mon-Fri, regardless of the task's
    // own day (the App's RepeatModal seeds both anchors from the selected task). Same policy as
    // the yearly anchor above: derive only while the rule still carries the engine defaults
    // (an explicit flag that happens to equal a default is the accepted ambiguity, unchanged).
    if (t.todoTime && rule.repeatType === 'week' &&
        JSON.stringify(rule.repeatWeekDays) === JSON.stringify(core.REPEAT_DEFAULTS.repeatWeekDays)) {
      const dow = dayjs(t.todoTime).day()
      rule.repeatWeekDays = [dow === 0 ? 7 : dow] // engine convention: Monday=1 … Sunday=7
    }
    if (t.todoTime && rule.repeatType === 'month' &&
        JSON.stringify(rule.repeatMonthDays) === JSON.stringify(core.REPEAT_DEFAULTS.repeatMonthDays)) {
      rule.repeatMonthDays = [dayjs(t.todoTime).date()]
    }
    commit('meta', 'put', ['repeatRule:' + rid, JSON.stringify(rule)])
    commit('todo', 'put', Object.assign({}, t, { repeatId: rid, updateTime: Date.now(), status: 'update' }))
    // Generate subsequent instances (the first day is the current task itself), reusing the todo-core engine's expansion
    const base = t.todoTime || t.dayStart || +dayjs().startOf('day')
    // Generation cap: explicit --count wins; otherwise the App's maxRepeat setting (default 2), same as RepeatModal
    const cap = count > 0 ? count : (parseInt(settingsDoc().maxRepeat, 10) || 2)
    // Template reminder wall-clock re-derivation now happens per instance inside the loop (F-B4).
    let made = 0
    // P2 2026-09-20: pass the holiday list — expandRepeatDates(base, rule) defaulted to [] so a
    // skipStatutoryHolidays rule still expanded ONTO statutory holidays on the CLI (the renderer
    // passes its holidayList here; the CLI complete-renewal path below already does). Mirrors
    // cli/lib.js:655.
    const holidayList = require('../shared/holidays.mjs').getHolidayList()
    // D22 (P3 perf): one all-rows read for the whole expansion loop (buildRenewalInstance re-scanned
    // queryTodos({deleted:0}) per instance otherwise).
    const allRows = open().call('queryTodos', { deleted: 0 })
    for (const ts of core.expandRepeatDates(base, rule, holidayList).map(d => +d).filter(ts => ts > base).slice(0, cap)) {
      // F-B4: shared renewal-instance constructor (done-path parity). reminderTime keeps the template's
      // wall-clock time on each instance (dayjs re-derive per instance, same as RepeatModal — copying
      // the raw timestamp made reminders fire on the template's original date). estimate stays 0 and
      // carries NO meta write-back — historical D5-parity known gap, preserved as-is.
      const tplRem = t.reminderTime > 0 ? +dayjs(ts).hour(dayjs(t.reminderTime).hour()).minute(dayjs(t.reminderTime).minute()).second(0).millisecond(0) : 0
      commit('todo', 'put', buildRenewalInstance(t, { todoTime: ts, reminderTime: 0 }, {
        todoTime: ts,
        reminderTime: tplRem,
        extra: { repeatId: rid },
        allRows
      }))
      made++
    }
    audit.record({ action: 'repeat.on', targets: [t], changes: [{ after: { rid, rule, made } }], note: 'repeat set, ' + made + ' future instance(s) generated' })
    return { rid, made, task: t }
  }
  /* Repeat-group entry resolution: group instances share a name (same content, same date, different days), so AMBIGUOUS is meaningless for group ops — when several hits share a group, pick any one */
  function resolveRepeatEntry (input) {
    const list = liveTasks()
    const byId = list.find(t => t.taskId === input)
    if (byId) return byId
    const kw = normKey(input)
    const hits = list.filter(t => normKey(t.taskContent || '').includes(kw) && String(t.repeatId || '').startsWith('repeat_'))
    if (hits.length) return hits[0]
    return resolveTask(input, list)
  }
  /* D22 (P3 perf, 2026-10-02): batched chip-snapshot cascade for repeatOff --all. The per-task
   *  chipsSnapshotForDelete did a FULL planAll scan PER instance; here one scan feeds every
   *  snapshot, then the per-task cascade ops (meta put only when chips exist + plan deleteTask)
   *  run unchanged — same ops and key shapes, N scans → 1. Same loud-not-silent failure policy. */
  function chipsSnapshotBatchForDelete (taskIds) {
    let rows = []
    try { rows = open().call('planAll', []) } catch (e) {
      console.error('warning: chip snapshot scan failed — schedule chips may be orphaned (' + (e && e.message ? e.message : e) + ')')
    }
    for (const id of taskIds) {
      try {
        const chips = rows.filter(r => r.taskId === id)
        if (chips.length) commit('meta', 'put', ['planChipsSnapshot:' + id, JSON.stringify(chips)])
        commit('plan', 'deleteTask', id)
      } catch (e) {
        console.error(`warning: chip snapshot/cascade failed for task ${id} (${e && e.message ? e.message : e}) — schedule chips may be orphaned`)
      }
    }
  }
  function repeatOff (input, all) {
    const t = resolveRepeatEntry(input)
    const rid = t.repeatId
    if (!rid || !String(rid).startsWith('repeat_')) throw new CliError('task is not in a repeat group', 'NOT_REPEAT')
    let removed = 0
    if (all) {
      const now = Date.now()
      // D22 (P3 perf): hoist the all-rows read out of the loop (was one queryTodos per instance
      // via the per-task chipsSnapshotForDelete).
      const allRows = open().call('queryTodos', { deleted: 0 })
      // D18-DOM2 (#3, App parity RepeatDeleteModal.vue 'all' scope): EVERY live instance of the
      // group dies — completed ones included (the App's mode==='all' branch collects the whole
      // group regardless of completion, then cleanupOrphanRule GCs the rule). The old
      // `!x.complete` filter left finished instances in the recycle bin's alive-but-binned
      // siblings while the rule was already gone.
      const doomed = []
      for (const x of allRows) {
        if (x.repeatId === rid) {
          // version: 0 (deleteTodo parity, 2026-09-12 P3): syncTodos excludes delete rows already acked
          // with version > 0, so keeping the old version meant the soft-deleted repeat instances never
          // re-entered the sync snapshot and the deletion silently never propagated.
          commit('todo', 'put', Object.assign({}, x, { delete: true, deletedAt: now, updateTime: now, version: 0, status: 'delete' }))
          doomed.push(x.taskId)
          removed++
        }
      }
      chipsSnapshotBatchForDelete(doomed) // same snapshot→clear cascade as deleteTodo, batched (D22)
      // Fix (2026-09-19): '' → deleteMeta (file-wide convention) so the rule row is actually removed.
      commit('meta', 'delete', 'repeatRule:' + rid)
    } else {
      // D18-DOM2 (#2, App parity RepeatDeleteModal.vue [A2 fix] 'this event only'): the single
      // scope is a DELETE, not a detach. The CLI used to merely clear repeatId and keep the row —
      // the exact bug the App removed ("the user pressed Delete and nothing disappeared"). The
      // instance now soft-deletes (deleteTodo shape) and the rule is GCed when no live instances
      // remain (same cleanupOrphanRepeatRule semantics the App runs after every delete scope).
      const now = Date.now()
      commit('todo', 'put', Object.assign({}, t, { delete: true, deletedAt: now, updateTime: now, version: 0, status: 'delete' }))
      chipsSnapshotForDelete(t.taskId)
      removed++
      // Rule GC: delete the meta rule only when the group has no live instances left
      const liveLeft = open().call('queryTodos', { deleted: 0, repeatId: rid })
      if (!Array.isArray(liveLeft) || !liveLeft.length) commit('meta', 'delete', 'repeatRule:' + rid)
    }
    audit.record({
      action: 'repeat.off', targets: [t], changes: [{ before: { rid } }],
      note: all ? 'repeat group dissolved (soft-deleted ' + removed + ' instance(s), completed included)' : 'this instance deleted (repeat group kept)'
    })
    return { rid, removed }
  }
  function repeatRuleInfo (input) {
    const t = resolveRepeatEntry(input)
    const rid = t.repeatId
    if (!rid || !String(rid).startsWith('repeat_')) return { taskId: t.taskId, repeat: false }
    let rule = null
    try { rule = JSON.parse(open().call('getMeta', 'repeatRule:' + rid) || 'null') } catch { rule = null }
    return { taskId: t.taskId, repeat: true, rid, rule }
  }

  return { buildRenewalInstance, buildRepeatRule, repeatOn, renewRepeatAfterComplete, resolveRepeatEntry, repeatOff, repeatRuleInfo }
}
