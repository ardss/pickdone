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
 * Note: renderer/js/store/tomato.js still carries an inline 600 clamp
 * (outside this refactor's file scope) — migrating it to
 * renderer/js/utils/limits.js is a deliberate follow-up.
 */
module.exports = {
  FOCUS_MAX_MINUTES: 600,
  FOCUS_INPUT_MAX_MINUTES: 720
}
