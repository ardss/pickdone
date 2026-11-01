/**
 * Comment/string-aware top-level `{` counter for hand-written stylesheets — the disk-side
 * twin of the browser CSSOM rule count (see tests/cssom-integrity.mjs, exact-compare lane).
 * Extracted (2026-11-01, w26) so it can be unit-anchored: cssom-integrity.mjs is a gate that
 * self-executes on import, so its inline copy was untestable — and the inline copy carried a
 * dead escape branch (`'\\\\'` is the 2-char string "\\" at runtime, never equal to the
 * 1-char css[i]) that let `\"` / `\'` escapes close a string scan early and miscount.
 */
export function countTopLevel (css) {
  let depth = 0, n = 0
  for (let i = 0; i < css.length; i++) {
    const c = css[i]
    if (c === '/' && css[i + 1] === '*') { i = css.indexOf('*/', i + 2); if (i < 0) break; i++; continue }
    if (c === '"' || c === "'") { const q = c; for (i++; i < css.length; i++) { if (css[i] === '\\') i++; else if (css[i] === q) break } continue }
    if (c === '{') { if (depth === 0) n++; depth++ }
    else if (c === '}') depth--
  }
  return n
}
