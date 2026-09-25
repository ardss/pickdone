/**
 * B7 (2026-09-25): xlsx export column K (the 11th of the fixed 17 columns, EXPECTED_EXPORT_COLS)
 * used to carry only the bare repeatId — the actual repeat rule (frequency/interval, the
 * repeatSettingsV2 blob persisted at meta 'repeatRule:<rid>') never left the app, so the Excel
 * archive lost the one fact the column exists for. Pure helpers extracted here so the fill is
 * unit-testable without a .vue loader; SettingsDataTab.exportXlsx does the batched
 * getMetaMany('repeatRule:<rid>') read and assembles ruleMap, then fills column 11 with the
 * serialized rule JSON (fallback: the bare repeatId when the rule meta is gone/orphan-cleaned).
 * No new column: the sheet stays at the hardcoded 17-column shape.
 */

/** meta keys to batch-read for the given todo list (deduped, order-preserving) */
export function repeatRuleMetaKeys (list) {
  const seen = new Set()
  const keys = []
  for (const t of (list || [])) {
    const rid = t && t.repeatId
    if (!rid || seen.has(rid)) continue
    seen.add(rid)
    keys.push('repeatRule:' + rid)
  }
  return keys
}

/** getMetaMany rows ([{key, value|null}]) → { repeatId: ruleJson } */
export function ruleMapFromMetaRows (rows) {
  const map = {}
  for (const m of (rows || [])) {
    if (!m || !m.key || !m.value) continue
    map[String(m.key).slice('repeatRule:'.length)] = String(m.value)
  }
  return map
}

/** column-11 cell for one todo: the serialized rule when known, else the bare repeatId, else '' */
export function repeatRuleCell (t, ruleMap = {}) {
  const rid = t && t.repeatId
  if (!rid) return ''
  const rule = ruleMap[rid]
  return rule != null && rule !== '' ? rule : String(rid)
}
