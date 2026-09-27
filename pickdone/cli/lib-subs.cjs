/* Subtasks sub-module extracted from cli/lib.js (2026-09-27 size-ratchet split).
 * Factory-injected deps keep it decoupled from lib.js (no circular require), same pattern as lib-settings.cjs.
 * Subtasks (subtasks JSON: [{text, checked}], structure aligned with EditPanel). */
module.exports = ({ resolveTask, liveTasks, patchTodo, CliError }) => {
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
  const checkSubtask = (input, key, checked = true) => mutateSubs(input, subs => { subs[findSub(subs, key)].checked = !!checked }, { note: (checked ? 'check' : 'uncheck') + ' subtask: ' + key })
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
