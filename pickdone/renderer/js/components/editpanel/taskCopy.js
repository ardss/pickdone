/**
 * Copy the current task snapshot into a portable text handoff.
 * Keep edit-panel save ordering and toasts at the consumer boundary.
 */
import { reportError } from '../../utils/core.js'
import { formatTaskHandoff } from '../../utils/taskHandoff.mjs'

export async function copyTaskFull (ctx) {
  const taskId = ctx.e && ctx.e.taskId
  if (!taskId) return
  try {
    const result = await ctx.flushSave()
    if (result === false || (Array.isArray(result) && result.includes(false)) || ctx.saveFailed) {
      throw new Error('task save failed')
    }
    if (!ctx.e || ctx.e.taskId !== taskId) return
    const row = ctx.task
    if (!row || row.taskId !== taskId) throw new Error('task not found')
    // The visible repeat-rule modal uses the persisted repeatRule:<repeatId> entry.
    // Do not confuse the repeat-group ID with the actual rule the user selected.
    let repeatRule = null
    if (ctx.e.repeatId) {
      repeatRule = await window.todoAPI.dbCall('getMeta', 'repeatRule:' + ctx.e.repeatId)
    }
    // The optional user-visible Work/Episode panel is another persisted surface of
    // the task. Include ALL its displayed collections when that panel is enabled.
    const workPanel = ctx.$refs.workBlock
    let work = null
    if (workPanel && workPanel.taskId === taskId) {
      // Fetch all four persisted collections as an all-or-fail snapshot.
      // The child UI intentionally tolerates partial read failures; full copy must not.
      const [episodes, sources, findings, decisions] = await Promise.all([
        window.todoAPI.dbCall('queryEpisodesByTask', taskId),
        window.todoAPI.dbCall('querySourcesByTask', taskId),
        window.todoAPI.dbCall('queryFindingsByTask', taskId),
        window.todoAPI.dbCall('queryDecisionsByTask', taskId)
      ])
      work = {
        currentText: episodes.length ? String(episodes[episodes.length - 1].summary || '') : '',
        episodes,
        findings,
        decisions,
        sources,
        unsubmittedForm: {
          episode: workPanel.epForm,
          finding: workPanel.fndForm,
          decision: workPanel.decForm,
          source: workPanel.srcForm
        }
      }
    }
    if (!ctx.e || ctx.e.taskId !== taskId) return
    const content = formatTaskHandoff(row, {
      draft: ctx.e, subtasks: ctx.subList, images: ctx.imgList,
      files: ctx.fileList, categoryName: ctx.curCat && ctx.curCat.categoryName,
      categoryColor: ctx.curCat && ctx.curCat.categoryColor,
      estimate: ctx.tomatoEstimateN, actual: ctx.tomatoActual,
      repeatCount: ctx.repeatCount, repeatRule, work,
      copiedAt: Date.now(),
      focusRecords: (((ctx.$store.state.tomato || {}).tomatoRecordList) || [])
        .filter(record => record && record.focusTaskId === taskId)
    })
    await navigator.clipboard.writeText(content)
    ctx.$message.success(ctx.$t('statsE.TodoItem.copiedMsg'))
  } catch (err) {
    reportError('copyTaskFull', err)
    ctx.$message.error(ctx.$t('statsE.TodoItem.copyFailMsg'))
  }
}