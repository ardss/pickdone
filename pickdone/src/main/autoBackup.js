/**
 * Automatic backup strategy (pure functions, no Electron dependency — shared by the main process and unit tests)
 * File naming: auto-YYYYMMDD-HHMMSS.json (periodic snapshot) / evt-<reason>-YYYYMMDD-HHMMSS.json (pre-dangerous-operation snapshot)
 * Retention policy (GFS tiers): auto files keep the most recent N + daily anchors (latest one per day, kept for D days) + weekly anchors (latest one per week, kept for W weeks);
 *                     evt files are grouped by reason, keeping K per group.
 */

const RE_AUTO = /^auto-(\d{8})-(\d{6})\.json$/
const RE_EVT = /^evt-([a-z0-9-]+)-(\d{8})-(\d{6})\.json$/

function nameToTs (name) {
  const m = RE_AUTO.exec(name) || RE_EVT.exec(name)
  if (!m) return 0
  const [, a, b] = RE_EVT.exec(name) ? [null, m[2], m[3]] : [null, m[1], m[2]]
  const s = a // YYYYMMDD
  const t = b // HHMMSS
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6))
}

/**
 * @param {string[]} names all backup file names
 * @param {object} o { recent=24, dailyDays=14, weeklyWeeks=8, eventKeep=10 }
 * @returns {string[]} file names to delete
 */
function selectPrunes (names, o = {}) {
  const { recent = 24, dailyDays = 14, weeklyWeeks = 8, eventKeep = 10 } = o
  const autos = names.filter(n => RE_AUTO.test(n)).sort().reverse() // new → old
  const evts = names.filter(n => RE_EVT.test(n)).sort().reverse()
  const keep = new Set()
  const prunes = []

  // 1) Keep the most recent N in full
  autos.forEach((n, i) => { if (i < recent) keep.add(n) })

  // 2) Among the older ones: keep the latest one per calendar day (within D days), then the latest one per week (within W weeks)
  const rest = autos.filter(n => !keep.has(n))
  const seenDays = new Set()
  const seenWeeks = new Set()
  const DAY = 86400000
  for (const n of rest) {
    const ts = nameToTs(n)
    const d = new Date(ts)
    const dayKey = n.slice(5, 13) // YYYYMMDD
    // Week anchor: compute "which week" from the timestamp (integer weeks bounded by Thursday 1970-01-01 is sufficient; no exact calendar needed)
    const weekKey = Math.floor(ts / (DAY * 7))
    const dayIdx = seenDays.size
    const weekIdx = seenWeeks.size
    if (dayIdx < dailyDays && !seenDays.has(dayKey)) { seenDays.add(dayKey); keep.add(n); continue }
    if (weekIdx < weeklyWeeks && !seenWeeks.has(weekKey)) { seenWeeks.add(weekKey); keep.add(n); continue }
    void d; void dayIdx; void weekIdx
    prunes.push(n)
  }

  // 3) Event snapshots: group by reason, keep K each
  const evtGroups = new Map()
  for (const n of evts) {
    const m = RE_EVT.exec(n)
    const key = m[1]
    if (!evtGroups.has(key)) evtGroups.set(key, [])
    evtGroups.get(key).push(n)
  }
  for (const [, list] of evtGroups) {
    list.forEach((n, i) => { if (i >= eventKeep) prunes.push(n) })
  }
  return prunes
}

module.exports = { selectPrunes, RE_AUTO, RE_EVT }
