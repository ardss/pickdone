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

module.exports = { localDayKey, strictBase64, checkImportFileSize, pendingDeleteName, classifyBackupError, IMPORT_MAX_BYTES, formatLogLines, nextAvailableName, backupNameTs, sortBackupNamesNewestFirst, parseTomatoMetaBlob }

/* ---- 2026-09-10 main-fixes round ---- */

/** Format renderer log entries into plain text lines (log:write previously did `lines + NL` where
 *  lines was an array — array+string coerces via join(','), corrupting entries containing commas
 *  and merging all entries into one line). Exported pure so node --test can cover it. */
function formatLogLines (entries) {
  const NL = String.fromCharCode(10)
  return (Array.isArray(entries) ? entries : []).map(x => `[${x.ts}] [${x.level}] ${String(x.msg).slice(0, 4000).split(NL).join(' ')}` + (x.stack ? NL + String(x.stack).slice(0, 4000).split(String.fromCharCode(13)).join('').split(NL).map(l => '  ' + l).join(NL) : '')).join(NL)
}

/** First non-conflicting name in dir: appends " (n)" before the extension when the target exists
 *  (save-upload-file-to-download previously copyFileSync'd silently over an existing download).
 *  existsFn is injected for pure testing. */
function nextAvailableName (dir, fileName, existsFn) {
  const path = require('path')
  const exists = typeof existsFn === 'function' ? existsFn : (p) => { try { return require('fs').existsSync(p) } catch { return false } }
  let candidate = path.join(dir, fileName)
  if (!exists(candidate)) return candidate
  const ext = path.extname(fileName)
  const stem = fileName.slice(0, fileName.length - ext.length)
  for (let i = 1; i < 1000; i++) {
    candidate = path.join(dir, stem + ' (' + i + ')' + ext)
    if (!exists(candidate)) return candidate
  }
  // 999 collisions: give up deterministically rather than loop forever
  return path.join(dir, stem + ' (' + Date.now() + ')' + ext)
}

/** Newest-first backup name ordering by the embedded timestamp segment (auto-YYYYMMDD-HHMMSS.json /
 *  evt-<reason>-YYYYMMDD-HHMMSS.json). Lexical .sort() put 'auto-' before 'evt-…' with the same date
 *  prefix and misjudged dedup against a stale file. Mirrors autoBackup.nameToTs (kept inline so this
 *  module stays dependency-free). */
function backupNameTs (name) {
  const m = /^(?:auto-|evt-[a-z0-9-]+-)(\d{8})-(\d{6})\.json$/.exec(String(name))
  if (!m) return 0
  const s = m[1]; const t = m[2]
  return Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6))
}
function sortBackupNamesNewestFirst (names) {
  return (Array.isArray(names) ? names : []).slice().sort((a, b) => backupNameTs(b) - backupNameTs(a))
}

/** Parse the legacy tomato meta blob: returns { ok:true, list } on success, { ok:false } when the
 *  blob is corrupted JSON. Callers must NOT delete the blob on ok:false (the records would be lost
 *  forever) — previously a parse failure fell back to {} → empty list → delBlob wiped the ledger. */
function parseTomatoMetaBlob (text) {
  let st
  try { st = JSON.parse(text || '{}') } catch { return { ok: false, list: [] } }
  const list = Array.isArray(st && st.tomatoRecordList) ? st.tomatoRecordList.filter(r => r && r.tomatoId && r.endTime) : []
  return { ok: true, list }
}
