/**
 * Global search — pinyin + token-approximation + fuzzy matching (threshold 0.6), aligned with the project baseline semantics
 */
import { toPinyinLower, hasChinese, parseSubtasks } from './core.js'

function levenshtein (a, b) {
  const m = a.length; const n = b.length
  if (!m) return n; if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    }
    prev = cur
  }
  return prev[n]
}
function similarity (a, b) {
  if (!a && !b) return 0
  const d = levenshtein(a, b)
  return 1 - d / Math.max(a.length, b.length)
}

/** Single-field match: contains / pinyin contains / fuzzy ≥ threshold */
export function matchText (target, query, opt = {}) {
  const { enablePinyin = true, enableFuzzy = true, fuzzyThreshold = 0.6 } = opt
  if (!target || !query) return false
  const g = String(target).normalize('NFKC').toLowerCase().trim()
  const q = String(query).normalize('NFKC').toLowerCase().trim()
  if (!q) return false
  if (g.includes(q)) return true
  if (enablePinyin && hasChinese(g)) {
    // Hit: the pinyin of every character of the query (or the whole string) appears in the target's pinyin string
    const pyTarget = toPinyinLower(g)
    const pyQuery = hasChinese(q) ? toPinyinLower(q) : q.replace(/\s+/g, '')
    if (pyQuery && pyTarget.includes(pyQuery)) return true
  }
  if (enableFuzzy && q.length >= 2) {
    if (similarity(g.slice(0, Math.max(q.length * 2, 6)), q) >= fuzzyThreshold) return true
  }
  return false
}

export function matchTodo (todo, query, opt) {
  if (!query) return true
  // Multiple keywords split on whitespace, AND per term (previously whole-string matching: "milk buy" couldn't find "buy milk"); single-term behavior unchanged
  const terms = String(query).trim().split(/\s+/).filter(Boolean)
  if (!terms.length) return true
  return terms.every(term => {
    const fields = [todo.taskContent, todo.taskDescribe]
    const subs = parseSubtasks(todo.subtasks)
    if (subs.length) fields.push(subs.map(s => s.text).join(' '))
    return fields.some(f => f && matchText(f, term, opt))
  })
}

/** Highlight: safely escape per the project baseline, then wrap in <span class="search-highlight">.
 *  Input is plain-text user content: escape the whole string before highlighting (the old "HTML-tag segmented passthrough" branch let text resembling <img onerror> through,
 *  and this function is designed to feed v-html — a planted bug; passthrough removed 2026-09-02) */
export function highlightHTML (text, query, cls = 'search-highlight') {
  const s = escapeHtml(String(text == null ? '' : text))
  const q = String(query || '').trim()
  if (!q) return s
  const esc = t => t.replace(/[.*+?${}()|[\]\\]/g, '\\$&')
  return s.replace(new RegExp(`(${esc(escapeHtml(q))})`, 'gi'), `<span class="${cls}">$1</span>`)
}
export function escapeHtml (s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/* Tag extraction #xxx */
const TAG_RE = /#([^\s#,，。.!?！？]+)/g
export function extractTags (...texts) {
  const set = new Set()
  texts.forEach(t => {
    if (!t) return
    let m; TAG_RE.lastIndex = 0
    while ((m = TAG_RE.exec(String(t)))) set.add(m[1])
  })
  return [...set]
}
