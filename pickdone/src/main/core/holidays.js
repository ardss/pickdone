/**
 * Statutory holiday data (main-process CJS entry) — single source is shared/holidays.mjs
 * (dw wave5 2026-09-24: this used to be a verbatim CJS mirror of the renderer copy; both mirrors
 * are gone and main/cli consume the shared ESM module via require(esm), Node >= 22.12 — same
 * pattern as cli/lib.js's require('../shared/limits.mjs')). Used by the CLI/main-process renewal
 * pipeline's expandRepeatDates for skipStatutoryHolidays / statutoryWorkdays.
 */
module.exports = require('../../../shared/holidays.mjs')
