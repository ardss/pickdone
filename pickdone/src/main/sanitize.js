/**
 * Shared text sanitization (guards against notification/export/clipboard spoofing + line-break breakage) — a single implementation, three consumers (db/scheduler/index).
 * There were once three drifting copies: scheduler/index lacked the newer LRI/RLI/FSI/PDI (2066-2069) character planes.
 * Coverage: control chars (U+0000-001F) + RTL/LTR/RLO (U+202A-202E) + LRI/RLI/FSI/PDI (U+2066-2069) + LRM/RLM + BOM.
 */
/* eslint-disable no-control-regex, no-irregular-whitespace -- control characters/irregular whitespace are exactly this module's sanitization target */
const CONTROL_RE = /[\u0000-\u001f\u202a-\u202e\u2066-\u2069\u200e\u200f\uFEFF]/g
const WS_RE = /\s\s+/g

/** Sanitize and truncate (default 5000, consistent with the editor/DB column constraints) */
function sanitizeText (s, maxLen = 5000) {
  return String(s || '')
    .replace(CONTROL_RE, '')
    .replace(WS_RE, ' ')
    .replace(/[\t]/g, ' ')
    .slice(0, maxLen)
}

/** Strip dangerous characters only, no whitespace collapsing, no truncation (short fields like notification titles) */
function stripDangerous (s) {
  return String(s || '').replace(CONTROL_RE, '')
}

module.exports = { sanitizeText, stripDangerous, CONTROL_RE }
