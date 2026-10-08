#!/usr/bin/env node
/**
 * Formatting helpers for cli/pickdone.js — extracted unchanged (size ratchet: pure move).
 */
const dayjs = require('dayjs')

/* ================= formatting ================= */
const NO_DATE = 'no date'
/** `--date none|clear` = clear the date (task moves back to the todo box) — exact words, case-insensitive.
 *  '' is accepted too (review P2 2026-09-10): `--date ""` used to slip past this into parseDate('')=0, a
 *  partial todoTime-only write the App can never produce (no reminder drop, no chip cascade). */
const isDateClear = v => v != null && v !== true && /^(none|clear)?$/.test(String(v).trim().toLowerCase())
/** `--reminder none|clear` clears the main reminder — same clear words as --date (review P2 2026-09-10:
 *  it used to go straight to parseDate and throw, unlike --remind-offset/--remind-extra which accept none) */
const isReminderClear = v => v != null && v !== true && /^(none|clear)$/.test(String(v).trim().toLowerCase())
function fmtDay (t) {
  if (!t.dayStart && !t.todoTime) return NO_DATE
  return dayjs(t.todoTime || t.dayStart).format('MM-DD HH:mm').replace(' 00:00', '')
}
function fmtTodoLine (t, lunarOf) {
  const mark = t.complete ? '[x]' : '[ ]'
  const due = fmtDay(t)
  const parts = [mark, t.taskContent]
  if (t.taskDescribe) parts.push('— ' + t.taskDescribe.split('\n')[0].slice(0, 40))
  if (t.reminderTime) parts.push('⏰' + dayjs(t.reminderTime).format('MM-DD HH:mm'))
  if (due !== NO_DATE) parts.push(lunarOf && lunarOf(t) ? `(${due} · ${lunarOf(t)})` : '(' + due + ')')
  return parts.join('  ')
}

/** audit changes summary: list changed semantic fields (before→after) */
const FIELD_LABEL = { taskContent: 'title', taskDescribe: 'desc', complete: 'complete', completedAt: 'completedAt', todoTime: 'date', reminderTime: 'reminder', categoryId: 'category', repeatId: 'repeatGroup', subtasks: 'subtasks', delete: 'delete', status: 'status', estimate: 'estimate', tomatoEstimate: 'tomatoEstimate', deadlineTs: 'deadline', priority: 'priority', important: 'important', urgent: 'urgent' }
const ts = v => (typeof v === 'number' && v > 1e11) ? dayjs(v).format('MM-DD HH:mm') : v
// maint/d24 P3: categoryIds are minted Date.now()*1000 (+rand) — the generic ts() date formatter
// read them as timestamps ("category: 02-02 06:14 → ∅"). Render them as the bare `cat <id>` token.
const valOf = (k, v) => k === 'categoryId' && v != null ? 'cat ' + String(v) : ts(v)
function summarizeChanges (changes) {
  const parts = []
  for (const c of changes || []) {
    const keys = new Set([...Object.keys(c.before || {}), ...Object.keys(c.after || {})])
    const diffs = []
    for (const k of keys) {
      const b = c.before ? c.before[k] : undefined
      const a = c.after ? c.after[k] : undefined
      if (JSON.stringify(b) !== JSON.stringify(a)) diffs.push(`${FIELD_LABEL[k] || k}: ${valOf(k, b) ?? '∅'} → ${valOf(k, a) ?? '∅'}`)
    }
    if (diffs.length) parts.push(diffs.join(', '))
    else if (!c.before && c.after) parts.push('created')
    else if (c.before && !c.after) parts.push('purged')
  }
  return parts.join(' | ')
}

module.exports = { NO_DATE, isDateClear, isReminderClear, fmtDay, fmtTodoLine, FIELD_LABEL, ts, summarizeChanges }
