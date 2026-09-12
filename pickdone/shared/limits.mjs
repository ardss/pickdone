/**
 * Focus-duration limits — single source for the 600/720 dual-cap constants.
 *
 * FOCUS_MAX_MINUTES (600): storage/ledger clamp. Enforced at the DB layer
 * (src/main/db.js _recToRow / update field clamp) and mirrored by the CLI
 * (cli/lib.js backfillRecord / recordFix) so the CLI rejects up front instead
 * of reporting success for a value the DB silently truncates.
 *
 * FOCUS_INPUT_MAX_MINUTES (720): UI input ceiling. The renderer tomato store
 * accepts up to 720 in the input field but values above 600 are clamped to
 * FOCUS_MAX_MINUTES on save (memory must never diverge from the ledger).
 *
 * Format: ESM (.mjs) — single file consumed by CJS consumers (src/main/db.js,
 * cli/lib.js) via require(esm) (Node >= 22.12; CI pins node 22, Electron 39
 * embeds node 22.x) and by the renderer through renderer/js/utils/limits.js.
 *
 * Note: renderer/js/store/tomato.js now clamps through FOCUS_MAX_MINUTES
 * (imported via renderer/js/utils/limits.js) — the last inline 600 in the
 * renderer is gone (2026-09-12 migration).
 */
export const FOCUS_MAX_MINUTES = 600
export const FOCUS_INPUT_MAX_MINUTES = 720
