/* Subtasks sub-module extracted from cli/lib.js (2026-09-27 size-ratchet split).
 * Factory-injected deps keep it decoupled from lib.js (no circular require), same pattern as lib-settings.cjs.
 * Subtasks (subtasks JSON: [{text, checked}], structure aligned with EditPanel). */
// D17: the parent-toggle rule is shared with the renderer (utils/core.js re-exports shared/subs-core.mjs)
const { subsCompleteTarget } = require('../shared/subs-core.mjs')
module.exports = ({ resolveTask, liveTasks, patchTodo, CliError, open, renewRepeatAfterComplete, commit, chipsSnapshotForDelete }) => {
  /* ================= Subtasks (subtasks JSON: [{text, checked}], structure aligned with EditPanel) ================= */
  function parseSubs (t) {
    try { const a = JSON.parse(t.subtasks || '[]'); return Array.isArray(a) ? a : [] } catch { return [] }
  }

  /** Subtask resolution: 1-based index or unique text match */
  function findSub (subs, key) {
    const s = String(key)
    if (/^\d+$/.test(s)) {
      const i = parseInt(s, 10) - 1
      if (i < 0 || i >= subs.length) throw new CliError(`subtask index out of range: ${key} (${subs.length} total)`, 'SUB_NOT_FOUND')
      return i
    }
    const kw = s.toLowerCase()
    const hits = subs.map((x, i) => (x.text || '').toLowerCase().includes(kw) ? i : -1).filter(i => i >= 0)
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) throw new CliError(`subtask keyword "${key}" matched ${hits.length}; use an index (get <task> --json to view subtasks)`, 'AMBIGUOUS_MATCH')
    throw new CliError(`subtask not found: "${key}"`, 'SUB_NOT_FOUND')
  }

  function mutateSubs (input, fn, { action = 'subtask', note } = {}) {
    const t = resolveTask(input)
    const subs = parseSubs(t)
    fn(subs)
    return patchTodo(t.taskId, { subtasks: JSON.stringify(subs) }, { action, note })
  }

  const addSubtask = (input, text) => {
    if (!text || !String(text).trim()) throw new CliError('subtask content required', 'EMPTY_CONTENT')
    return mutateSubs(input, subs => subs.push({ text: String(text).trim(), checked: false }), { note: 'subtask added: ' + String(text).trim() })
  }
  /** Check/uncheck one subtask + parent completion sync (App parity: TodoItem._applySubCheck /
   *  EditPanel via subsCompleteTarget). Checking the last unchecked sub completes the parent
   *  (completedAt = now, same shape as toggleComplete); unchecking any sub of a complete parent
   *  un-completes it (completedAt = 0). No subtasks / partial state → parent untouched (null target).
   *  D18-DOM2 (#1, HIGH): completing the parent through the sub-check also RENEWS the repeat chain —
   *  the App renews on every completion route (store/todo.js toggleComplete dispatches
   *  ensureNextRepeatInstance after the parent-complete patch, and the sub-check path lands there
   *  too); the CLI sub-check used to complete the parent while silently killing the chain. The
   *  renewal goes through the SAME shared machinery as the `done` path (lib-repeat.cjs
   *  renewRepeatAfterComplete → shared/repeat-core.mjs — not a third generator). */
  const checkSubtask = (input, key, checked = true) => {
    const t = resolveTask(input)
    const subs = parseSubs(t)
    subs[findSub(subs, key)].checked = !!checked
    const patch = { subtasks: JSON.stringify(subs) }
    const target = subsCompleteTarget(subs, !!t.complete)
    if (target === true) { patch.complete = true; patch.completedAt = Date.now() } else if (target === false) { patch.complete = false; patch.completedAt = 0 }
    const note = (checked ? 'check' : 'uncheck') + ' subtask: ' + key +
      (target != null ? ` (parent ${target ? 'completed' : 'un-completed'} in sync)` : '')
    const after = patchTodo(t.taskId, patch, { action: 'subtask', note })
    // Renewal AFTER the parent-complete patch is persisted (same order as toggleComplete: the
    // computation reads the completed row + the live group, then mints the next instance)
    let renewed = null
    if (target === true && after && t.repeatId) {
      renewed = renewRepeatAfterComplete(open(), t, after)
    }
    // D22 (P2, 2026-10-02): un-completing the parent through a sub-uncheck must also remove the
    // phantom auto-renewed next instance — the App's undo path removes it (renderer/js/store/
    // todo.js toggleComplete) and the CLI `done --undo` cleanup does the same (cli/lib.js), but
    // this branch only reset complete:false/completedAt:0, leaving a seeded future instance that
    // only a manual delete would clear. Same selection rule as the undo cleanup: same rid,
    // nearest later dayStart, still the group's LAST live instance, and not itself completed.
    let removedRenewal = null
    if (target === false && after && t.repeatId && t.dayStart) {
      try {
        const group = open().call('queryTodos', { deleted: 0, repeatId: t.repeatId })
          .filter(x => x.taskId !== t.taskId && x.dayStart > 0)
          .sort((a, b) => a.dayStart - b.dayStart)
        const lastDay = group.length ? group[group.length - 1].dayStart : 0
        const renewedNext = group.find(x => x.dayStart > t.dayStart)
        if (renewedNext && !renewedNext.complete && renewedNext.dayStart === lastDay) {
          const now = Date.now()
          // version: 0 (deleteTodo parity) so the soft delete re-enters the sync snapshot
          commit('todo', 'put', Object.assign({}, renewedNext, { delete: true, deletedAt: now, updateTime: now, version: 0, status: 'delete' }))
          chipsSnapshotForDelete(renewedNext.taskId) // same snapshot→clear cascade as deleteTodo
          removedRenewal = renewedNext.taskId
        }
      } catch (e) {
        // Best-effort: the uncheck itself must succeed even if the cleanup hits a snag — but loud
        console.error(`warning: subtask uncheck could not remove the auto-renewed instance for task ${t.taskId} (${e && e.message ? e.message : e})`)
      }
    }
    return after && typeof after === 'object' ? Object.assign(after, { renewed, removedRenewal }) : after
  }
  const removeSubtask = (input, key) => mutateSubs(input, subs => subs.splice(findSub(subs, key), 1), { note: 'subtask removed: ' + key })

  /** Reorder subtasks (subtasks array order — same storage as EditPanel drag) */
  function moveSubtask (input, n, where, target) {
    const t = resolveTask(input, liveTasks())
    const subs = parseSubs(t)
    const idx = parseInt(n, 10) - 1
    if (!(idx >= 0 && idx < subs.length)) throw new CliError(`subtask #${n} not found (1-${subs.length})`, 'SUB_NOT_FOUND')
    let to
    if (where === 'up') to = idx - 1
    else if (where === 'down') to = idx + 1
    else if (where === 'top') to = 0
    else if (where === 'bottom') to = subs.length - 1
    else if (where === 'to') to = (parseInt(target, 10) || 0) - 1
    else throw new CliError('position must be up|down|top|bottom|to <n>', 'USAGE')
    if (!(to >= 0 && to < subs.length)) throw new CliError('target position out of range', 'SUB_NOT_FOUND')
    const [item] = subs.splice(idx, 1)
    subs.splice(to, 0, item)
    patchTodo(t.taskId, { subtasks: JSON.stringify(subs) }, { action: 'subtask' })
    return { taskId: t.taskId, order: subs.map((s, i) => `${i + 1}.${s.text}${s.checked ? '[x]' : ''}`) }
  }

  return { parseSubs, addSubtask, checkSubtask, removeSubtask, moveSubtask }
}
