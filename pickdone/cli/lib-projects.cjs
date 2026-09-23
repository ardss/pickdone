'use strict'
/* Projects / milestones / explicit-status commands extracted verbatim from cli/lib.js (2026-09-23,
   #132 skipped P3-11 continuation: god-module split). Pure move — no behavior change; deps injected
   by lib.js so the db/bus/audit seams stay single. */
module.exports = (deps) => {
  const { open, CliError, dayjs, commit, audit, resolveCategory, resolveTask, liveTasks, tomatoRecords, parseDate, dayStartOf, parseMilestoneDateCore } = deps
/* ================= Projects (X3 2026-09-20: per-category flags `projectCategoryFlag:<categoryId>` = '1'; legacy whole-doc projectCategoryIds array is a read-only fallback union) ================= */
const PROJECT_IDS_KEY = 'projectCategoryIds'
const PROJECT_FLAG_PREFIX = 'projectCategoryFlag:'
const projectFlagKey = id => PROJECT_FLAG_PREFIX + String(id)

/** Single project four-question stats: when it started / how it is progressing / how much focus was invested / most recent activity */
function projectStatus (c) {
  const list = open().call('queryTodos', { deleted: 0, categoryId: c.categoryId })
  const done = list.filter(t => t.complete)
  // 真实专注口径:聚合挂在本项目任务上的 actual 专注记录(与 stats/tomato list 同源,预计番茄口径退役)
  const idset = new Set(list.map(t => t.taskId))
  const actualFocus = tomatoRecords().reduce((s, r) => s + (r.succeed !== false && r.focusTaskId && idset.has(r.focusTaskId) ? (Number(r.focusDuration) || 0) : 0), 0)
  const today0 = +dayjs().startOf('day')
  const week24 = +dayjs().add(7, 'day').endOf('day')
  const started = list.reduce((m, t) => Math.min(m, t.createTime || m), Infinity)
  return {
    categoryId: c.categoryId, name: c.categoryName, color: c.categoryColor,
    total: list.length, done: done.length,
    progress: list.length ? Math.round(done.length / list.length * 100) : 0,
    focusMinutes: actualFocus,
    startedAt: isFinite(started) ? started : 0,
    lastActivity: done.reduce((m, t) => Math.max(m, t.completedAt || 0), 0),
    overdue: list.filter(t => !t.complete && t.dayStart > 0 && t.dayStart < today0).length,
    next7days: list.filter(t => !t.complete && t.dayStart >= today0 && t.dayStart <= week24).length,
    deadline: getProjectDeadline(c.categoryId),
    // explicit user-set status (see setProjectStatus) — separate concern from the derived progress stats above
    status: explicitStatus(c.categoryId)
  }
}

function getProjectIds () {
  // X3 readers: per-category flags are the source of truth; the legacy whole-doc array is a
  // read-only fallback — UNION both so data written by an old renderer/CLI still shows.
  const ids = new Set()
  for (const k of open().call('listMetaKeys') || []) if (String(k).startsWith(PROJECT_FLAG_PREFIX)) ids.add(String(k).slice(PROJECT_FLAG_PREFIX.length))
  try { const a = JSON.parse(open().call('getMeta', PROJECT_IDS_KEY) || '[]'); if (Array.isArray(a)) for (const x of a) ids.add(String(x)) } catch { /* corrupt → ignore */ }
  return [...ids]
}

function getProjects () {
  const ids = getProjectIds()
  return open().call('getAllCategories').filter(c => ids.includes(String(c.categoryId))).map(projectStatus)
}

/** Set/unset as project (category name or id), with audit trail */
function setProjectFlag (input, flag) {
  const db = open()
  const id = resolveCategory(input)
  const c = db.call('getAllCategories').find(x => x.categoryId === id)
  // X3: set = setMeta '1', unmark = deleteMeta (tombstone) — per-key writes never clobber a
  // peer's concurrent flag the way the old whole-doc array did. Legacy array stays untouched.
  if (flag) commit('meta', 'put', [projectFlagKey(id), '1'])
  else {
    commit('meta', 'delete', projectFlagKey(id))
    // Round-3 P1 (renderer parity, category.js rewriteLegacyProjectIdsWithout / U-5): unmark must
    // ALSO scrub the id from the legacy whole-doc array — getProjectIds unions both sources, so
    // the stale blob resurrected the unset project on the next read.
    try {
      const arr = JSON.parse(open().call('getMeta', PROJECT_IDS_KEY) || '[]')
      if (Array.isArray(arr) && arr.map(String).includes(String(id))) {
        commit('meta', 'put', [PROJECT_IDS_KEY, JSON.stringify(arr.filter(x => String(x) !== String(id)))])
      }
    } catch { /* corrupt blob → leave alone (renderer init heals it) */ }
  }
  audit.record({ action: 'project.set', targets: [{ taskId: 'cat:' + id, content: c ? c.categoryName : String(id) }], note: (flag ? 'set as project' : 'unset project') })
  return { categoryId: id, name: c ? c.categoryName : String(id), isProject: !!flag }
}

/* ================= Milestones (meta projectMilestones:<categoryId>, same source as the UI timeline) ================= */
const MS_KEY = id => 'projectMilestones:' + id

function msNormalize (list) {
  return (Array.isArray(list) ? list : []).filter(m => m && m.title && m.date)
    .map(m => ({
      id: m.id || ('ms_' + Date.now() + Math.random().toString(36).slice(2, 6)),
      title: String(m.title),
      date: Number(m.date),
      taskIds: Array.isArray(m.taskIds) ? m.taskIds.filter(Boolean) : []
    }))
    .sort((a, b) => a.date - b.date)
}

/** Milestone progress (N2): linked tasks → completion ratio; none linked → null (purely date-driven) */
function msProgress (m, tasks) {
  const ids = new Set(m.taskIds || [])
  if (!ids.size) return null
  const linked = tasks.filter(t => ids.has(t.taskId))
  if (!linked.length) return null
  const done = linked.filter(t => t.complete).length
  return { done, total: linked.length, pct: Math.round(done / linked.length * 100) }
}

function getMilestones (categoryInput) {
  const id = resolveCategory(categoryInput)
  let list = []
  try { list = JSON.parse(open().call('getMeta', MS_KEY(id)) || '[]') } catch { /* treat a corrupt row as empty */ }
  return { categoryId: id, milestones: msNormalize(list) }
}

/** Milestone date parsing: YYYY-MM-DD / M-D, M/D, M.D (current year) / today | +Nd (明天 supported in core).
 *  Single source: shared/parse-date.mjs (same core as renderer milestones.js). */
function parseMilestoneDate (input) {
  return parseMilestoneDateCore(input, dayjs)
}

function addMilestone (categoryInput, title, dateInput) {
  const { categoryId } = getMilestones(categoryInput)
  if (!title || !String(title).trim()) throw new CliError('milestone title required', 'EMPTY_CONTENT')
  const date = parseMilestoneDate(dateInput)
  if (!date) throw new CliError(`cannot parse date: "${dateInput}" (supported: YYYY-MM-DD / MM-DD / today / +14d)`, 'BAD_DATE')
  const cat = open().call('getAllCategories').find(c => c.categoryId === categoryId)
  const added = { title: String(title).trim(), date }
  const list = msNormalize(getMilestones(categoryId).milestones.concat([added]))
  commit('meta', 'put', [MS_KEY(categoryId), JSON.stringify(list)])
  audit.record({ action: 'milestone.add', targets: [{ taskId: 'cat:' + categoryId, content: cat ? cat.categoryName : String(categoryId) }], note: `milestone "${title.trim()}" → ${dayjs(date).format('YYYY-MM-DD')}` })
  // `added` echoes the milestone this call actually inserted (the list is date-sorted, so the CLI used to echo milestones.at(-1) — a different row whenever the new date was not the latest)
  const stored = list.find(m => m.title === added.title && m.date === added.date) || added
  return { categoryId, milestones: list, added: stored }
}

function removeMilestone (categoryInput, index) {
  const { categoryId, milestones } = getMilestones(categoryInput)
  const i = parseInt(index, 10) - 1
  if (!(i >= 0 && i < milestones.length)) throw new CliError(`milestone index out of range: ${index} (${milestones.length} total; use milestone list)`, 'MS_NOT_FOUND')
  const [removed] = milestones.splice(i, 1)
  commit('meta', 'put', [MS_KEY(categoryId), JSON.stringify(milestones)])
  audit.record({ action: 'milestone.rm', targets: [{ taskId: 'cat:' + categoryId, content: removed.title }], note: 'milestone removed' })
  return { categoryId, milestones, removed }
}

/** Link/unlink a task to a milestone (N2): progress = completion ratio of linked tasks, same source as the UI */
function linkMilestone (categoryInput, index, taskInput, link = true) {
  const { categoryId, milestones } = getMilestones(categoryInput)
  const i = parseInt(index, 10) - 1
  if (!(i >= 0 && i < milestones.length)) throw new CliError(`milestone index out of range: ${index} (${milestones.length} total)`, 'MS_NOT_FOUND')
  const t = resolveTask(taskInput, liveTasks())
  const ms = milestones[i]
  const ids = new Set(ms.taskIds || [])
  link ? ids.add(t.taskId) : ids.delete(t.taskId)
  ms.taskIds = [...ids]
  commit('meta', 'put', [MS_KEY(categoryId), JSON.stringify(milestones)])
  audit.record({
    action: link ? 'milestone.link' : 'milestone.unlink',
    targets: [{ taskId: 'cat:' + categoryId, content: ms.title }, t],
    note: (link ? 'link task to milestone (' : 'unlink task from milestone (') + ms.title + ')'
  })
  return { categoryId, milestone: ms, progress: msProgress(ms, open().call('queryTodos', { deleted: 0, categoryId })) }
}

/** Project deadline (meta projectDeadline:<id>, same source as the UI). Pass none/empty in dateInput to clear */
function setProjectDeadline (input, dateInput) {
  const id = resolveCategory(input)
  const cat = open().call('getAllCategories').find(c => c.categoryId === id)
  const key = 'projectDeadline:' + id
  let deadline = 0
  if (dateInput != null && dateInput !== '' && !/^(none|clear|清除|取消)$/i.test(dateInput)) {
    // review P2 (2026-09-10): delegate to the same parser as `edit --deadline` (parseDate) — the milestone
    // parser rejected "tomorrow"/"+3d 09:00" here while `edit --deadline` accepted them. Deadlines stay day-granular via startOf('day'). (parseMilestoneDate remains milestone-command-only.)
    try {
      deadline = dayStartOf(parseDate(dateInput))
    } catch (e) {
      throw new CliError(`cannot parse date: "${dateInput}" (supported: YYYY-MM-DD / today / tomorrow / +14d / none to clear)`, 'BAD_DATE')
    }
    if (!deadline) throw new CliError(`cannot parse date: "${dateInput}" (supported: YYYY-MM-DD / today / tomorrow / +14d / none to clear)`, 'BAD_DATE')
  }
  commit('meta', 'put', [key, String(deadline)])
  audit.record({
    action: 'project.deadline',
    targets: [{ taskId: 'cat:' + id, content: cat ? cat.categoryName : String(id) }],
    note: deadline ? `deadline → ${dayjs(deadline).format('YYYY-MM-DD')}` : 'deadline cleared'
  })
  return { categoryId: id, name: cat ? cat.categoryName : String(id), deadline }
}

/** Read the project deadline (0 = not set) */
function getProjectDeadline (categoryId) {
  const v = open().call('getMeta', 'projectDeadline:' + categoryId)
  const n = Number(v) || 0
  return n
}

/* ---------------- Project explicit status (meta projectStatus:<categoryId>; same key the App reads; absent = 'active') ----------------
   This is a user-set lifecycle field, distinct from the derived progress stats in projectStatus() above. */
const PROJECT_STATUS_VALUES = ['active', 'paused', 'done', 'cancelled']
const projectStatusKey = id => 'projectStatus:' + id

/** Explicit project status; absent/invalid meta value falls back to 'active' */
function explicitStatus (categoryId) {
  const v = open().call('getMeta', projectStatusKey(categoryId))
  return PROJECT_STATUS_VALUES.includes(v) ? v : 'active'
}

/** Set the explicit project status; 'none' deletes the meta key so both ends fall back to 'active' */
function setProjectStatus (input, status) {
  const id = resolveCategory(input)
  const cat = open().call('getAllCategories').find(c => c.categoryId === id)
  const name = cat ? cat.categoryName : String(id)
  const before = explicitStatus(id)
  if (String(status || '').toLowerCase() === 'none' || status == null || status === '') {
    commit('meta', 'delete', projectStatusKey(id))
    audit.record({ action: 'project.status', targets: [{ taskId: 'cat:' + id, content: name }], changes: [{ before: { status: before }, after: { status: 'active' } }], note: 'project status cleared (falls back to active)' })
    return { categoryId: id, name, status: 'active', cleared: true }
  }
  const next = String(status).toLowerCase()
  if (!PROJECT_STATUS_VALUES.includes(next)) throw new CliError(`--status accepts ${PROJECT_STATUS_VALUES.join('|')}|none (got "${status}")`, 'USAGE')
  commit('meta', 'put', [projectStatusKey(id), next])
  audit.record({ action: 'project.status', targets: [{ taskId: 'cat:' + id, content: name }], changes: [{ before: { status: before }, after: { status: next } }], note: 'project status → ' + next })
  return { categoryId: id, name, status: next }
}


  return {
    getProjects, getProjectIds, setProjectFlag, projectStatus,
    // key builders re-exported: lib.js deleteCategory still scrubs/backups these meta keys (U-4 parity)
    PROJECT_IDS_KEY, projectFlagKey, projectStatusKey, MS_KEY,
    getMilestones, parseMilestoneDate, addMilestone, removeMilestone, linkMilestone, msProgress,
    setProjectDeadline, getProjectDeadline,
    PROJECT_STATUS_VALUES, explicitStatus, setProjectStatus,
  }
}
