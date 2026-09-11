/**
 * ESM re-export of the shared CJS limits (pickdone/shared/limits.cjs) so the
 * renderer (Vite/ESM) has a single import point. Uses default-import
 * interop — the most portable way to consume CJS from Vite source.
 * First consumer will be renderer/js/store/tomato.js (inline 600 clamp,
 * follow-up migration — see shared/limits.cjs header).
 */
import limits from '../../../shared/limits.cjs'

export const FOCUS_MAX_MINUTES = limits.FOCUS_MAX_MINUTES
export const FOCUS_INPUT_MAX_MINUTES = limits.FOCUS_INPUT_MAX_MINUTES
