/**
 * Cross-day move patch builder (single source for TodoItem drag / DayDeck card drop / TodoBoxView
 * batch "move to today"). dayStart is the bucketing key; time-of-day anchored to the OLD day must
 * survive the move on the NEW day, anything else stays untouched. Pure: the day-boundary resolver
 * is injected (startOfDay), so this module is importable from Node tests without dayjs.
 *
 * [maint-0924 A1/A2] extracted from TodoItem.vue (was the only correct implementation);
 * TodoBoxView.batchToday used to hard-write todoTime=today 00:00 (wiping a 14:30 schedule) and
 * DayDeck.onDrop never moved reminderTime (orphaning the reminder on the old day).
 */

/** Build the patch for moving `dragged` to the new day `newDay`.
 *  - todoTime: follows the new day only when anchored to the old day, keeping its time-of-day
 *    (a 14:30 schedule stays 14:30 on the new day; a pure midnight day marker stays a marker).
 *  - reminderTime / reminderExtra: same rule — reminders cannot be orphaned on the old day, and
 *    extra reminders keep their own times of day when their day matches the old day.
 *  Fields not anchored to the old day are omitted from the patch (left untouched). */
export function crossDayMovePatch (dragged, newDay, startOfDay) {
  const patch = { dayStart: newDay }
  const origDay = (dragged && dragged.dayStart) || 0
  if (dragged.todoTime && startOfDay(dragged.todoTime) === startOfDay(origDay)) {
    patch.todoTime = newDay + (dragged.todoTime - startOfDay(dragged.todoTime))
  }
  if (dragged.reminderTime && startOfDay(dragged.reminderTime) === startOfDay(origDay)) {
    patch.reminderTime = newDay + (dragged.reminderTime - startOfDay(dragged.reminderTime))
  }
  const extras = Array.isArray(dragged.reminderExtra) ? dragged.reminderExtra : []
  if (extras.length) {
    let shifted = false
    const next = extras.map(x => {
      if (x && startOfDay(x) === startOfDay(origDay)) {
        shifted = true
        return newDay + (x - startOfDay(x))
      }
      return x
    })
    if (shifted) patch.reminderExtra = next
  }
  return patch
}

/** Revert patch for the fields a crossDayMovePatch actually touched (original values from `orig`).
 *  Undo must restore exactly what the move rewrote — nothing more. */
export function crossDayRevertPatch (orig, patch) {
  const revert = { dayStart: (orig && orig.dayStart) || 0 }
  for (const k of ['todoTime', 'reminderTime', 'reminderExtra']) {
    if (k in patch) revert[k] = orig[k]
  }
  return revert
}
