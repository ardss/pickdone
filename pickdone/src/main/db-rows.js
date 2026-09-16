/* Row/serialization helpers extracted from db.js (2026-09-15 size-ratchet split):
 * reminders pack/parse, todo/category row<->object mappers, content normalization.
 * Pure functions only — no db handle, no module state. */

// Normalize whitespace in titles (common practice: collapse line breaks/tabs into spaces)
function normalizeContent (s) {
  if (typeof s !== 'string') return s
  // Control chars + RTL/LTR/RLO override sanitization (guards against spoofing via notifications/export/system clipboard and line-break breakage),
  // including the newer LRI/RLI/FSI/PDI (2066-2069) plus LRM/RLM/BOM — the older 202A-202E set no longer covers the spoofing surface.
  // Then collapse multiple whitespace + truncate to 5000 chars (consistent with the editor/DB column constraints).
  // eslint-disable-next-line no-control-regex -- control characters are exactly the target of this sanitization
  return require('./sanitize').sanitizeText(s)
}

// Named accessor for callers needing the truncating form (todoToRow description, H2 2026-09-16)
function sanitizeText (s, maxLen) { return require('./sanitize').sanitizeText(s, maxLen) }

/** Extra reminder offsets (minutes, negative = earlier) JSON parsing; fault tolerance: invalid/out-of-range values are dropped outright.
 *  The reminders column has two shapes: old = [offset...] numeric array; new = {o:[offsets], x:[absolute ts...]} (multiple reminders) */
function parseOffsets (s) {
  const v = parseReminders(s)
  return v.o
}

function parseReminders (s) {
  const empty = { o: [], x: [] }
  if (!s) return empty
  try {
    const a = JSON.parse(s)
    if (Array.isArray(a)) return { o: normOffsets(a), x: [] }
    if (a && typeof a === 'object') return { o: normOffsets(a.o), x: normAbs(a.x) }
    return empty
  } catch { return empty }
}

function normOffsets (a) {
  if (!Array.isArray(a)) return []
  return [...new Set(a.filter(v => Number.isFinite(v) && v !== 0 && v >= -43200 && v <= 43200).map(Number))].sort((x, y) => x - y)
}

function normAbs (a) {
  if (!Array.isArray(a)) return []
  return [...new Set(a.filter(v => Number.isFinite(v) && v > 0).map(Number))].sort((x, y) => x - y)
}

/** Pack the reminders column: offsets only → keep the old array shape (readable by older versions); extra absolute reminders present → object shape */
function packReminders (offsets, extra) {
  const o = Array.isArray(offsets) ? offsets.filter(v => Number.isFinite(v) && v !== 0) : []
  const x = Array.isArray(extra) ? extra.filter(v => Number.isFinite(v) && v > 0) : []
  if (!o.length && !x.length) return null
  if (!x.length) return JSON.stringify(o)
  return JSON.stringify({ o, x })
}

/** Row -> app object */
function rowToTodo (r) {
  if (!r) return null
  return {
    taskId: r.id,
    userId: r.userId,
    taskContent: r.content,
    taskDescribe: r.description,
    complete: !!r.complete,
    completedAt: r.completedAt || 0,
    deletedAt: r.deletedAt || 0,
    delete: !!r.deleted,
    createTime: r.createdAt,
    updateTime: r.updatedAt,
    syncTime: r.syncTime,
    todoTime: r.scheduledAt,
    dayStart: r.scheduledDay,
    reminderTime: r.remindAt || 0,
    reminderOffsets: parseOffsets(r.reminders),
    reminderExtra: parseReminders(r.reminders).x,
    taskSort: r.sort,
    estimate: r.focusMinutes,
    difficulty: r.difficulty,
    repeatId: r.recurGroupId,
    subtasks: r.subtasks,
    predecessors: r.predecessors,
    image: r.imageUrls,
    files: r.fileAttach,
    categoryId: r.categoryId,
    priority: r.priority || 0,
    deadlineTs: r.deadlineTs || 0,
    important: r.important || 0,
    urgent: r.urgent || 0,
    status: r.status,
    version: r.version
  }
}

/** Category row -> app object */
function rowToCategory (r) {
  if (!r) return null
  return {
    categoryId: r.id,
    userId: r.userId,
    categoryName: r.name,
    categoryColor: r.color,
    createTime: r.createdAt,
    listSort: r.sort,
    folderIs: !!r.isFolder,
    folderId: r.parentId || 0,
    delete: !!r.deleted
  }
}

const dayjs = require('dayjs')
function todoToRow (t) {
  const todoTime = t.todoTime || 0
  return {
    id: t.taskId,
    userId: t.userId != null ? t.userId : null,
    content: t.taskContent != null ? normalizeContent(String(t.taskContent)) : '',
    // H2 2026-09-16: description was stored raw while the title went through normalizeContent —
    // control chars/RTL overrides reached the CLI list/audit output unfiltered. Sanitize + truncate
    // at the same 5000 cap as the title (sanitizeText default).
    description: t.taskDescribe != null ? sanitizeText(String(t.taskDescribe), 5000) : null,
    complete: t.complete ? 1 : 0,
    completedAt: t.completedAt || 0,
    deletedAt: t.deletedAt || 0,
    deleted: t.delete ? 1 : 0,
    createdAt: t.createTime || 0,
    updatedAt: t.updateTime || 0,
    syncTime: t.syncTime || 0,
    scheduledAt: todoTime,
    scheduledDay: todoTime ? +dayjs(todoTime).startOf('day') : 0,
    remindAt: t.reminderTime || 0,
    reminders: packReminders(t.reminderOffsets, t.reminderExtra),
    sort: t.taskSort != null ? t.taskSort : 0,
    focusMinutes: t.estimate || 0,
    difficulty: t.difficulty != null ? t.difficulty : null,
    recurGroupId: t.repeatId != null ? t.repeatId : null,
    subtasks: t.subtasks != null ? t.subtasks : null,
    predecessors: t.predecessors != null ? t.predecessors : null,
    imageUrls: t.image != null ? t.image : null,
    fileAttach: t.files != null ? t.files : null,
    categoryId: t.categoryId != null ? t.categoryId : 0,
    priority: t.priority != null ? t.priority : 0,
    deadlineTs: t.deadlineTs != null ? t.deadlineTs : 0,
    important: t.important != null ? t.important : 0,
    urgent: t.urgent != null ? t.urgent : 0,
    status: t.status || 'add',
    version: t.version || 0
  }
}

module.exports = { normalizeContent, parseOffsets, parseReminders, packReminders, rowToTodo, rowToCategory, todoToRow }
