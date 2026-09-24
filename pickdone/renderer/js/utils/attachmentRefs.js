/**
 * Extracted verbatim from components/EditPanel.vue (structure-size ratchet; was the
 * "[component-fixes] pure-start/end" block, unit-tested in
 * tests/unit/components/component-fixes-a11y.test.mjs).
 */

/** True when the attachment url is still referenced by the task row's image/files JSON.
 *  Malformed JSON counts as present (fail-safe: never delete a disk file on a parse error). */
export function attachmentUrlPresent (row, url) {
  if (!row || !url) return false
  for (const k of ['image', 'files']) {
    try {
      const a = JSON.parse(row[k] || '[]')
      if (Array.isArray(a) && a.some(x => x && x.url === url)) return true
    } catch (e) { return true }
  }
  return false
}
