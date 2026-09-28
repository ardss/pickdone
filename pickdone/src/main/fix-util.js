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

/* ---- 2026-09-12 round-6 fixes ---- */

/** Consistent double-read: keep reading until two consecutive reads return the SAME value (bounded
 *  by `tries` re-reads), so callers sampling fast-changing pairs (db + wal mtimes) never absorb a
 *  torn half-write. Returns the agreed value, or null when values keep changing (caller skips this
 *  sample; the next poll re-reads). */
function stableRead (readFn, tries = 4) {
  let prev
  try { prev = readFn() } catch { return null }
  for (let i = 0; i < tries; i++) {
    let cur
    try { cur = readFn() } catch { return null }
    if (cur === prev) return cur
    prev = cur
  }
  return null
}

/** First non-existing "stem-N.ext" sibling in dir (saveAttachment previously wrote straight onto
 *  Date.now() name — two uploads within the same millisecond with the same task/name silently
 *  overwrote each other). existsFn injected for pure testing. */
function nextFreePath (dir, fileName, existsFn) {
  const path = require('path')
  const exists = typeof existsFn === 'function' ? existsFn : (p) => { try { return require('fs').existsSync(p) } catch { return false } }
  const candidate = path.join(dir, fileName)
  if (!exists(candidate)) return candidate
  const ext = path.extname(fileName)
  const stem = fileName.slice(0, fileName.length - ext.length)
  for (let i = 1; i < 1000; i++) {
    const p = path.join(dir, stem + '-' + i + ext)
    if (!exists(p)) return p
  }
  return path.join(dir, stem + '-' + Date.now() + ext)
}

module.exports = { localDayKey, strictBase64, checkImportFileSize, pendingDeleteName, classifyBackupError, IMPORT_MAX_BYTES, formatLogLines, nextAvailableName, backupNameTs, sortBackupNamesNewestFirst, parseTomatoMetaBlob, stableRead, nextFreePath, tryForwardTomatoCmd }

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

/* ---- 2026-09-15 F2 round ---- */

/** Tomato command forwarding, single-step pure logic (extracted from index.js's polling closure so it is
 *  unit-testable with a mock window). Fixes the lost-command race: previously lastTomatoSeq advanced
 *  BEFORE webContents.send, with no isDestroyed recheck — a send failure during the window
 *  destroy/recreate gap was swallowed by the outer catch as a warn and the command was lost forever
 *  (seq already consumed → never re-sent).
 *  Contract:
 *  - raw missing / already consumed / locked / window or webContents missing-or-destroyed → state untouched, sent:false (next poll retries)
 *  - seq <= lastTomatoSeq (already delivered) → raw marked consumed, sent:false
 *  - send() succeeds → lastTomatoSeq advances to cmd.seq and raw is consumed; send throwing propagates to the caller's catch without advancing anything
 *  - clearCmd(cmd) (optional, round-1 P0 2026-09-21): invoked after a successful send so the
 *    caller can delete the cliTomatoCmd slot — without it a handled command re-executed on every
 *    app restart (lastTomatoSeq restarted at 0 per process). Compare-and-delete lives caller-side
 *    so this pure function stays free of db dependencies.
 *  - abandoned (r2 2026-09-28): a STAMPED command (at > 0) older than CLI_SLOT_ABANDON_TTL_MS is
 *    an APP_NOT_RUNNING giveaway — the CLI already reported failure (e.g. an unpair key rotation)
 *    and left the slot. Executing it the moment the window/lock recovers would fire it long after
 *    its writer gave up (the startup seed path already abandons such slots; the runtime forward
 *    path used to check seq only and would still execute it). The command is consumed WITHOUT
 *    executing: seq advances, raw is consumed, clearCmd runs, sent:false + abandoned:true.
 *    A command WITHOUT an `at` stamp keeps execute-once semantics (same policy as the seed).
 *  - poisoned (r6 2026-09-28): an unparseable slot payload used to be silently returned
 *    untouched — the slot was never cleared and every 500ms poll re-tried the same JSON.parse
 *    forever (the cliSyncCmd twin channel already compare-and-deletes such payloads since D6
 *    P2; this side had evolved single-sided). The parse failure now invokes clearCmd(null, raw)
 *    so the CALLER can compare-and-delete by the exact raw value (a seq compare is impossible —
 *    the payload has no usable seq), and returns poisoned:true so the caller can warn. The slot
 *    still not being deleted only means the next poll retries the cleanup, same as the sync
 *    channel.
 *  Returns { lastTomatoCmdRaw, lastTomatoSeq, sent, cmd, abandoned, poisoned }. */
const { isStaleSlotCmd } = require('./cli-slot-policy')

function tryForwardTomatoCmd ({ raw, lastTomatoCmdRaw, lastTomatoSeq, getMainWindow, isLocked, clearCmd, now }) {
  const untouched = { lastTomatoCmdRaw, lastTomatoSeq, sent: false, cmd: null, abandoned: false, poisoned: false }
  if (!raw || raw === lastTomatoCmdRaw) return untouched
  // r6 2026-09-28: 毒槽自愈,与 cli-sync-channel(D6 P2)同契约——解析失败不再静默 return
  // untouched(槽永不清除,每 500ms 轮询无限重试),而是触发调用侧按原始值 compare-and-delete。
  // 毒 payload 永远不可能变成可执行命令,故清除不受锁屏/窗口状态门控(锁屏延后的只是有效命令)。
  let cmd
  try { cmd = JSON.parse(raw) } catch {
    if (typeof clearCmd === 'function') { try { clearCmd(null, raw) } catch { /* best-effort cleanup */ } }
    return { ...untouched, poisoned: true }
  }
  if (typeof isLocked === 'function' && isLocked()) return untouched
  const win = typeof getMainWindow === 'function' ? getMainWindow() : null
  const wc = win && win.webContents
  // send 前复查 isDestroyed:winOk 判定后窗口可能即刻销毁;mock/真实 BrowserWindow 都要兼容缺方法的情况
  const winOk = win != null &&
    (typeof win.isDestroyed !== 'function' || !win.isDestroyed()) &&
    wc != null &&
    (typeof wc.isDestroyed !== 'function' || !wc.isDestroyed())
  if (!winOk) return untouched
  if (!cmd || !cmd.seq || cmd.seq <= lastTomatoSeq) return { lastTomatoCmdRaw: raw, lastTomatoSeq, sent: false, cmd: null, abandoned: false, poisoned: false }
  // r2 2026-09-28: 过期弃置与启动播种同策略(cli-slot-policy.isStaleSlotCmd)。CLI 已超时放弃
  // (APP_NOT_RUNNING)的命令不得在窗口恢复的瞬间补执行——只消费不执行,compare-and-delete 仍在调用侧 clearCmd。
  if (isStaleSlotCmd(cmd, typeof now === 'number' ? now : Date.now())) {
    if (typeof clearCmd === 'function') { try { clearCmd(cmd) } catch { /* slot cleanup is best-effort */ } }
    return { lastTomatoCmdRaw: raw, lastTomatoSeq: cmd.seq, sent: false, cmd, abandoned: true }
  }
  wc.send('cli-tomato-cmd', cmd) // 可能 throw(半销毁 peer):抛给调用方,seq/raw 均不推进 → 下轮轮询重投
  if (typeof clearCmd === 'function') { try { clearCmd(cmd) } catch { /* slot cleanup is best-effort */ } }
  return { lastTomatoCmdRaw: raw, lastTomatoSeq: cmd.seq, sent: true, cmd, abandoned: false }
}
