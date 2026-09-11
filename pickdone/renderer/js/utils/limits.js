/**
 * ESM re-export of the shared limits (pickdone/shared/limits.mjs) so the
 * renderer has a single import point.
 * First consumer will be renderer/js/store/tomato.js (inline 600 clamp,
 * follow-up migration — see shared/limits.mjs header).
 */
export { FOCUS_MAX_MINUTES, FOCUS_INPUT_MAX_MINUTES } from '../../../shared/limits.mjs'
