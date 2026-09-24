/**
 * shared/date-key.mjs — local-timezone YYYY-MM-DD day-key derivation, ONE source.
 *
 * F-C7 (maint/dw wave3): the renderer hand-rolled the same `getFullYear() + '-' +
 * pad(getMonth()+1) + '-' + pad(getDate())` concatenation in three places (store/habits.js
 * streak/last30 loops, MilestoneEditModal's tsToDate) while the main process already converged on
 * fix-util.localDayKey (src/main/fix-util.js — NOT migrated here, per the wave3 task split; main
 * can adopt this module later). Rendering hosts have no `module.exports`, so this is ESM.
 */

/** Local-timezone YYYY-MM-DD key. Accepts a Date or a ms timestamp (fix-util's version takes
 *  Date/number too; every current renderer call site passes a Date, behavior preserved). */
export function localDayKey (ts) {
  const d = ts instanceof Date ? ts : new Date(Number(ts) || 0)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}
