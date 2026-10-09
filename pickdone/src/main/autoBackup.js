/**
 * Automatic backup strategy (pure functions, no Electron dependency — shared by the main process
 * and unit tests). File naming: auto-YYYYMMDD-HHMMSS.json (periodic) / evt-<reason>-<stamp>.json
 * (pre-dangerous-operation). Retention (GFS tiers): auto keeps recent N + daily anchors (D days)
 * + weekly anchors (W weeks); evt files grouped by reason keep K per group.
 */

// D20-B4: same-stamp collision snapshots carry a SUFFIX — `auto-...-dup<n>.json` (handlers/
// backup.js uniqueSnapshotName) and `evt-<reason>-...-<epochMs>.json` (cli/lib-eventbackup.cjs).
// The bare-stamp regexes never matched them, so they accumulated FOREVER outside the GFS tiers.
// The optional `(?:-[A-Za-z0-9]+)?` suffix group classifies them into their tag's tier (the base
// stamp capture groups are unchanged, so nameToTs/dayKey/week anchors keep working).
const RE_AUTO = /^auto-(\d{8})-(\d{6})(?:-[A-Za-z0-9]+)?\.json$/
const RE_EVT = /^evt-([a-z0-9-]+)-(\d{8})-(\d{6})(?:-[A-Za-z0-9]+)?\.json$/

function nameToTs (name) {
  const m = RE_AUTO.exec(name) || RE_EVT.exec(name)
  if (!m) return 0
  const [, a, b] = RE_EVT.exec(name) ? [null, m[2], m[3]] : [null, m[1], m[2]]
  const s = a // YYYYMMDD
  const t = b // HHMMSS
  // Fix (2026-09-19): filename stamps are LOCAL time (from new Date() formatting) — parse as
  // local, not UTC, or every non-UTC backup's GFS anchor age skews by the UTC offset.
  return +new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6))
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

/** Stale atomic-write residue picker (pure, unit-testable): a crash between writeFileSync(tmp) and
 *  renameSync used to leave temp files in the backup dir forever. Stale = temp file AND mtime
 *  older than maxAgeMs (1h default — an in-flight write is never swept). C7 (P2 2026-09-24):
 *  /\.dtmp(\.|$)/ matches the durable `<file>.<pid>.<ms>.dtmp` spelling and the legacy fixed
 *  `<file>.dtmp` / historical `.tmp-*` spellings. Caller supplies mtimes. */
function selectStaleTmp (entries, { now = Date.now(), maxAgeMs = 60 * 60 * 1000 } = {}) {
  return (entries || [])
    .filter(e => e && typeof e.name === 'string' &&
      (e.name.startsWith('.tmp-') || /\.dtmp(\.|$)/.test(e.name)) &&
      Number.isFinite(e.mtimeMs) && now - e.mtimeMs > maxAgeMs)
    .map(e => e.name)
}

/** Retention floor for renderer-supplied tier numbers (2026-10-10 backup audit): the `= default`
 *  destructure in selectPrunes only fires on ABSENT fields — a caller passing {recent:0} (renderer
 *  bug or hostile IPC) used to classify the ENTIRE snapshot dir as prunable in one pass. Retention
 *  is trust-boundary input: applied at the IPC handler door. Only the COUNTING tiers (recent,
 *  eventKeep) floor at 1 — dailyDays/weeklyWeeks 0 legitimately disables those anchor tiers, and
 *  "keep the newest 1 recent" alone already makes a full wipe impossible. */
function floorRetention (o) {
  for (const k of ['recent', 'eventKeep']) {
    if (o[k] != null) o[k] = Math.max(1, Number(o[k]) || 0)
  }
  for (const k of ['dailyDays', 'weeklyWeeks']) {
    if (o[k] != null) o[k] = Math.max(0, Number(o[k]) || 0)
  }
  return o
}

module.exports = { selectPrunes, selectStaleTmp, nameToTs, floorRetention, RE_AUTO, RE_EVT }
