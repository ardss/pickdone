/**
 * Review-page row builders for StatisticsView (pure, translator injected).
 * Extracted verbatim from StatisticsView.vue computeds/methods (pure move):
 *   - buildKpis: the four KPI tiles (value = period total, delta vs baseline daily average)
 *   - buildPeriodBests: three period highlights
 *   - buildAttentionRows: per-category attention allocation bars
 *   - buildTaskFocusRows: task-level focus duration ranking
 * All copy is emitted via the injected t(key, params); keys stay in the statsA shard.
 */
import { kpiDelta } from './insights.js'

const T = 'statsA.StatisticsView.'

/* Rate KPI delta vs baseline rate in percentage points, ±8pp deadband
 * (moved verbatim from StatisticsView.vue methods) */
export function rateDelta (curPct, basePct) {
  if (curPct == null || basePct == null || Math.abs(curPct - basePct) < 8) return null
  return { pct: (curPct - basePct > 0 ? '+' : '') + (curPct - basePct) + '%', dir: curPct > basePct ? 'up' : 'down' }
}

/* Four KPI tiles: the main number is the period total, delta vs baseline daily average x days (equal-length conversion) */
export function buildKpis (m, t) {
  const d = (cur, base) => kpiDelta(cur, base == null ? null : base * m.days, 15)
  const ratePct = m.doneRate == null ? null : Math.round(m.doneRate * 100)
  const baseRatePct = m.baseline.doneRate == null ? null : Math.round(m.baseline.doneRate * 100)
  // Give-up rate: give-ups / total starts (completed + given up); without any starts there is no rate
  const totalRuns = m.tomatoCount + m.giveUps
  const giveupRatePct = totalRuns ? Math.round(m.giveUps / totalRuns * 100) : null
  return [
    { key: 'done', title: t(T + 'kpiDone'), value: `${m.done}`, sub: t(T + 'kpiDoneSub', { n: m.added }), delta: d(m.done, m.baseline.done), goodDir: 'up' },
    { key: 'focus', title: t(T + 'kpiFocus'), value: `${m.focusMins}min`, sub: t(T + 'kpiFocusSub', { n: m.tomatoCount }), delta: d(m.focusMins, m.baseline.focus), goodDir: 'up' },
    { key: 'rate', title: t(T + 'kpiRate'), value: ratePct == null ? '—' : `${ratePct}%`, sub: t(T + 'kpiRateSub', { n: m.planned }), delta: rateDelta(ratePct, baseRatePct), goodDir: 'up' },
    { key: 'giveup', title: t(T + 'kpiGiveup'), value: `${m.giveUps}`, sub: giveupRatePct == null ? t(T + 'kpiGiveupSub') : t(T + 'kpiGiveupRate', { n: giveupRatePct }), delta: d(m.giveUps, m.baseline.giveUps), goodDir: 'down' }
  ]
}

/* Period bests: three highlights of the review page */
export function buildPeriodBests (m, t) {
  const fmtD = d => d ? d.label : '—'
  const bests = [
    { title: t(T + 'bestFocusDay'), value: m.bestFocusDay ? t(T + 'bestFocusVal', { n: m.bestFocusDay.mins }) : '—', sub: m.bestFocusDay ? fmtD(m.bestFocusDay) : t(T + 'bestNoFocus') },
    { title: t(T + 'bestDoneDay'), value: m.bestDoneDay ? t(T + 'bestDoneVal', { n: m.bestDoneDay.count }) : '—', sub: m.bestDoneDay ? fmtD(m.bestDoneDay) : t(T + 'bestNoDone') },
    { title: t(T + 'bestStreak'), value: t(T + 'bestStreakVal', { n: m.streak }), sub: m.streak >= 2 ? t(T + 'streakHabit') : t(T + 'streakStart') }
  ]
  return bests
}

/* Attention allocation: per-category focus minute bars (falls back to completion counts when focus records are sparse) */
export function buildAttentionRows (m, t) {
  const useFocus = m.focusMins >= 15 && m.catFocus.length
  const list = useFocus ? m.catFocus : m.catDone
  const total = list.reduce((s, i) => s + i.value, 0) || 1
  const unit = useFocus ? t(T + 'unitMinutes') : t(T + 'unitCount')
  return list.slice(0, 6).map(i => ({
    label: i.label, valueText: t(T + 'attValue', { v: i.value, unit }),
    pct: Math.max(4, Math.round(i.value / total * 100)), raw: i.value
  }))
}

/* Where focus went: task-level focus duration ranking (unlinked = free focus, listed separately) */
export function buildTaskFocusRows (m, todos, t) {
  if (m.focusMins < 15 || !m.taskFocus.length) return []
  return m.taskFocus.slice(0, 6).map(i => {
    let label
    if (i.label === '_free') label = t(T + 'freeFocus')
    else {
      const task = todos.find(x => x.taskId === i.label)
      label = task ? (task.taskContent || t(T + 'untitled')) : t(T + 'taskGone')
    }
    return {
      label,
      valueText: t(T + 'attValue', { v: i.value, unit: t(T + 'unitMinutes') }),
      pct: Math.max(4, Math.round(i.value / m.focusMins * 100))
    }
  })
}
