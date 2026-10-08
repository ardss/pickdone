'use strict'
/* D25 (W1 adversarial-audit hole): the empty-category guards used String.trim() alone, which
 * does NOT strip zero-width characters (U+200B/U+200D/U+FEFF). A probe proved a name of
 * '\u200B' slipped through ALL four defense layers at once (choke-point insert guard, recovery
 * restore drop, cleanup-empty junk filter, data-hygiene scanner) — the exact wild-pollution
 * class could recur with invisible names. One shared predicate, used by every layer. */
function isBlankishName (v) {
  return String(v == null ? '' : v).replace(/[\u200B-\u200D\uFEFF]/g, '').trim() === ''
}
module.exports = { isBlankishName }
