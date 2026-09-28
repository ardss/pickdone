/**
 * Shared text sanitization — single source for BOTH the renderer (ESM import) and the
 * main process (src/main/sanitize.js re-exports this implementation; see require there).
 *
 * History: src/main/sanitize.js once consolidated three drifting main-side copies; the
 * renderer's tomato-announce mirror (tomatoAnnounceShared.js) then drifted the other way —
 * bare String() where main clamped to 128/40/120/120 and stripped control/RTL/bidi chars,
 * leaving the renderer announce path (peer chips render deviceName verbatim) unguarded.
 * The implementation now lives HERE; tests/unit/store/tomato-remote-announce.test.mjs
 * additionally pins this copy against src/main/sanitize.js on hostile fixtures so the
 * two entry points cannot fork again.
 *
 * Coverage: control chars (U+0000-001F) + RTL/LTR/RLO (U+202A-202E) + LRI/RLI/FSI/PDI
 * (U+2066-2069) + LRM/RLM + BOM, whitespace collapsing, truncation.
 */
/* eslint-disable no-control-regex, no-irregular-whitespace -- control characters/irregular whitespace are exactly this module's sanitization target */
export const CONTROL_RE = /[\u0000-\u001f\u202a-\u202e\u2066-\u2069\u200e\u200f\uFEFF]/g
const WS_RE = /\s\s+/g

/** Sanitize and truncate (default 5000, consistent with the editor/DB column constraints) */
export function sanitizeText (s, maxLen = 5000) {
  return String(s || '')
    .replace(CONTROL_RE, '')
    .replace(WS_RE, ' ')
    .replace(/[\t]/g, ' ')
    .slice(0, maxLen)
}

/** Strip dangerous characters only, no whitespace collapsing, no truncation (short fields like notification titles) */
export function stripDangerous (s) {
  return String(s || '').replace(CONTROL_RE, '')
}
