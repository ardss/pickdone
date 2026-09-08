/**
 * Leftover-from-yesterday migration — on the first open each day, detect yesterday's unfinished scheduled items and ask whether to move them to today
 * Design points:
 * - Ask only once per day (localStorage records the asked date; whatever the user picks counts as asked)
 * - Only target unfinished scheduled items with dayStart = yesterday; repeating-group instances are excluded (they have their own renewal logic; moving would break the group)
 * - Moving goes through the single-source updateTodoFields path (todoTime set to today; dayStart derived at the db layer)
 * - Copy follows the red lines: no blaming, offer choices ("keep at yesterday" is a legitimate option)
 */
import { dayjs, tt, FMT } from './core.js'
import { batchMoveWithUndo } from './confirm.js'

const FLAG_KEY = 'leftoverAskDate'

export async function maybeAskLeftovers (store) {
  try {
    const todayStr = dayjs().format(FMT.date)
    if (localStorage.getItem(FLAG_KEY) === todayStr) return

    const yStart = +dayjs().subtract(1, 'day').startOf('day')
    const yEnd = +dayjs().subtract(1, 'day').endOf('day')
    const list = store.state.todo.todoList.filter(t =>
      !t.complete && !t.delete && !t.repeatId && t.dayStart >= yStart && t.dayStart <= yEnd)
    if (!list.length) return

    const preview = list.slice(0, 3).map(t => `《${t.taskContent}》`).join('、')
    const more = list.length > 3 ? ` ${tt('statsA.core.moreN', { n: list.length })}` : ''
    // This Element build doesn't expose ELEMENT.MessageBox; use the $confirm mounted on the prototype (appUI is the root instance)
    const vm = window.appUI
    if (!vm || !vm.$confirm) return
    try {
      await vm.$confirm(
        tt('statsA.core.leftoverMsg', { n: list.length, preview, more }),
        tt('statsA.core.leftoverTitle'),
        { confirmButtonText: tt('statsA.core.leftoverOk'), cancelButtonText: tt('statsA.core.leftoverCancel'), type: 'info' }
      )
    } catch (e) {
      // Staying on yesterday / manually closing also counts as "already asked today" — otherwise it re-pops on every refresh, the translucent overlay repeatedly covering the page (user feedback)
      try { localStorage.setItem(FLAG_KEY, todayStr) } catch {}
      return
    }
    // Only write the flag when the user explicitly chose "move to today" — avoids being skipped after hesitation
    localStorage.setItem(FLAG_KEY, todayStr)
    const todayStart = +dayjs().startOf('day')
    const snap = list.map(t => ({ id: t.taskId, dayStart: t.dayStart, todoTime: t.todoTime }))
    for (const t of list) {
      // _deferViews: one view rebuild after the loop instead of one per row (each was an O(n) computeViews)
      await store.dispatch('todo/updateTodoFields', { taskId: t.taskId, patch: { todoTime: todayStart, _deferViews: true } })
    }
    store.dispatch('todo/computeViews')
    // Batch move = reversible op: success toast carries group undo (plain success before; consolidated 2026-09-01)
    batchMoveWithUndo(vm, {
      label: tt('statsA.core.movedNToToday', { n: list.length }),
      snap,
      revertOf: r => store.dispatch('todo/updateTodoFields', { taskId: r.id, patch: { dayStart: r.dayStart, todoTime: r.todoTime } })
    })
  } catch (e) { console.warn('[leftovers] detection failed (non-blocking):', e) }
}
