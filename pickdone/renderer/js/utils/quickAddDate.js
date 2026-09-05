/** Effective-date decision for quick add — pure logic extracted from the QuickAdd component (unit-testable).
 *  Semantics (project baseline):
 *  - pickedDate=0 (user explicitly chose "no date") → 0; NL parsing no longer applies;
 *  - pickedDate has a value (calendar pick) → used as-is;
 *  - neither set but NL parsing produced a date → use the parsed value;
 *  - nothing at all → default to today; exception: the Todo box page defaults to 0 (the Todo box is the home of no-date tasks; dropping them into today would be counterintuitive). */
export function resolveQuickAddDate ({ pickedDate, parsedTs, inTodoBox, todayTs }) {
  if (pickedDate === 0) return 0
  if (pickedDate) return pickedDate
  if (parsedTs) return parsedTs
  return inTodoBox ? 0 : todayTs
}
