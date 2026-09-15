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
