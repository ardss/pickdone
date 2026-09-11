/**
 * Project milestones — meta persistence (`projectMilestones:<categoryId>`), zero schema changes.
 * Structure: [{ id, title, date, taskIds? }]  date is the millisecond timestamp of that day at 00:00; taskIds are linked tasks (optional).
 * States: done (≤ yesterday) / today / future; achievement is date-driven (user's call),
 *       but milestones with linked tasks carry a completion percentage (Linear-style: progress is grown from tasks; source: docs/竞品调研-项目管理.md).
 * The CLI side (cli/lib.js) reads/writes the same meta key; both ends share one source.
 */
import { dayjs } from './core.js'

const keyOf = categoryId => 'projectMilestones:' + categoryId

/** Fresh milestone id (saveMilestones keeps caller-supplied ids, so pre-generating one lets the
 *  caller reference the just-added entry after the date-sorted save, e.g. for an entrance animation) */
export function newMilestoneId () {
  return 'ms_' + Date.now() + Math.random().toString(36).slice(2, 6)
}

export async function loadMilestones (categoryId) {
  try {
    const raw = await window.todoAPI.dbCall('getMeta', keyOf(categoryId))
    const list = JSON.parse(raw || '[]')
    // Number(m.date) parseable only — aligns with the CLI side's tolerance so a corrupt/legacy
    // non-numeric date can never poison the sort (`NaN` comparisons) downstream
    return Array.isArray(list) ? list.filter(m => m && m.title && m.date && !Number.isNaN(Number(m.date))) : []
  } catch { return [] }
}

export function saveMilestones (categoryId, list) {
  const clean = (list || []).filter(m => m && m.title && m.date)
    .map(m => ({
      id: m.id || newMilestoneId(),
      title: String(m.title),
      date: Number(m.date),
      taskIds: Array.isArray(m.taskIds) ? m.taskIds.filter(Boolean) : []
    }))
    .sort((a, b) => a.date - b.date)
  // Write failure is now observable: the resolved boolean lands on clean.savePromise (existing callers keep
  // receiving the plain sorted array; JSON.stringify of an array ignores the extra property).
  // 2026-09-12: the old `.catch(() => {})` swallowed setMeta failures, so a failed save silently lost edits.
  let savePromise = Promise.resolve(false)
  try {
    savePromise = window.todoAPI.dbCall('setMeta', [keyOf(categoryId), JSON.stringify(clean)])
      .then(() => true, e => { console.error('[milestones] saveMilestones setMeta failed for', categoryId, e); return false })
  } catch (e) { console.error('[milestones] saveMilestones db bridge unavailable:', e) } // in-memory only when running in a debug host without the DB bridge
  clean.savePromise = savePromise
  return clean
}

/** Parse a user-entered date: YYYY-MM-DD / MM-DD (current year) / today|明天 (tomorrow) / +N days */
export function parseMilestoneDate (input) {
  const s = String(input || '').trim().toLowerCase()
  if (!s) return null
  const y = dayjs().year()
  let d = dayjs(s)
  if (!d.isValid() && /^\d{1,2}-\d{1,2}$/.test(s)) d = dayjs(`${y}-${s}`)
  if (!d.isValid() && s === 'today') d = dayjs()
  if (!d.isValid() && s === '明天') d = dayjs().add(1, 'day')
  if (!d.isValid()) { const m = s.match(/^([+-])(\d+)d?$/); if (m) d = dayjs().add(m[1] === '+' ? +m[2] : -m[2], 'day') }
  return d.isValid() ? +d.startOf('day') : null
}

export function milestoneState (ms, today0 = +dayjs().startOf('day')) {
  if (ms.date < today0) return 'done'
  if (ms.date === today0) return 'today'
  return 'future'
}

/**
 * Milestone progress (N2): with linked tasks → completion ratio = linked tasks completed / total (Linear-style, progress grown from tasks);
 * without linked tasks → null (purely date-driven; the UI just shows the state).
 * tasks: all tasks under this project (including completed, excluding deleted).
 */
export function milestoneProgress (ms, tasks) {
  const ids = new Set(ms.taskIds || [])
  if (!ids.size) return null
  const linked = tasks.filter(t => ids.has(t.taskId))
  if (!linked.length) return null
  const done = linked.filter(t => t.complete).length
  return { done, total: linked.length, pct: Math.round(done / linked.length * 100) }
}

/** Due-soon warning (N3): milestone or deadline ≤3 days away and not yet due (including today); overdue is reported separately */
export function dueStateOf (ts, today0 = +dayjs().startOf('day')) {
  const days = Math.round((ts - today0) / 864e5)
  if (days < 0) return 'overdue'
  if (days <= 3) return 'soon'
  return 'ok'
}
