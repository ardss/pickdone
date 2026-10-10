/**
 * normKey — single source for category/task name normalization:
 * NFKC → lowercase → strip whitespace variants (regular, NBSP \u00A0, ideographic \u3000,
 * zero-width \u200B, em \u2003).
 *
 * Extracted from cli/lib.js (was inline there; F-B5 already injected it into lib-tasks.cjs /
 * lib-categories.cjs via deps). Shared so the RENDERER's category name-uniqueness guard
 * (renderer/js/store/category.js addCategory/updateCategory) normalizes the same way the CLI's
 * resolveCategory does: a UI-created 'Work' next to 'work'/'Ｗｏｒｋ' previously passed the raw
 * compare and then made every CLI category addressing fail with AMBIGUOUS_MATCH.
 *
 * Format: ESM (.mjs) — CJS consumers (cli/lib.js) load it via require(esm), same pattern as
 * shared/limits.mjs; the renderer imports it directly.
 */
export const normKey = v => String(v).normalize('NFKC').toLowerCase().replace(/[\s\u00A0\u3000\u200B\u2003]/g, '')
