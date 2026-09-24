/**
 * Tomato-estimate storage core (F-B3, dw wave 3): single source for the per-task estimate storage
 * contract — previously hand-copied between cli/lib.js and renderer utils/tomatoEstimate.js
 * (marked 'twin' in both; the 2026-09-03 drift incident is recorded in tomatoEstimate.js:3-5).
 *
 * Contract (X2 2026-09-20): per-task meta keys `tomatoEstimateState:<taskId>` hold a plain
 * integer string clamped to 0..20; `tomatoEstimateStateAt` is the cross-end LWW stamp; the old
 * whole-map blob `tomatoEstimateState` is legacy (lazy-migrated to per-task keys, then deleted).
 * The renderer consumes this module in its wave; the CLI is wired now.
 *
 * Pure, dependency-free — importable from .mjs (renderer) and require(esm) (CLI, Node >= 22.12).
 */
export const ESTIMATE_KEY_PREFIX = 'tomatoEstimateState:'
export const TS_KEY = 'tomatoEstimateStateAt'
export const LEGACY_KEY = 'tomatoEstimateState'
export const ESTIMATE_MIN = 0
export const ESTIMATE_MAX = 20

export const estimateKeyOf = taskId => ESTIMATE_KEY_PREFIX + String(taskId)

/** Clamp + round any incoming value to the storage domain 0..20 (NaN/negative → 0). */
export function clampEstimate (v) {
  return Math.max(ESTIMATE_MIN, Math.min(ESTIMATE_MAX, Math.round(Number(v) || 0)))
}
