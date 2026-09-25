/**
 * [B6 fix] Todo description line clamping — consumes the settings.todoDescriptionDisplayLineNumber
 * value (slider in SettingsModal, default 3). The setting existed with UI + store default but no
 * consumer ever read it: the description rendered fully unclamped regardless of the slider.
 *
 * Scoped to the todo description only (the setting's i18n label is "Description visible lines");
 * the hardcoded clamps elsewhere (TodoBoxView content, focus-record modal) are intentionally
 * unrelated. Pure function so it is unit-testable without a .vue loader.
 */
export function descLineClampStyle (raw, { min = 1, max = 6, fallback = 3 } = {}) {
  let n = Math.round(Number(raw))
  if (!Number.isFinite(n)) n = fallback
  n = Math.min(max, Math.max(min, n))
  // Keys use csstype camelCase vendor names + literal JSDoc casts so the object type-checks
  // as Vue's CSSProperties at :style consumers (TodoItem.vue) under vue-tsc.
  return /** @type {import('vue').CSSProperties} */ ({
    display: '-webkit-box',
    overflow: 'hidden',
    WebkitBoxOrient: /** @type {'vertical'} */ ('vertical'),
    textOverflow: 'ellipsis',
    wordBreak: /** @type {'break-all'} */ ('break-all'),
    whiteSpace: 'pre-line',
    WebkitLineClamp: n
  })
}
