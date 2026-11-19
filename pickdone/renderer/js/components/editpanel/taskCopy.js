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
    if (!ctx.e || ctx.e.taskId !== taskId) return
    const content = formatTaskHandoff(row, {
      draft: ctx.e, subtasks: ctx.subList, images: ctx.imgList,
      files: ctx.fileList, categoryName: ctx.curCat && ctx.curCat.categoryName,
      categoryColor: ctx.curCat && ctx.curCat.categoryColor,
      projectName: ctx.$store.getters['projectV2/byId'](ctx.$store.getters['projectV2/forTask'](taskId))?.name || '',
      estimate: ctx.tomatoEstimateN, actual: ctx.tomatoActual,
      repeatCount: ctx.repeatCount, repeatRule,
      copiedAt: Date.now()
    })
    await navigator.clipboard.writeText(content)
    ctx.$message.success(ctx.$t('statsE.TodoItem.copiedMsg'))
  } catch (err) {
    reportError('copyTaskFull', err)
    ctx.$message.error(ctx.$t('statsE.TodoItem.copyFailMsg'))
  }
}