/* Tags + batch sub-module extracted from cli/lib.js (2026-09-27 size-ratchet split).
 * Factory-injected deps keep it decoupled from lib.js (no circular require), same pattern as lib-settings.cjs.
 * Tags (derived from #tag in content/description; rename/remove rewrite text across tasks — same regex semantics as SideNav)
 * + explicit-id batch operations. */
module.exports = ({ liveTasks, recycleTasks, CliError, patchTodo, toggleComplete, dateChangeReminderPatch, migrateChipsOnDayChange, parseDate, resolveCategory }) => {
  // Character-for-character identical to renderer/js/utils/search.js TAG_RE (tags are derived from body text, no separate storage)
  const TAG_RE = /#([^\s#,，。.!?！？]+)/g
  function extractTagsCli (...texts) {
    const set = new Set()
    texts.forEach(t => {
      if (!t) return
      let m; TAG_RE.lastIndex = 0
      while ((m = TAG_RE.exec(String(t)))) set.add(m[1])
    })
    return [...set]
  }
  function tagEsc (name) { return String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }
  function listTags () {
    const count = {}
    for (const t of liveTasks()) {
      for (const name of extractTagsCli(t.taskContent, t.taskDescribe)) count[name] = (count[name] || 0) + 1
    }
    return Object.entries(count).map(([name, tasks]) => ({ name, tasks })).sort((a, b) => b.tasks - a.tasks || a.name.localeCompare(b.name))
  }
  function rewriteTag (name, next, { remove } = {}) {
    const esc = tagEsc(name)
    // rename: #old(?=\s|$) → #new ; remove: leading whitespace swallowed too (\s*#old(?=\s|$) → '')
    const re = remove ? new RegExp('\\s*#' + esc + '(?=\\s|$)', 'g') : new RegExp('#' + esc + '(?=\\s|$)', 'g')
    let touched = 0
    // maint/d24 P2: the App (SnManageTagsModal.vue tagTodos) rewrites tags in RECYCLE rows too — the
    // CLI iterating live rows only missed the tombstones, so restore-after-rename resurrected the old
    // tag (ghost tags). Rewrite across live ∪ recycled rows; the tag LIST derivation stays live-only.
    const rows = liveTasks().concat(recycleTasks())
    for (const todo of rows) {
      const patch = {}
      if (todo.taskContent) {
        const v = remove ? todo.taskContent.replace(re, '').trim() : todo.taskContent.replace(re, '#' + next)
        if (v !== todo.taskContent) patch.taskContent = v
      }
      if (todo.taskDescribe) {
        const v = remove ? todo.taskDescribe.replace(re, '').trim() : todo.taskDescribe.replace(re, '#' + next)
        if (v !== todo.taskDescribe) patch.taskDescribe = v
      }
      if (Object.keys(patch).length) { patchTodo(todo.taskId, patch, { action: 'tag.' + (remove ? 'remove' : 'rename') }); touched++ }
    }
    return touched
  }

  /* ---------------- Batch operations (explicit taskIds only — no keyword matching; per-task failures never abort the run) ---------------- */
  /** Exact-id resolution for batch: batch is explicit by design, so the keyword/ambiguity path of resolveTask is deliberately absent */
  function resolveTaskExact (id, pool) {
    const t = (pool || liveTasks()).find(x => x.taskId === String(id))
    if (!t) throw new CliError(`task not found: "${id}" (batch takes exact taskIds only, no keyword matching)`, 'TASK_NOT_FOUND')
    return t
  }

  /** Add/remove one #tag on a single task — same title/description rewrite path as `tag rename`/`tag rm`
   *  (TAG_RE boundary regex); add appends " #name" to the title like the App's EditPanel.addTag. */
  function batchTagOne (t, name, remove) {
    const esc = tagEsc(name)
    if (remove) {
      const re = new RegExp('\\s*#' + esc + '(?=\\s|$)', 'g')
      const patch = {}
      if (t.taskContent) { const v = t.taskContent.replace(re, '').trim(); if (v !== t.taskContent) patch.taskContent = v }
      if (t.taskDescribe) { const v = t.taskDescribe.replace(re, '').trim(); if (v !== t.taskDescribe) patch.taskDescribe = v }
      if (!Object.keys(patch).length) throw new CliError(`tag #${name} not present on this task`, 'TAG_NOT_PRESENT')
      return patchTodo(t.taskId, patch, { action: 'tag.remove' })
    }
    if (new RegExp('#' + esc + '(?=\\s|$)').test(t.taskContent || '')) throw new CliError(`tag #${name} already on this task`, 'TAG_PRESENT')
    return patchTodo(t.taskId, { taskContent: (t.taskContent || '').replace(/\s+$/, '') + ' #' + name }, { action: 'tag.add' })
  }

  /**
   * Run a batch op over explicit taskIds. Returns { op, matched, changed, failures, outcomes } where
   * outcomes carries the per-task line info for text rendering; failures never abort the remaining tasks.
   * Audit: one entry per task change (inherent — every op routes through patchTodo/toggleComplete).
   */
  function batchRun (op, ids, { to, add, rm, dryRun } = {}) {
    const entries = (Array.isArray(ids) ? ids : [ids]).map(String).filter(Boolean)
    if (!entries.length) throw new CliError(`batch ${op} needs at least one taskId`, 'USAGE')
    let toTs = null
    let catId = null
    let tagName = null
    let removing = false
    if (op === 'date') {
      if (!to || to === true) throw new CliError('batch date needs --to <today|tomorrow|+Nd|YYYY-MM-DD[ HH:mm]>', 'USAGE')
      toTs = parseDate(to) // same parser as `edit --date`; throws on bad input before anything is written
    } else if (op === 'category') {
      if (!to || to === true) throw new CliError('batch category needs --to <name|id>', 'USAGE')
      catId = resolveCategory(to)
    } else if (op === 'tag') {
      const hasAdd = add != null && add !== true
      const hasRm = rm != null && rm !== true
      if (hasAdd === hasRm) throw new CliError('batch tag needs exactly one of --add <tag> | --rm <tag>', 'USAGE')
      tagName = String(hasAdd ? add : rm).replace(/^#/, '')
      if (!tagName) throw new CliError('tag name required (--add <tag> | --rm <tag>)', 'USAGE')
      removing = hasRm
    } else if (op !== 'done') {
      throw new CliError(`unknown batch op "${op}" (valid: done/date/category/tag)`, 'USAGE')
    }
    const pool = liveTasks()
    const describe = t => op === 'done' ? `complete "${t.taskContent}" (subtask cascade / repeat renewal apply)`
      : op === 'date' ? `reschedule "${t.taskContent}" → ${to}`
        : op === 'category' ? `recategorize "${t.taskContent}" → ${to}`
          : `${removing ? 'remove' : 'add'} #${tagName} ${removing ? 'on' : 'to'} "${t.taskContent}"`
    const exec = {
      done: t => toggleComplete(t.taskId, true),
      date: t => {
        // Same reminder re-anchor as `edit --date` (dateChangeReminderPatch): batch date used to patch
        // todoTime bare and leave the main reminder on the old day (semantic split between the channels)
        const patch = { todoTime: toTs, ...dateChangeReminderPatch(t, toTs) }
        const after = patchTodo(t.taskId, patch, { action: 'edit' })
        migrateChipsOnDayChange(t.taskId, t.dayStart, after.dayStart)
        return after
      },
      category: t => patchTodo(t.taskId, { categoryId: catId }, { action: 'edit' }),
      tag: t => batchTagOne(t, tagName, removing)
    }
    const failures = []
    const outcomes = []
    let changed = 0
    for (const id of entries) {
      let t = null
      try { t = resolveTaskExact(id, pool) } catch (e) {
        failures.push({ taskId: id, error: e.message })
        outcomes.push({ taskId: id, ok: false, error: e.message })
        continue
      }
      if (op === 'done' && t.complete) {
        // review P2 (2026-09-10): batch done used to rewrite completedAt and count the row as changed
        outcomes.push({ taskId: t.taskId, ok: true, skipped: true, label: `already complete "${t.taskContent}"` })
        continue
      }
      if (dryRun) { outcomes.push({ taskId: t.taskId, ok: true, dryRun: true, label: describe(t) }); continue }
      try {
        exec[op](t)
        changed++
        outcomes.push({ taskId: t.taskId, ok: true, label: describe(t) })
      } catch (e) {
        failures.push({ taskId: t.taskId, error: String(e.message || e) })
        outcomes.push({ taskId: t.taskId, ok: false, error: String(e.message || e) })
      }
    }
    if (dryRun) return { op, matched: entries.length, dryRun: true, plan: outcomes.filter(o => o.ok), failures, outcomes }
    return { op, matched: entries.length, changed, failures, outcomes }
  }

  return { extractTagsCli, tagEsc, listTags, rewriteTag, resolveTaskExact, batchTagOne, batchRun }
}
