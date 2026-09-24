/**
 * EditPanel repeat orchestration — extracted from EditPanel.vue (maint/dw-arch 2026-09-24, D1 knife 3).
 *
 * Pure move, zero behavior change: functions take the component as `ctx` and read/write the same
 * state (e/repeatCount) through it. askRepeatEdit/askRepeatDelete open the shared repeat modals via
 * the ui store; repeatGroupInfo keeps its stale-response race guard (task id captured before the
 * await, applied only if the panel still shows that task — see d5-ui-fixes anchor test).
 */
export function askRepeatEdit (ctx) { ctx.$store.commit('ui/askRepeatEdit', ctx.e.taskId) }
export function askRepeatDelete (ctx) { ctx.$store.commit('ui/askRepeatDelete', ctx.e.taskId) }

export async function repeatGroupInfo (ctx) {
  if (!ctx.e || !ctx.e.repeatId) { ctx.repeatCount = 0; return }
  try {
    // Capture the task id before the await: if the panel switches to another task while the
    // query is in flight, the stale result must not overwrite the new task's repeat count
    const taskId = ctx.e.taskId
    const rows = await window.todoAPI.dbCall('queryTodos', { deleted: 0, repeatId: ctx.e.repeatId })
    if (ctx.e && ctx.e.taskId === taskId) ctx.repeatCount = rows.length
  } catch (err) { /* ignored */ }
}
