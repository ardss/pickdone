/**
 * Tag-name legality — single source for BOTH ends (F2 fix, 2026-10-21):
 * the CLI's lib-tags.cjs and the renderer's SnManageTagsModal.vue both rename tags, and a new
 * name containing any of the TAG terminator characters (space, `#`, `,`, `，`, `.`, `。`, `!`, `？` …)
 * can never be extracted again by TAG_RE (`/#([^\s#,，。.!?！？]+)/`) — it becomes a ghost tag that
 * the sidebar counts (via a stale userTags placeholder) but no task actually carries, and that
 * rename/remove can never reach. Both rename entry points must therefore validate the new name
 * against the SAME character class before rewriting the corpus.
 * Pure module, no dependencies (consumed by CJS via require(esm), same pattern as sort-core.mjs).
 */

/** Same terminator class as search.js TAG_RE / lib-tags.cjs TAG_RE / tagRewriteRe — keep in sync. */
const TAG_NAME_RE = /^#?[^\s#,，。.!?！？]+$/

/** Strip one optional leading `#` and trim — same normalization both rename UIs already do. */
export function normalizeTagName (name) {
  return String(name == null ? '' : name).trim().replace(/^#/, '')
}

/** A rename target is legal iff extractTags can extract it verbatim out of body text. */
export function isValidTagName (name) {
  return TAG_NAME_RE.test(String(name == null ? '' : name).trim())
}
