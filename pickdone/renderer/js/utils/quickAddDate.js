/** Effective-date decision for quick add — pure logic extracted from the QuickAdd component (unit-testable).
 *  Semantics (project baseline):
 *  - pickedDate=0 (user explicitly chose "no date") → 0; NL parsing no longer applies;
 *  - pickedDate has a value (calendar pick) → used as-is;
 *  - neither set but NL parsing produced a date → use the parsed value;
 *  - nothing at all → default to today; exception: the Todo box page defaults to 0 (the Todo box is the home of no-date tasks; dropping them into today would be counterintuitive);
 *  - exception 2 (journey-audit J1, 2026-10-22): on the today page with a NON-today day selected in
 *    the date strip, that selected day is the add target. The day view's empty state promises
 *    "add a task to this day"; defaulting to today silently moved the row off the screen the user
 *    was looking at. viewDayTs is the selected day's start-of-day ts (0/undefined = today). */
export function resolveQuickAddDate ({ pickedDate, parsedTs, inTodoBox, todayTs, viewDayTs }) {
  if (pickedDate === 0) return 0
  if (pickedDate) return pickedDate
  if (parsedTs) return parsedTs
  if (inTodoBox) return 0
  if (viewDayTs && viewDayTs !== todayTs) return viewDayTs
  return todayTs
}

/** Reminder handoff for a time-bearing NL add (config-surface-auditor P2, 2026-10-22).
 *  Both parser branches append a trailing 'HH:mm' to `label` exactly when a time-of-day phrase was
 *  consumed ("明天 15:00", "20:00", "tomorrow 15:00"); a date-only parse never does. The chip shows
 *  that time, so the created task must carry it as reminderTime — the old hardcoded
 *  todoReminderTime: 0 made the quick-add silently promise a reminder it never set.
 *  - a manual date chip (pickedDate != null, incl. the explicit-clear 0) wins the date, so the
 *    NL time must NOT become a reminder on a different day;
 *  - multi-line paste lines never go through NL parsing (createLines contract) → callers pass
 *    parsed: null and get 0.
 *  Pure and unit-testable. */
export function reminderTsFromParse ({ pickedDate, parsed }) {
  if (pickedDate != null) return 0
  if (!parsed || !parsed.date) return 0
  if (!/(\d{2}:\d{2})$/.test(String(parsed.label || '').trim())) return 0
  return parsed.date.valueOf()
}
