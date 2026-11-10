/**
 * PickDone VS Code extension — PURE helpers (no vscode import, Node-testable).
 * The mission contract: capture carries references ONLY (repo-relative path, selection
 * LINES, diagnostics COUNTS + source names, git branch/sha) — never file content, never
 * diagnostic message text. The desktop door rejects content-bearing payloads as defense
 * in depth; this module keeps the client honest in the first place.
 */

const SEVERITY_ORDER = ['error', 'warning', 'info', 'hint']

/**
 * Summarize VS Code diagnostics WITHOUT any message text: counts per severity plus the
 * source identifiers (eslint, typescript, ...) and 1-based line numbers. Strings only,
 * bounded length.
 * @param {Array<{severity?: number| string, source?: string, range?: {start?: {line?: number}}}>} diags
 */
function diagnosticsSummary (diags) {
  const counts = { error: 0, warning: 0, info: 0, hint: 0 }
  const sources = new Set()
  const lines = []
  const sevOf = d => {
    const s = d && d.severity
    if (typeof s === 'string' && SEVERITY_ORDER.includes(s)) return s
    if (s === 0) return 'error'
    if (s === 1) return 'warning'
    if (s === 2) return 'info'
    if (s === 3 || s === 4) return 'hint'
    return 'info'
  }
  for (const d of diags || []) {
    if (!d || typeof d !== 'object') continue
    const sev = sevOf(d)
    counts[sev] += 1
    if (typeof d.source === 'string' && d.source) sources.add(d.source.slice(0, 40))
    const ln = d.range && d.range.start && Number(d.range.start.line)
    if (Number.isFinite(ln)) lines.push(ln + 1)
  }
  const parts = []
  for (const sev of SEVERITY_ORDER) {
    if (counts[sev]) parts.push(counts[sev] + ' ' + sev)
  }
  const src = [...sources].sort().slice(0, 5).join(',')
  const loc = lines.slice(0, 8).sort((a, b) => a - b).join(',')
  let summary = parts.length ? parts.join('/') + ' problems' : 'no problems'
  if (src) summary += ' (' + src + ')'
  if (loc) summary += ' at L' + loc
  return summary
}

/**
 * The SourceRef title for a captured editor context: path + selection + diagnostics +
 * git identity. All bounded; reference-shaped only.
 * @param {{relPath: string, sel?: {start: number, end: number}, diagSummary?: string, branch?: string|null, sha?: string|null}} ctx
 */
function buildContextTitle ({ relPath, sel, diagSummary, branch, sha }) {
  const clean = String(relPath || '').replace(/\\/g, '/').slice(0, 200)
  let t = clean
  if (sel && Number.isFinite(sel.start)) {
    t += sel.end && sel.end !== sel.start ? ' L' + sel.start + '-' + sel.end : ' L' + sel.start
  }
  if (diagSummary) t += ' · ' + String(diagSummary).slice(0, 160)
  if (branch) t += ' · ' + String(branch).slice(0, 80) + (sha ? '@' + String(sha).slice(0, 12) : '')
  return t.slice(0, 500)
}

/**
 * The desktop/web deep link for one task — the SAME hash route the renderer ships
 * (router.js: /todo-list/task/:id), so desktop and web builds share one URL grammar.
 */
function buildDeepLink (base, taskId) {
  const b = String(base || '').replace(/\/+$/, '')
  return b + '#/todo-list/task/' + encodeURIComponent(String(taskId))
}

module.exports = { diagnosticsSummary, buildContextTitle, buildDeepLink, SEVERITY_ORDER }
