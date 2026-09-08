/**
 * Pure helpers extracted from the main-process fixes (2026-09-09 main-fixes round).
 * No electron / no I/O here — everything is requireable from node --test
 * (tests/main-fixes-*.test.mjs), same pattern as close-behavior.js.
 */

/** Local-timezone YYYY-MM-DD key (same shape the DB layer derives via dayjs endTime) */
function localDayKey (ts) {
  const d = ts instanceof Date ? ts : new Date(Number(ts) || 0)
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

/** Strict base64 validation: canonical charset + correct length/padding after whitespace stripping.
 *  Node's Buffer.from(base64) is lenient (it stops at the first invalid byte and never throws), so
 *  saveAttachment previously accepted corrupted/partially-valid payloads silently. Returns the
 *  stripped string when valid, or null when invalid (callers roundtrip-compare via Buffer.toString('base64')). */
function strictBase64 (dataBase64) {
  const s = String(dataBase64 || '').replace(/\s+/g, '')
  if (!s.length || !/^[A-Za-z0-9+/]+={0,2}$/.test(s)) return null
  if (s.length % 4 !== 0) return null
  // '=' only allowed as the last 1-2 chars (regex above already enforces trailing; guard '=A' style)
  const eq = s.indexOf('=')
  if (eq !== -1 && eq < s.length - 2) return null
  return s
}

/** CSV import size gate: returns an error message when over the cap, or null when OK.
 *  import:pick-preview used to readFileSync the picked file synchronously with no bound — a
 *  multi-GB CSV froze the whole main process (all windows, all timers) during the read. */
const IMPORT_MAX_BYTES = 20 * 1024 * 1024
function checkImportFileSize (sizeBytes, max) {
  const cap = Number(max) || IMPORT_MAX_BYTES
  const n = Number(sizeBytes)
  if (!Number.isFinite(n) || n < 0) return 'import: cannot stat picked file'
  if (n > cap) return 'import: file too large (' + Math.round(n / 1024 / 1024) + 'MB > ' + Math.round(cap / 1024 / 1024) + 'MB limit)'
  return null
}

/** Deferred-delete naming for files that could not be unlinked while a SQLite handle was open
 *  (Windows EPERM): renamed aside now, swept at next startup. */
function pendingDeleteName (fileName, ts) {
  const safe = String(fileName || '').replace(/[\\/:*?"<>|]/g, '_')
  return 'pending-delete-' + String(ts == null ? Date.now() : ts) + '-' + safe
}

/** Classify a backup-directory read failure: 'missing' (dir does not exist — a normal empty state,
 *  must NOT surface as an error) vs 'read-failed' (permissions/IO — must surface to the user instead
 *  of the previous blanket silent catch). */
function classifyBackupError (err) {
  if (err && (err.code === 'ENOENT')) return 'missing'
  return 'read-failed'
}

module.exports = { localDayKey, strictBase64, checkImportFileSize, pendingDeleteName, classifyBackupError, IMPORT_MAX_BYTES }
