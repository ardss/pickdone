/** Project status field (v0.2) — pinned contract shared with the CLI:
 *  meta key `projectStatus:<categoryId>`, string 'active' | 'paused' | 'done' | 'cancelled';
 *  absent/invalid reads as 'active' so a project without a stored status behaves unchanged.
 *  Pure module: no Vue/store/DB imports, so node unit tests can pin the normalization. */

export const PROJECT_STATUSES = ['active', 'paused', 'done', 'cancelled']
export const DEFAULT_STATUS = 'active'

/** Absent/anything-invalid falls back to 'active' (the CLI implements the same rule) */
export function normalizeStatus (v) {
  return PROJECT_STATUSES.includes(v) ? v : DEFAULT_STATUS
}

/** Status -> i18n key under the projQ namespace (single source for every view) */
export const STATUS_I18N_KEYS = {
  active: 'projQ.statusActive',
  paused: 'projQ.statusPaused',
  done: 'projQ.statusDone',
  cancelled: 'projQ.statusCancelled'
}

/** Normalized lookup: invalid/absent input resolves to the active-status key */
export function statusI18nKey (status) {
  return STATUS_I18N_KEYS[normalizeStatus(status)]
}

/** Overview filter chips ('all' + the four statuses) -> i18n key; 'all' must not fall through statusI18nKey (it would normalize to active) */
export const STATUS_FILTER_I18N_KEYS = {
  all: 'projQ.filterAll',
  active: 'projQ.filterActive',
  paused: 'projQ.filterPaused',
  done: 'projQ.filterDone',
  cancelled: 'projQ.filterCancelled'
}
