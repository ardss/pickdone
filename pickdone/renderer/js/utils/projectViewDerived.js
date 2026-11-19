import { dayjs, FMT } from './core.js'
import { dayShift } from './todayBounds.js'
import { milestoneState } from './milestones.js'

export function buildProjectTrend7 ({ todayTs, tasks, t }) {
  const days = []
  for (let i = 6; i >= 0; i--) {
    const d0 = dayShift(todayTs, -i)
    const d1 = dayShift(d0, 1)
    days.push({
      n: tasks.filter(task => task.complete && task.completedAt >= d0 && task.completedAt < d1).length,
      label: i === 0 ? t('statsB.ProjectView.today') : dayjs(d0).format(FMT.cnDate)
    })
  }
  return days
}

export function buildProjectTimeline ({ milestones, startedAt, todayTs, deadlineTs, pos, currentMilestone, tasks, t, fmtDate }) {
  const start = startedAt || todayTs
  const liveTasks = tasks.filter(task => !task.delete)
  return {
    todayPct: pos(todayTs),
    marks: [
      { type: 'start', pct: pos(start), label: t('statsB.ProjectView.startWith', { d: fmtDate(start) }) },
      ...milestones.map(m => {
        const state = milestoneState(m, todayTs, liveTasks)
        const focus = currentMilestone && currentMilestone.id === m.id && state !== 'done'
        return {
          type: focus ? 'focus' : state,
          id: m.id,
          pct: pos(m.date),
          label: (focus ? t('statsB.ProjectView.currentTag') : '') + m.title + ' · ' + fmtDate(m.date) + t('statsB.ProjectView.msEditHint'),
          ms: m
        }
      }),
      ...(deadlineTs ? [{ type: 'deadline', pct: pos(deadlineTs), label: t('statsB.ProjectView.deadlineWith', { d: fmtDate(deadlineTs) }) }] : []),
      { type: 'today', pct: pos(todayTs), label: t('statsB.ProjectView.today'), tip: t('statsB.ProjectView.today') }
    ]
  }
}

export function calculateProjectStats (list) {
  const done = list.filter(t => t.complete)
  const live = list.filter(t => !t.delete)
  const startedAt = live.reduce((m, t) => Math.min(m, t.createTime || m), Infinity)
  const lastAct = done.reduce((m, t) => Math.max(m, t.completedAt || 0), 0)
  return {
    total: live.length,
    doneCount: done.length,
    progress: live.length ? Math.round(done.length / live.length * 100) : 0,
    focusMinutes: live.reduce((s, t) => s + (t.estimate || 0), 0),
    startedAt: isFinite(startedAt) ? startedAt : 0,
    lastActivity: lastAct
  }
}
