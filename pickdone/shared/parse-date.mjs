/**
 * Shared milestone-date parsing — single source for the renderer (utils/milestones.js)
 * and the CLI (cli/lib.js). Pure: the dayjs factory is injected by the caller, so this
 * module is requireable/importable from both the browser bundle and Node (same pattern
 * as shared/limits.mjs; the CLI uses require(esm)).
 *
 * Accepted forms (all resolved to the millisecond timestamp of that day at 00:00):
 *   today | 明天 | +Nd / -Nd (the trailing 'd' optional)
 *   YYYY-MM-DD (any of / . - as separators; dayjs handles the parse)
 *   M-D / M.D / M/D  — bare month/day WITHOUT a year is completed with the CURRENT year
 *   and validated explicitly: V8's fallback Date parse turns '9/22' into 2001-09-22 and
 *   reports it valid, so the old dayjs-first order silently landed the milestone/deadline
 *   25 years in the past. Invalid month/day (e.g. 2-30, 13/1) returns null instead of
 *   dayjs's silent carry-over.
 */
export function parseMilestoneDateCore (input, dayjs) {
  const s = String(input || '').trim().toLowerCase()
  if (!s) return null
  const y = dayjs().year()
  // Bare M/D, M.D, M-D must be dispatched BEFORE the bare dayjs(s) attempt —
  // V8's fallback Date parsing turns '9-22' into 2001-09-22 and dayjs reports it valid.
  const md = s.match(/^(\d{1,2})[/.-](\d{1,2})$/)
  if (md) {
    const mm = +md[1]
    const dd = +md[2]
    if (mm < 1 || mm > 12) return null
    const dim = dayjs().year(y).month(mm - 1).daysInMonth()
    if (dd < 1 || dd > dim) return null
    return +dayjs(`${y}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`).startOf('day')
  }
  let d = null
  if (s === 'today') d = dayjs()
  if (s === '明天') d = dayjs().add(1, 'day')
  if (d == null) { const m = s.match(/^([+-])(\d+)d?$/); if (m) d = dayjs().add(m[1] === '+' ? +m[2] : -m[2], 'day') }
  if (d == null) d = dayjs(s)
  return d.isValid() ? +d.startOf('day') : null
}
