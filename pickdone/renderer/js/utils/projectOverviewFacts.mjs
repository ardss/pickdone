// Facts for the project cards. Every value is derived from stored tasks, milestones or episodes.
export function projectOverviewFacts (tasks, milestones, episodes, today) {
  const live = (tasks || []).filter(t => !t.delete)
  const ordered = (milestones || []).filter(m => m && m.title && Number.isFinite(Number(m.date)))
    .sort((a, b) => Number(a.date) - Number(b.date))
  const milestoneDone = m => {
    const ids = new Set(m.taskIds || [])
    const linked = live.filter(t => ids.has(t.taskId))
    return Number(m.date) < today && (!linked.length || linked.every(t => t.complete))
  }
  const nextMilestone = ordered.find(m => !milestoneDone(m)) || null
  const overdueTasks = live.filter(t => !t.complete && Number(t.dayStart) > 0 && Number(t.dayStart) < today).length
  const overdueMilestones = ordered.filter(m => Number(m.date) < today && !milestoneDone(m)).length
  const rows = (episodes && episodes.tasks || []).filter(r => r.episodeCount > 0)
    .sort((a, b) => Number(b.lastEpisodeAt) - Number(a.lastEpisodeAt))
  const recent = episodes && episodes.recent && episodes.recent[0]
  const latestTaskWork = rows[0]
  const completed = live.filter(t => t.complete && t.completedAt)
    .sort((a, b) => Number(b.completedAt) - Number(a.completedAt))[0]
  const nextAction = rows.find(r => r.lastNextAction && r.lastNextAction.trim())
  const pending = live.filter(t => !t.complete)
    .sort((a, b) => (Number(a.dayStart) || Infinity) - (Number(b.dayStart) || Infinity))[0]
  return {
    nextMilestone, overdueTasks, overdueMilestones,
    recentWork: (latestTaskWork && (latestTaskWork.lastOutcome || latestTaskWork.lastGoal)) ||
      (recent && recent.goal) || (completed && completed.content) || '',
    recentAt: latestTaskWork && (latestTaskWork.lastOutcome || latestTaskWork.lastGoal)
      ? Number(latestTaskWork.lastEpisodeAt) || 0
      : recent && recent.goal ? Number(recent.startedAt) || 0 : Number(completed && completed.completedAt) || 0,
    nextAction: nextAction ? nextAction.lastNextAction : (pending && pending.content) || '',
    nextActionFromEpisode: Boolean(nextAction)
  }
}
