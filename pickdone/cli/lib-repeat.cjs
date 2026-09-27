/* Repeat-rules sub-module extracted from cli/lib.js (2026-09-27 size-ratchet split).
 * Factory-injected deps keep it decoupled from lib.js (no circular require), same pattern as lib-settings.cjs.
 * Repeat rules (meta repeatRule:<rid>; generation reuses the todo-core engine) + the shared renewal-instance constructor. */
module.exports = ({ open, commit, audit, CliError, dayjs, core, resolveTask, liveTasks, normKey, settingsDoc, chipsSnapshotForDelete, dayStartOf }) => {
  /** F-B4 (dw wave 3): single constructor for CLI renewal instances — the done path (repeat renewal on
   *  complete) and repeatOn's future-instance expansion (expand) carried two ~40-line near-verbatim
   *  object literals. Behavior preserved exactly, including expand's historical estimate:0 (no silent
   *  behavior change; the done path keeps its live getEstimateOf readback). Sort keeps the legacy
   *  length-keyed bottom-insert convention (min-512 / empty-day 1024; see the inline note for why
   *  nextSort's own empty check is not used here). */
  function buildRenewalInstance (t, next, { estimate = 0, todoTime = next.todoTime, reminderTime, extra = {} } = {}) {
    const now = Date.now()
    const sameDay = open().call('queryTodos', { deleted: 0 }).filter(x => x.dayStart === dayStartOf(todoTime))
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
      ...core.renewalCarryFields(t, next),
      reminderTime: reminderTime !== undefined ? reminderTime : next.reminderTime,
      estimate,
      subtasks: subs ? JSON.stringify(subs.map(s => ({ ...s, checked: false }))) : null,
      image: null, files: null,
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

  /* ---------------- Repeat rules (meta repeatRule:<rid>; generation reuses the todo-core engine) ---------------- */
  function buildRepeatRule (opts) {
    const rule = Object.assign({}, core.REPEAT_DEFAULTS)
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
    for (const ts of core.expandRepeatDates(base, rule, holidayList).map(d => +d).filter(ts => ts > base).slice(0, cap)) {
      // F-B4: shared renewal-instance constructor (done-path parity). reminderTime keeps the template's
      // wall-clock time on each instance (dayjs re-derive per instance, same as RepeatModal — copying
      // the raw timestamp made reminders fire on the template's original date). estimate stays 0 and
      // carries NO meta write-back — historical D5-parity known gap, preserved as-is.
      const tplRem = t.reminderTime > 0 ? +dayjs(ts).hour(dayjs(t.reminderTime).hour()).minute(dayjs(t.reminderTime).minute()).second(0).millisecond(0) : 0
      commit('todo', 'put', buildRenewalInstance(t, { todoTime: ts, reminderTime: 0 }, {
        todoTime: ts,
        reminderTime: tplRem,
        extra: { repeatId: rid }
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
  function repeatOff (input, all) {
    const t = resolveRepeatEntry(input)
    const rid = t.repeatId
    if (!rid || !String(rid).startsWith('repeat_')) throw new CliError('task is not in a repeat group', 'NOT_REPEAT')
    let removed = 0
    if (all) {
      const now = Date.now()
      for (const x of open().call('queryTodos', { deleted: 0 })) {
        if (x.repeatId === rid && x.taskId !== t.taskId && !x.complete) {
          // version: 0 (deleteTodo parity, 2026-09-12 P3): syncTodos excludes delete rows already acked
          // with version > 0, so keeping the old version meant the soft-deleted repeat instances never
          // re-entered the sync snapshot and the deletion silently never propagated.
          commit('todo', 'put', Object.assign({}, x, { delete: 1, deletedAt: now, updateTime: now, version: 0, status: 'delete' }))
          chipsSnapshotForDelete(x.taskId) // same snapshot→clear cascade as deleteTodo: soft-deleted instances must not leave orphan chips
          removed++
        }
      }
      // Fix (2026-09-19): '' → deleteMeta (file-wide convention) so the rule row is actually removed.
      commit('meta', 'delete', 'repeatRule:' + rid)
    }
    commit('todo', 'put', Object.assign({}, t, { repeatId: null, updateTime: Date.now(), status: 'update' }))
    audit.record({ action: 'repeat.off', targets: [t], changes: [{ before: { rid } }], note: all ? 'repeat group dissolved (soft-deleted ' + removed + ' future instance(s))' : 'left repeat group (this instance only)' })
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

  return { buildRenewalInstance, buildRepeatRule, repeatOn, resolveRepeatEntry, repeatOff, repeatRuleInfo }
}
