/**
 * Settings-blob family contract (F-B1, dw wave 3): db.settingsState and db.habitsState share ONE
 * settings_rows table (db-sync-schema.js SYNC_BLOB_KEYS), so a whole-blob read-modify-write on
 * either key must never carry the OTHER family's fields across — the CLI's settingsSet used to
 * fold db.habitsState rows (habits/moments/savedAt) back into the settings blob, letting a sync
 * echo of one family clobber the other.
 *
 * Exports (contract shared with lan-sync-bootstrap.js foldSettingsIntoBlob, which routes applied
 * rows by the same set — the App side consumes this module in its next wave):
 *   HABITS_BLOB_FIELDS   — the renderer habits persist shape ({schemaV,habits,moments,savedAt,
 *                          deleted,deletedMoments}; the two tombstone arrays joined W7 2026-10-23
 *                          in lockstep with db-sync-schema.js HABITS_BLOB_OWNED so applied
 *                          tombstone rows fold back into db.habitsState, not settingsState —
 *                          the renderer readDoc (habits.js) consumes both);
 *                          identical set as the previous local const in lan-sync-bootstrap.js.
 *   HABITS_EXCLUSIVE_FIELDS — fields that must never land in the SETTINGS blob (schemaV is legal
 *                          on both blobs, so it is deliberately excluded here).
 *   stripHabitsFamily(doc) — pure: shallow copy of doc without the habits-exclusive fields.
 */
export const HABITS_BLOB_FIELDS = new Set(['schemaV', 'habits', 'moments', 'savedAt', 'deleted', 'deletedMoments'])

export const HABITS_EXCLUSIVE_FIELDS = new Set(['habits', 'moments', 'savedAt', 'deleted', 'deletedMoments'])

export function stripHabitsFamily (doc) {
  const out = { ...(doc || {}) }
  for (const k of HABITS_EXCLUSIVE_FIELDS) delete out[k]
  return out
}
