/**
 * ESM re-export of the shared limits (pickdone/shared/limits.mjs) so the
 * renderer has a single import point.
 * Consumers: renderer/js/store/tomato.js (FOCUS_MAX_MINUTES clamp); the
 * direct-import consumers (utils/taskMenu.js, components/DayRail.vue) bypass
 * this re-export and import shared/limits.mjs directly — both paths stay
 * single-source. See shared/limits.mjs header.
 */
export { FOCUS_MAX_MINUTES, FOCUS_INPUT_MAX_MINUTES } from '../../../shared/limits.mjs'
