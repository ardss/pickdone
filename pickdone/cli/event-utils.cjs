/* Pure helpers for the events-import path (extracted from lib.js for the line ratchet). eventKey needs the lib's dayStartOf/parseDate — passed in. */
function eventFocusMinutes (mins) {
  // Focus duration = wall-clock duration ×0.75 (reserving breaks), rounded to 25-min whole tomatoes, minimum one tomato
  return Math.max(25, Math.round(mins * 0.75 / 25) * 25)
}
function eventEnd (e) {
  let [h2, m2] = String(e.end || '').split(':').map(Number)
  if (h2 === 24) { h2 = 23; m2 = 59 }
  return { h: h2, m: m2 }
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
module.exports = { eventFocusMinutes, eventEnd, eventKey, pidsFromNetstatOutput }
