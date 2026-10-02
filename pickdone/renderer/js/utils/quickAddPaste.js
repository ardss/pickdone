/**
 * QuickAdd multi-line paste helpers (D4-paste fix, 2026-10-02).
 *
 * The quick-add input is a plain single-line <input>: pasting a newline-separated
 * list used to fold the lines into ONE space-joined task with no hint (the browser
 * strips the newlines, Enter then created one useless task). onPaste now splits the
 * clipboard text and creates one task per line. These are the pure parts, unit-tested
 * in tests/unit/components/d4-quickadd-multiline-paste.test.mjs.
 */

/** Split pasted text into trimmed non-empty lines (CRLF/CR/LF aware). */
export function splitPasteLines (text) {
  return String(text == null ? '' : text)
    .split(/\r\n|\r|\n/)
    .map(l => l.trim())
    .filter(Boolean)
}

/**
 * Append the current tag page's tag to a line unless the exact tag token is already
 * present (word-boundary aware — the [maint-0925 A11] rule from QuickAdd.onEnter,
 * extracted so the multi-line paste path and onEnter share one implementation).
 */
export function ensureTagSuffix (content, tag) {
  if (!tag) return content
  const esc = String(tag).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp('(^|\\s)#' + esc + '(?=[\\s#,，。.!?！？]|$)')
  return re.test(content) ? content : content + ' #' + tag
}
