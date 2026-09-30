/**
 * Leftover-from-yesterday migration — on the first open each day, detect yesterday's unfinished scheduled items and ask whether to move them to today
 * Design points:
 * - Ask only once per day (localStorage records the asked date; whatever the user picks counts as asked)
 * - Only target unfinished scheduled items with dayStart = yesterday; repeating-group instances are excluded (they have their own renewal logic; moving would break the group)
 * - Moving goes through the single-source updateTodoFields path (todoTime set to today; dayStart derived at the db layer)
 * - Copy follows the red lines: no blaming, offer choices ("keep at yesterday" is a legitimate option)
 */
import { dayjs, tt, FMT } from './core.js'
import { batchMoveWithUndo, isRepeatTask } from './confirm.js'
import { crossDayMovePatch, crossDayRevertPatch } from './crossDayMove.js'

const FLAG_KEY = 'leftoverAskDate'

/** Y5 (sync-coverage-2): the asked-date flag moved from localStorage to the syncable meta entity
 *  (setMeta('leftoverAskDate', 'YYYY-MM-DD'); date-string LWW is merge-safe). LS stays as a
 *  write-through cache so the sync-current-day read still works pre-migration / in degraded hosts. */
async function askedToday (todayStr) {
  try {
    if (window.todoAPI && window.todoAPI.dbCall) {
      const v = await window.todoAPI.dbCall('getMeta', FLAG_KEY)
      if (v === todayStr) return true
    }
  } catch (e) { /* meta unavailable: fall through to LS */ }
  try { return localStorage.getItem(FLAG_KEY) === todayStr } catch (e) { return false }
}
function markAsked (todayStr) {
  try { localStorage.setItem(FLAG_KEY, todayStr) } catch (e) { /* empty */ }
  try {
    if (window.todoAPI && window.todoAPI.dbCall) window.todoAPI.dbCall('setMeta', [FLAG_KEY, todayStr]).catch(e => console.error('[leftovers] setMeta flag failed:', e))
  } catch (e) { /* degraded host: LS only */ }
}

export async function maybeAskLeftovers (store) {
  try {
    const todayStr = dayjs().format(FMT.date)
    if (await askedToday(todayStr)) return

    const yStart = +dayjs().subtract(1, 'day').startOf('day')
    const yEnd = +dayjs().subtract(1, 'day').endOf('day')
    const list = store.state.todo.todoList.filter(t =>
      !t.complete && !t.delete && !isRepeatTask(t) && t.dayStart >= yStart && t.dayStart <= yEnd)
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
      markAsked(todayStr)
      return
    }
    // Only write the flag when the user explicitly chose "move to today" — avoids being skipped after hesitation
    markAsked(todayStr)
    const todayStart = +dayjs().startOf('day')
    const startOfDay = ts => +dayjs(ts).startOf('day')
    const snap = list.map(t => {
      const patch = crossDayMovePatch(t, todayStart, startOfDay)
      return { id: t.taskId, orig: JSON.parse(JSON.stringify(t)), patch }
    })
    for (const s of snap) {
      // _deferViews: one view rebuild after the loop instead of one per row (each was an O(n) computeViews)
      // [leftover-move-wipes-time fix] the raw {todoTime: todayStart} patch wiped the task's
      // time-of-day (a 14:30 schedule moved to today 00:00) and orphaned reminderTime/reminderExtra
      // on the old day — same single-source crossDayMovePatch the drag/batch moves use.
      const patch = { ...s.patch, _deferViews: true }
      await store.dispatch('todo/updateTodoFields', { taskId: s.id, patch })
    }
    store.dispatch('todo/computeViews')
    // Batch move = reversible op: success toast carries group undo (plain success before; consolidated 2026-09-01)
    batchMoveWithUndo(vm, {
      label: tt('statsA.core.movedNToToday', { n: list.length }),
      snap,
      // Revert restores exactly the fields the cross-day move rewrote (dayStart + the anchored
      // time-of-day fields), not a blind two-field guess
      revertOf: r => store.dispatch('todo/updateTodoFields', { taskId: r.id, patch: crossDayRevertPatch(r.orig, r.patch) })
    })
  } catch (e) { console.warn('[leftovers] detection failed (non-blocking):', e) }
}
