/* Day-plan (schedule chips) sub-module extracted from cli/lib.js (2026-09-27 size-ratchet split).
 * Factory-injected deps keep it decoupled from lib.js (no circular require), same pattern as lib-settings.cjs.
 * Day timeline chips (plan_rows; one task can hold multiple chips = multiple expected pomodoros). */
module.exports = ({ open, commit, audit, CliError, dayjs, resolveTask, liveTasks, parseDate, dayStartOf }) => {
  function planDayKey (date) {
    if (!date) return dayjs().format('YYYY-MM-DD')
    return dayjs(dayStartOf(parseDate(date))).format('YYYY-MM-DD')
  }
  function planRows (day) {
    const rows = open().call('planAll', []).filter(r => !day || r.day === day)
    return rows
  }
  /** Place/schedule a task chip at HH:mm (one task can hold multiple chips = multiple expected pomodoros). --replace swaps all chips. */
  function planSet (input, mm, { date, replace } = {}) {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(mm))) throw new CliError('time must be HH:mm (00:00-23:59)', 'USAGE')
    const t = resolveTask(input, liveTasks())
    // Defaults to the task's own scheduled day (a future task's chips land on its task day, not today); explicit --date overrides
    const day = planDayKey(date != null && date !== true ? date : (t.dayStart ? dayjs(t.dayStart).format('YYYY-MM-DD') : null))
    const existing = planRows(day).filter(r => r.taskId === t.taskId)
    if (!replace && existing.some(r => r.mm === mm)) throw new CliError(`task already has a chip at ${mm} (plan list to inspect, --replace to rebuild)`, 'PLAN_EXISTS')
    if (replace && existing.length) commit('plan', 'deleteTaskDay', { taskId: t.taskId, day })
    commit('plan', 'putMany', [{ taskId: t.taskId, day, mm }])
    const chips = planRows(day).filter(r => r.taskId === t.taskId).map(r => r.mm).sort() // re-read actual state so the audit stays faithful
    audit.record({ action: 'plan.set', targets: [t], changes: [{ after: { day, chips } }], note: 'scheduled on the day timeline at ' + mm })
    return { taskId: t.taskId, content: t.taskContent, day, chips }
  }
  function planList (date) {
    const day = planDayKey(date)
    const live = liveTasks()
    const byTask = {}
    for (const r of planRows(day)) {
      if (!byTask[r.taskId]) byTask[r.taskId] = []
      byTask[r.taskId].push(r.mm)
    }
    return { day, tasks: Object.entries(byTask).map(([taskId, chips]) => {
      const t = live.find(x => x.taskId === taskId)
      return { taskId, content: t ? t.taskContent : '(deleted task)', complete: !!(t && t.complete), chips: chips.sort() }
    }) }
  }
  function planRemove (input, { date, at } = {}) {
    const t = resolveTask(input, liveTasks())
    // Same default-day rule as planSet: the task's own scheduled day (plan rm after plan set must not
    // silently target today and fail PLAN_NOT_FOUND for a future-scheduled task); explicit --date overrides
    const day = planDayKey(date != null && date !== true ? date : (t.dayStart ? dayjs(t.dayStart).format('YYYY-MM-DD') : null))
    const arr = planRows(day).filter(r => r.taskId === t.taskId)
    if (!arr.length) throw new CliError(`task has no chips on ${day}`, 'PLAN_NOT_FOUND')
    let ids
    if (at) {
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(at))) throw new CliError('time must be HH:mm', 'USAGE')
      ids = arr.filter(r => r.mm === at).map(r => r.id)
      if (!ids.length) throw new CliError(`no chip at ${at} for this task on ${day}`, 'PLAN_NOT_FOUND')
    } else {
      ids = arr.map(r => r.id)
    }
    commit('plan', 'removeIds', ids)
    audit.record({ action: 'plan.remove', targets: [t], changes: [{ before: { day, removed: ids.length } }], note: 'timeline chips removed' })
    return { taskId: t.taskId, day, removed: ids.length }
  }

  return { planDayKey, planRows, planSet, planList, planRemove }
}
