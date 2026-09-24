'use strict'

/**
 * Single-source mm:ss formatter for the MAIN process (domain-1 F-A6, 2026-09-23).
 *
 * There were two drifting inline copies: tomato-taskbar.js (floor + negative clamp) and
 * handlers/tomato.js tray tooltip (none — a remainSec of -1 rendered "-1:-1" in the tray).
 * This module has the taskbar semantics (floor, clamp at 0): negative/fractional seconds
 * can legitimately appear for one tick around phase flips.
 *
 * Pure CommonJS so both CJS consumers require it directly. The renderer keeps its ESM copy
 * in renderer/js/utils/tomatoShared.js (formatMMSS, identical semantics) — the renderer
 * bundle cannot require .cjs; the two must be kept in sync (see the comment there).
 */
function formatMMSS (sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0))
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}

module.exports = { formatMMSS }
