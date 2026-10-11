/**
 * Price provenance audit — a price entry may only be quoted externally when it
 * carries a real source URL + verification date. Classes:
 *   verified   — url is a real http(s) link AND verifiedAt is a date
 *   assumption — source declares ASSUMPTION (or verifiedAt UNSET): fine for
 *                internal modeling, never quotable
 *   missing    — no usable source at all: the config itself is invalid
 *   notModeled — value == null on purpose: excluded from totals, surfaced as warning
 */

const URL_RE = /^https?:\/\//
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function collectPriceEntries(node, path = '', acc = []) {
  if (node == null || typeof node !== 'object') return acc
  if (Array.isArray(node)) {
    node.forEach((item, i) => collectPriceEntries(item, `${path}[${i}]`, acc))
    return acc
  }
  const looksLikePrice = 'value' in node && 'unit' in node
  if (looksLikePrice) {
    acc.push({ path: path || '<root>', entry: node })
    return acc
  }
  for (const [k, v] of Object.entries(node)) collectPriceEntries(v, path ? `${path}.${k}` : k, acc)
  return acc
}

export function classifyEntry(entry) {
  if (entry.value == null) return 'notModeled'
  const src = entry.source || {}
  const url = typeof src.url === 'string' ? src.url : ''
  if (!url) return 'missing'
  if (url.startsWith('ASSUMPTION')) return 'assumption'
  if (!URL_RE.test(url)) return 'missing'
  if (!DATE_RE.test(String(src.verifiedAt || ''))) return 'missing'
  return 'verified'
}

export function auditSources(config) {
  const entries = collectPriceEntries(config)
  const byClass = { verified: [], assumption: [], missing: [], notModeled: [] }
  for (const { path, entry } of entries) byClass[classifyEntry(entry)].push({ path, entry })
  return { total: entries.length, ...byClass }
}

/** Throws when any price entry lacks a usable source — used by CLI --quote. */
export function assertQuotable(config) {
  const audit = auditSources(config)
  const offenders = [...audit.missing, ...audit.assumption].map(({ path, entry }) =>
    `${path} -> ${entry.source?.url || '<no source>'}`)
  if (offenders.length) {
    const err = new Error(
      `cannot produce an external quote: ${audit.missing.length} price entry(ies) without source, ` +
      `${audit.assumption.length} assumption(s). Offenders:\n  ` + offenders.join('\n  '))
    err.code = 'PRICE_SOURCE_MISSING'
    throw err
  }
  return audit
}
