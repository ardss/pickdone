/* Pure helpers for the events-import path (extracted from lib.js for the line ratchet). eventKey needs the lib's dayStartOf/parseDate — passed in. */
function eventFocusMinutes (mins) {
  // Focus duration = wall-clock duration ×0.75 (reserving breaks), rounded to 25-min whole tomatoes, minimum one tomato
  return Math.max(25, Math.round(mins * 0.75 / 25) * 25)
}
/** cli-5: strict HH:mm validator for the events-import path. Returns {h, m} or null.
 *  Garbage like '9:xx' or '25:99' used to flow through `String(e.start).split(':').map(Number)`
 *  and produced NaN arithmetic (NaN durations, nonsense task times) that still counted as a
 *  created event. `allow24` accepts exactly '24:00' (end-of-day sentinel, clamped to 23:59). */
function parseHHmm (s, { allow24 = false } = {}) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s == null ? '' : s).trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (min > 59) return null
  if (h === 24 && allow24 && min === 0) return { h: 24, m: 0 }
  if (h > 23) return null
  return { h, m: min }
}
function eventEnd (e) {
  const t = parseHHmm(e.end, { allow24: true })
  if (!t) return { h: NaN, m: NaN }
  if (t.h === 24) return { h: 23, m: 59 }
  return t
}
function eventKey (e, dayStartOf, parseDate) {
  return dayStartOf(parseDate(e.date + ' ' + e.start)) + '|' + String(e.title || '').trim()
}
/** M-13 (2026-09-20): pure parse of `netstat -ano` LISTENING output — unique numeric pids from
 *  the last column. Extracted from cli/check-all.js's win32 orphan-reap fallback so it can be
 *  unit-tested without spawning netstat. Empty/garbage input → []. */
function pidsFromNetstatOutput (text) {
  return [...new Set(String(text || '').split(/\r?\n/)
    .map(l => l.trim().split(/\s+/).pop())
    .filter(p => /^\d+$/.test(p)))]
}
module.exports = { eventFocusMinutes, eventEnd, eventKey, pidsFromNetstatOutput, parseHHmm }
