/**
 * HTML template-comment stripper for the i18n whole-tree CJK scanner (check-i18n.mjs).
 *
 * WHY (2026-10-22, d2-crosscutting-auditor): the scanner strips JS block/line comments but read
 * `<!-- ... -->` bodies in .vue templates as user-visible copy — the round-1 J1 fix note inside
 * TomatoBar.vue's template (quoting the zh phase words as bug evidence) exited the gate 1 for
 * the whole branch and check:all stayed red (check-all.js stage runs this exact script).
 * A comment body is documentation, never UI copy. Pure function, no IO — unit-tested in
 * tests/unit/cli/d2-i18n-html-comment-strip.test.mjs.
 *
 * Contract: replace every COMPLETE <!-- ... --> (non-greedy, multi-line) with a single space so
 * surrounding line structure survives for line-numbered reports. An UNTERMINATED <!-- is left
 * untouched on purpose (fail loud): text after a typo'd opener stays visible to the scanner and
 * keeps the gate red until the comment is closed.
 */
export function stripHtmlComments (src) {
  return String(src).replace(/<!--[\s\S]*?-->/g, ' ')
}
