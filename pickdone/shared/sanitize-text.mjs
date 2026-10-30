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
 * (U+2066-2069) + LRM/RLM + BOM, whitespace collapsing, truncation; sanitizeMultiline keeps
 * newlines (same strip/collapse/clamp otherwise).
 */
/* eslint-disable no-control-regex, no-irregular-whitespace -- control characters/irregular whitespace are exactly this module's sanitization target */
export const CONTROL_RE = /[\u0000-\u001f\u202a-\u202e\u2066-\u2069\u200e\u200f\uFEFF]/g
const WS_RE = /\s\s+/g

/** Shared storage ceiling for free-text fields (title/describe): matches the DB column clamp
 *  (db-rows.js describe goes through sanitizeText's default 5000). Renderer inputs clamp to
 *  the SAME constant so a pasted overflow is truncated up front and never diverges from what
 *  the DB persists. */
export const TEXT_MAX_LEN = 5000

/** Sanitize and truncate (default 5000, consistent with the editor/DB column constraints) */
export function sanitizeText (s, maxLen = TEXT_MAX_LEN) {
  return String(s || '')
    .replace(CONTROL_RE, '')
    .replace(WS_RE, ' ')
    .replace(/[\t]/g, ' ')
    .slice(0, maxLen)
}

/* [F7 P3 2026-10-21] DEGRADED newline preservation: the full fix (sanitizeText keeping \n)
 * is pinned out by tests/unit/store/tomato-remote-announce.test.mjs, whose hostile fixture
 * hard-codes newline-stripped announce payloads — a cross-device wire contract this batch may
 * not touch. Until the DB/announce migration adopts it, the layout-preserving shape lives
 * HERE single-sourced: newlines (and blank-line paragraph layout) survive; runs of spaces and
 * tabs still fold; control/RTL/bidi stripping and the length clamp match sanitizeText. */
const MULTILINE_CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u202a-\u202e\u2066-\u2069\u200e\u200f\uFEFF]/g

export function sanitizeMultiline (s, maxLen = TEXT_MAX_LEN) {
  return String(s || '')
    .replace(MULTILINE_CONTROL_RE, '')
    .replace(/[ \t]+/g, ' ')
    .slice(0, maxLen)
}

/** Strip dangerous characters only, no whitespace collapsing, no truncation (short fields like notification titles) */
export function stripDangerous (s) {
  return String(s || '').replace(CONTROL_RE, '')
}
