/** CSV cell encoding with formula-injection neutralization (OWASP CSV Injection cheat sheet).
 *  User-controlled text (task titles, insight copy) starting with = + - @ or a tab/CR
 *  would be evaluated as a formula by Excel/LibreOffice when the export is opened.
 *  Neutralize by prefixing a single quote (Excel treats the cell as text); quote doubling
 *  and full quoting stay the caller's job, this function only returns the safe raw value. */
const FORMULA_PREFIX = /^[=+\-@\t\r]/

export function neutralizeCsvCell (v) {
  const s = String(v == null ? '' : v)
  return FORMULA_PREFIX.test(s) ? "'" + s : s
}

/** Full cell -> CSV field: neutralize dangerous prefixes, escape quotes, wrap in quotes. */
export function csvField (v) {
  return '"' + neutralizeCsvCell(v).replace(/"/g, '""') + '"'
}

/** Data-review export table: KPI rows + narrative + per-day series, as raw cell rows.
 *  Moved verbatim from StatisticsView.exportTable (quoting stays at the call site). */
export function buildExportRows (m, t, reviewHeadline, insightLines) {
  const rows = [[t('csvPeriod'), m.label]]
  rows.push([t('csvMetric'), t('csvValue'), t('csvBaseline')])
  rows.push([t('kpiDone'), m.done, m.baseline.done == null ? '' : fmtCount(m.baseline.done)])
  rows.push([t('csvAdded'), m.added, ''])
  rows.push([t('csvPlanned'), m.planned, ''])
  rows.push([t('kpiRate'), m.doneRate == null ? '' : Math.round(m.doneRate * 100) + '%', m.baseline.doneRate == null ? '' : Math.round(m.baseline.doneRate * 100) + '%'])
  rows.push([t('csvFocusMins'), m.focusMins, m.baseline.focus == null ? '' : fmtCount(m.baseline.focus)])
  rows.push([t('csvTomatoes'), m.tomatoCount, ''])
  rows.push([t('kpiGiveup'), m.giveUps, m.baseline.giveUps == null ? '' : fmtCount(m.baseline.giveUps)])
  rows.push([])
  rows.push([t('csvNarrative')])
  rows.push([reviewHeadline])
  insightLines.forEach(line => rows.push([line]))
  rows.push([])
  rows.push([t('csvDate'), t('csvDoneCount'), t('csvFocusMins')])
  m.doneByDay.forEach((d, i) => rows.push([d.label, d.value, m.focusByDay[i] ? m.focusByDay[i].value : 0]))
  return rows
}

/* CSV count formatting for the export table: integer counts print plainly (12, not "12.0");
 * fractional values (e.g. averaged baselines) keep one decimal place */
function fmtCount (v) { return Number.isInteger(v) ? String(v) : v.toFixed(1) }
