/* Multiple-reminders sub-module extracted from cli/lib.js (2026-09-27 size-ratchet split).
 * Factory-injected deps keep it decoupled from lib.js (no circular require), same pattern as lib-settings.cjs.
 * Multiple reminders (reminderOffsets/reminderExtra — same todos columns the EditPanel writes). */
module.exports = ({ resolveTask, liveTasks, patchTodo, CliError, dayjs, parseDate }) => {
  /** Set reminder offsets: csv of minutes BEFORE the main reminder ("10,30" = 10/30 minutes early, stored as -10/-30;
   *  "0" = on-time; "none" clears). Requires the main reminder to exist (UI also gates the chips on remindTs>0). */
  function setReminderOffsets (input, csv) {
    const t = resolveTask(input, liveTasks())
    if (!t.reminderTime) throw new CliError('task has no main reminder — set it first with edit --reminder <time>', 'NEEDS_MAIN_REMINDER')
    let offsets
    let zeroAbsorbed = false
    if (String(csv).trim().toLowerCase() === 'none') offsets = []
    else {
      offsets = String(csv).split(/[,，\s]+/).filter(Boolean).map(s => {
        const v = parseInt(s, 10)
        if (isNaN(v)) throw new CliError(`bad offset "${s}" (minutes before the main reminder, e.g. "10,30"; 0=on-time; none=clear)`, 'USAGE')
        // D20-DOMB5: db normOffsets (src/main/db-rows.js) silently drops |v| > 43200 minutes
        // (30 days) — a huge offset used to vanish without a word. Reject at the CLI with the
        // limit echoed instead.
        if (Math.abs(v) > 43200) throw new CliError(`bad offset "${s}" (|offset| must be at most 43200 minutes = 30 days — larger values are dropped by the DB)`, 'USAGE')
        // "0" (on-time) is explicitly absorbed: db normOffsets filters 0 out, so writing [0] would silently vanish — map to "no offset" instead
        return v === 0 ? null : -Math.abs(v)
      })
      zeroAbsorbed = offsets.includes(null)
      offsets = [...new Set(offsets.filter(v => v != null))].sort((a, b) => a - b)
    }
    patchTodo(t.taskId, { reminderOffsets: offsets }, { action: 'edit' })
    return {
      taskId: t.taskId, reminderTime: t.reminderTime, reminderOffsets: offsets,
      ...(zeroAbsorbed ? { note: '"0" (on-time) absorbed — no offset row written since the main reminder itself fires on time' } : {})
    }
  }
  /** Set extra absolute reminders (on top of the main one): comma-separated datetimes, same formats as --date; "none" clears */
  function setReminderExtra (input, csv) {
    const t = resolveTask(input, liveTasks())
    let extras
    if (String(csv).trim().toLowerCase() === 'none') extras = []
    else {
      extras = String(csv).split(/[,，]/).map(s => s.trim()).filter(Boolean).map(s => parseDate(s))
      if (!extras.length) throw new CliError('no datetimes given (comma-separated, e.g. "2026-09-05 09:00, 2026-09-06 14:00")', 'USAGE')
    }
    patchTodo(t.taskId, { reminderExtra: extras }, { action: 'edit' })
    return { taskId: t.taskId, reminderExtra: extras.map(ts => dayjs(ts).format('YYYY-MM-DD HH:mm')) }
  }

  /** D19-DOM2 (#3, App parity EditPanel.onRemindersCommit): setting a reminder on a DATELESS task
   *  backfills the date to the start of the reminder's day (`if (!this.e.dateTs) this.e.dateTs =
   *  dayjs(mainTs).startOf('day').valueOf()`). The CLI used to write a bare reminderTime, leaving
   *  a dated reminder on a no-date task the App's todo box never showed. Only fires when the
   *  effective date is 0 (an explicit --date on the same command, or an existing date, wins). */
  function reminderDateBackfill (before, patch) {
    const effective = patch.todoTime !== undefined ? patch.todoTime : (before ? before.todoTime : 0)
    if (patch.reminderTime && !effective) patch.todoTime = dayjs(patch.reminderTime).startOf('day').valueOf()
    return patch
  }

  return { setReminderOffsets, setReminderExtra, reminderDateBackfill }
}
