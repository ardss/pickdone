/**
 * Database disaster recovery + atomic disaster-backup write — extracted from index.js into a pure fs module testable in isolation.
 * Tiered recovery: todos.db corrupted → rename the corrupt file to preserve it → prefer the local plaintext backup (todos.db.plain-bak),
 * otherwise re-import the task list from the disaster-backup JSON (critical-state-backup.json).
 */
const fs = require('fs')
const { pruneCorruptScenes } = require('./corrupt-scene.cjs') // F1 size-cap trim: pure fs helper extracted (2026-10-17); F4 attLoss wired below (db-recovery-attachments.cjs)
const path = require('path')

/** Blob format versions recognizable by the recovery path: corresponds to the schemaV written by each renderer store.
 *  A segment without schemaV is treated as v1 (legacy data compatibility); > 1 = data from a future version being restored by the current one — reject importing that segment (prevents downgrade misreads). */
const SUPPORTED_SCHEMA_V = 1 // single source for the main/CLI restore side — exported at the bottom (renderer keeps its own ESM declaration across the process boundary)
let _log = null
function logWarn (...args) {
  try {
    if (!_log) _log = require('electron-log')
    require('./log-isolation') // test isolation: redirect electron-log file transport into TODO_DB_DIR/TODO_USER_DATA_DIR
    if (_log && _log.warn) return _log.warn(...args)
  } catch { /* electron-log unavailable (unit tests) */ }
  console.warn(...args)
}
const attLoss = require('./db-recovery-attachments.cjs')({ parseSegment, logWarn, criticalBackupPath }) // F4 P2 attachment-loss visibility (see that module)

/** Parse a segment of the backup JSON (two shapes: string/object); reject and return null when schemaV exceeds the supported version */
function parseSegment (seg, label) {
  let obj = seg || {}
  if (typeof obj === 'string') {
    try { obj = JSON.parse(obj) } catch { return {} }
  }
  if (obj && typeof obj === 'object' && (obj.schemaV || 1) > SUPPORTED_SCHEMA_V) {
    logWarn(`[dbRecovery] ${label}.schemaV=${obj.schemaV} is newer than the currently supported version ${SUPPORTED_SCHEMA_V}, refusing to import this segment (downgrade misread prevention)`)
    return null
  }
  return obj
}

/** Where the disaster-backup JSON lives. P0 root fix (2026-09-26, backup-path-fork): the reader
 *  used to hand-copy the OLD pre-migration derivation (parent-of-userData/pickdone-backups +
 *  legacy <userData>/critical-state-backup.json) while the writer moved to
 *  defaultBackupRootCandidates(ud)[0] = <userData>/backups — the recovery chain could never find
 *  the snapshot on any fresh install (and migrateLegacyBackups actively emptied the one directory
 *  this reader still watched). Now the reader consumes the SAME single source (backup-roots.cjs),
 *  keeping the legacy <userData>/critical-state-backup.json as an extra fallback checked last, and
 *  reporting candidates[0] (the write location) when nothing exists. */
function criticalBackupPath (ud) {
  const candidates = require('./backup-roots.cjs').defaultBackupRootCandidates(ud)
    .map(root => path.join(root, 'critical-state-backup.json'))
  const legacy = path.join(ud, 'critical-state-backup.json')
  for (const f of [...candidates, legacy]) {
    if (fs.existsSync(f)) return f
  }
  return candidates[0] // when neither exists, return the default write location
}
/** Critical-backup restore family — split to db-recovery-restore.cjs (size-ratchet);
 *  factory-injected with the shared probes, exactly like the attachments module above. */
const {
  RESTORE_SEGMENT_NAMES, META_RESTORE_PREFIXES,
  restoreMetaEntriesFromCriticalBackup,
  restoreSegmentsFromCriticalBackup, restoreTasksFromCriticalBackup, restoreTomatoRecordsFromCriticalBackup,
  restoreCategoriesFromCriticalBackup, criticalBackupRowCount, writeCriticalStateBackupAtomic,
} = require('./db-recovery-restore.cjs')({ parseSegment, criticalBackupPath, logWarn, SUPPORTED_SCHEMA_V, attLoss })

/** P2 fix (2026-09-26, json-exists-vs-parseable): whole-file parseability gate for the disaster
 *  backup. Existence alone made a torn/corrupt JSON yield source:'json' → an "empty DB recovery"
 *  that also STEERED away from a usable todos.db.plain-bak. An object shape (raw && object) is the
 *  plausible-backup bar; per-segment tolerance stays in the restore functions (parseSegment). */
function backupJsonParseable (file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
    return !!(raw && typeof raw === 'object')
  } catch { return false }
}

/** SQLite files start with the 16-byte magic "SQLite format 3\0". A todos.db whose header still
 *  carries the magic is NOT corrupt — an init failure over it was transient (lock held, WAL race,
 *  disk pressure) and renaming it aside would destroy the user's real data in exchange for a stale
 *  backup. Best-effort: unreadable/short file → header treated as bad. */
const SQLITE_MAGIC = 'SQLite format 3\x00'
function sqliteHeaderOk (file) {
  try {
    const fd = fs.openSync(file, 'r')
    try {
      const buf = Buffer.alloc(16)
      const bytesRead = fs.readSync(fd, buf, 0, 16, 0) // fs.readSync returns the byte count directly
      return bytesRead === 16 && buf.toString('binary') === SQLITE_MAGIC
    } finally { fs.closeSync(fd) }
  } catch { return false }
}

/** Pure mapping of the startup recovery dialog's (recovered, choice) → action, extracted from
 *  index.js (2026-09-25) so the button table and its branch chain stay in lockstep and the map
 *  is unit-testable without Electron. Buttons (index.js, same order):
 *    recovered:   [btnRecoverRelaunch, btnOpenDataDir, btnQuit]
 *    !recovered:  [btnOpenDataDirBackup, btnResetRelaunch, btnQuit]
 *  Fix 2026-09-25 (P1): the recovered choice===1 button promised "open data dir" but the old
 *  inline chain only ran app.quit() — shell.openPath was never called on that branch. */
function recoveryDialogAction (recovered, choice) {
  if (recovered) {
    if (choice === 0) return 'relaunch'
    if (choice === 1) return 'open-data-dir' // caller does shell.openPath(ud) then app.quit()
    return 'quit'
  }
  if (choice === 0) return 'open-data-dir' // caller does shell.openPath(ud) then app.quit()
  if (choice === 1) return 'reset-and-relaunch'
  return 'quit'
}

/** Vendor driver, resolved the same way db.js resolves it (repo vendor/ in dev, resourcesPath is
 *  handled by db.js itself — this pure module only ever runs against the repo layout in tests and
 *  the packaged layout always has vendor/ next to app root). Null when unavailable: the probe then
 *  answers 'unknown' and the caller stays CONSERVATIVE (never destroys data on an inconclusive probe). */
function loadVendorDriver () {
  // Packaged layout (mirror of db.js loadDriver): the driver lives in extraResources at
  // resources/vendor — the repo-relative path below does not exist inside app.asar, so without
  // this branch the probe could never answer 'yes'/'no' in a packaged build and a genuinely
  // corrupt encrypted db stayed 'unknown' (recovery path unreachable in the wild).
  const candidates = []
  try { if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'vendor', 'better-sqlite3-multiple-ciphers')) } catch { /* non-Electron runtime without the field */ }
  candidates.push(path.join(__dirname, '..', '..', 'vendor', 'better-sqlite3-multiple-ciphers'))
  for (const root of candidates) {
    try { return require(root) } catch { /* try next candidate */ }
  }
  return null
}

/** P2 (dw wave5 2026-09-24): the plaintext-magic header guard is ALWAYS false for this repo's
 *  steady state — a multiple-ciphers encrypted todos.db starts with CIPHERTEXT, not the magic.
 *  This probe decides "is the db actually readable with its key": readonly open + PRAGMA key +
 *  a real read of sqlite_master (decryption happens on first page read, journal_mode alone does
 *  not throw — same probe shape as db.js's open path). Answers:
 *    'yes'     decryptable → the db is healthy; init failure was transient → NEVER rename/rollback
 *    'no'      key present but the file cannot be decrypted → genuinely corrupt → recovery may proceed
 *    'unknown' driver unavailable / key unreadable → inconclusive → caller must stay conservative
 *  Key validity rule mirrors db.js: a non-64-hex db.key is treated as no-key (plaintext-continuation). */
function encryptedProbe (file, keyFile) {
  const Database = loadVendorDriver()
  if (!Database) return 'unknown'
  let key
  // F20 (dw wave6 2026-09-24): a key-read IO failure (AV/lock瞬时占用 — existsSync at the caller
  // already passed) used to map to 'no' = "genuinely corrupt", which re-opened the wave5 hole:
  // a HEALTHY db got renamed + rolled back to a stale backup through this side door. Unreadable
  // key is exactly the 'unknown' case this comment block always promised ("key unreadable → stay
  // conservative"); only a READABLE key that is not 64-hex counts as keyless ('no').
  try { key = fs.readFileSync(keyFile, 'utf8').trim() } catch { return 'unknown' }
  // M2a (P2): a READABLE key that is not 64-hex used to map to 'no' = "genuinely corrupt", which
  // let the recovery rename a possibly-healthy db aside. But db.js's key-validity rule treats a
  // non-64-hex key as NO-KEY (plaintext continuation, db.js:304-309) — the db would open fine as
  // plaintext at init. The probe cannot classify such a db, so answer 'unknown' (conservative:
  // no rename, no rollback) exactly like an unreadable key.
  if (!/^[0-9a-fA-F]{64}$/.test(key)) return 'unknown'
  let db
  // [J4 2026-10-24] open-vs-decrypt split. Evidence: three red-round scenes (dWcIg3/YZPQpk/
  // RzKpwu) show a HEALTHY encrypted db renamed to .corrupt-* here — `new Database(file)`
  // threw a TRANSIENT open error (hard-killed predecessor's handles / AV hold: disk I/O error)
  // and the old catch folded it into 'no' = genuinely corrupt, triggering quarantine of a
  // healthy library plus a JSON restore that carries no sync.* machine-local rows (pairing
  // state permanently evaporated). A failed OPEN carries no decryption verdict → 'unknown'
  // (conservative: no rename). Only "open succeeded, key accepted, page read failed" is 'no'.
  try {
    db = new Database(file, { readonly: true })
  } catch (e) {
    if (/disk i\/o|sqlite_ioerr|can'?t open|unable to open|database is locked|database table is locked|EBUSY|EPERM/i.test(String(e && e.message))) return 'unknown'
    return 'no'
  }
  try {
    db.pragma(`key='${key}'`)
    db.prepare('SELECT count(*) FROM sqlite_master').get()
    return 'yes'
  } catch { /* open succeeded + key accepted at pragma time + page read failed = genuine decrypt failure */ return 'no' } finally { try { db.close() } catch { /* already closed on probe failure */ } }
}

/** M-1 (2026-09-20): make sure a stale db.key is OUT of the way before the restored (plaintext)
 *  DB is reopened. Consistent with the plaintext-continuation contract ("a missing db.key leaves
 *  the fresh DB plaintext-readable, same as a fresh install"): prefer renaming aside (preserves
 *  forensic evidence), fall back to rename-with-.bad suffix, then to deletion. Returns true when
 *  the key is gone or never existed; false when every strategy failed — the caller must then NOT
 *  claim recovery success. Exported for unit tests (failure injection). */
function quarantineKey (ud, stamp) {
  const key = path.join(ud, 'db.key')
  if (!fs.existsSync(key)) return true // already plaintext-continuation shaped
  for (const suffix of ['.corrupt-' + stamp, '.bad-' + stamp]) {
    try { fs.renameSync(key, key + suffix); return true } catch { /* locked/AV-held: try next strategy */ }
  }
  try { fs.rmSync(key, { force: true }); return !fs.existsSync(key) } catch { return false }
}

/** Tiered recovery of a corrupted DB: returns {source,label} (source ∈ 'plain-bak'|'json'|'transient'; null = nothing recoverable).
 *  source is the structured branch flag — display strings must never drive logic (a copy rewrite once silently killed the JSON branch). Corrupt files are always renamed and preserved, never deleted.
 *  P2 2026-09-19: an existence-only recoverable-source check used to rename a HEALTHY todos.db on a
 *  transient init failure (lock held / WAL race). Now: when the main file's SQLite header is intact
 *  the DB is NEVER treated as corrupt — retry init once (optional `retryInit` callback); 'retry-ok'
 *  = retry succeeded, 'transient' = retry failed but the file is still healthy. Only a wrong header
 *  AND a recoverable source proceed to the rename path. */
/** 恢复优先级 = JSON 优先于 plain-bak(2026-09-04 深审 P0 倒置修复):critical JSON 是渲染端持续覆盖的最新快照,
 *  .plain-bak 是加密迁移那一刻的一次性快照、之后永不更新——旧的"plain-bak 优先"会在迁移一年后损坏时恢复一年前数据。
 *  .corrupt-* 现场只保留最近 3 套,更早的删除(无限累积曾无治理)。 */
/** Sync-4/Sync-17 (D12 2026-10-01): recovery-pending sentinel. Two live crash windows leave the
 *  same poison state on disk: a HEALTHY-HEADER but EMPTY todos.db with an unconsumed, parseable
 *  critical-state-backup.json —
 *    Sync-4  crash between the empty re-init and the JSON restore (index.js catch-block);
 *    Sync-17 re-init failed (jsonRestoreAllowed gate) after the corrupt db was already
 *            quarantined → source:'json' returned, zero bytes restored, success semantics.
 *  On every later boot the healthy-header guard then answered 'transient' forever (Sync-4) or the
 *  plain-bak branch was permanently suppressed (Sync-17): the user sat on an empty DB silently.
 *  index.js marks the sentinel exactly when that state is created and clears it when the JSON
 *  restore provably consumed the snapshot; attemptDbRecovery treats (sentinel + parseable JSON)
 *  as grounds to quarantine the empty shell and replay the restore. Pure fs → unit-testable. */
function recoveryPendingPath (ud) {
  return path.join(ud, 'recovery-pending.json')
}

/** Pure decision for the init-SUCCESS boot path (mig-restore-sentinel-cleared-before-consumer):
 *  the sentinel used to be cleared unconditionally on init success while the replay it stands for
 *  was only ever consumed inside the dbm.init failure catch — a hard crash in that window left a
 *  parseable critical backup stranded behind a cleared sentinel. The success path must re-evaluate
 *  the SAME gate attemptDbRecovery uses at :218: parseability (not mere existence) of the snapshot.
 *  Returns { replay, jsonPath } so the caller can gate the plain-bak cleanup on the same verdict. */
function cleanInitReplayDecision (ud) {
  const jsonPath = criticalBackupPath(ud)
  return { replay: hasRecoveryPending(ud) && backupJsonParseable(jsonPath), jsonPath }
}
function markRecoveryPending (ud, info) {
  try {
    fs.mkdirSync(ud, { recursive: true })
    // D21 (P3 2026-10-02): durable write (tmp → fsync → rename) — this sentinel is the LAST line
    // of defense before a corrupt db is renamed away; if the rename-past-it ordering inverted
    // (plain writeFileSync vs OS cache), recovery could silently never replay.
    require('./durable-fs').writeFileDurable(recoveryPendingPath(ud), JSON.stringify({
      reason: String((info && info.reason) || 'json-restore-unconsumed'),
      at: Date.now()
    }))
    return true
  } catch { return false }
}
function clearRecoveryPending (ud) {
  try { fs.rmSync(recoveryPendingPath(ud), { force: true }); return true } catch { return false }
}
function hasRecoveryPending (ud) {
  return fs.existsSync(recoveryPendingPath(ud))
}

function attemptDbRecovery (ud, retryInit) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const mainDb = path.join(ud, 'todos.db')
  // Confirm a recoverable source exists before renaming: transient IO errors (disk full/lock held) also make init fail; renaming unconditionally
  // would mislabel the user's current database as .corrupt and fall back to a stale backup or even an empty DB
  const plainBakExists = fs.existsSync(path.join(ud, 'todos.db.plain-bak'))
  // restore-plainbak-copied-without-header-gate (P2): the plain-bak branch gated on EXISTENCE only
  // and the copy below ran without validation, so a torn plain-bak overwrote todos.db — the same
  // class of hole the JSON side closed with backupJsonParseable. Gate symmetrically with the JSON
  // one: a plain-bak counts as a recoverable source only when its SQLite header is intact. A
  // garbage plain-bak is NEVER deleted (forensics doctrine, same as .corrupt-*): with no usable
  // JSON the recovery returns null ("nothing recoverable") and the file stays on disk for the
  // caller's dialog / manual salvage.
  const plainBakUsable = plainBakExists && sqliteHeaderOk(path.join(ud, 'todos.db.plain-bak'))
  // P2 fix (2026-09-26, json-exists-vs-parseable): an existing-but-unparseable JSON no longer
  // counts as a recoverable source — the old existence-only check produced a source:'json'
  // "recovery" that re-inited an EMPTY DB and outranked a usable plain-bak.
  const jsonPath = criticalBackupPath(ud)
  const jsonFileExists = fs.existsSync(jsonPath)
  const jsonExists = jsonFileExists && backupJsonParseable(jsonPath)
  // Sync-4/Sync-17: the sentinel only ever outranks the healthy-header guard when there is a
  // parseable snapshot to replay — with no usable JSON the empty-shell diagnosis has no remedy
  // and the conservative no-rename behavior must stand.
  const replayPending = hasRecoveryPending(ud) && jsonExists
  // P2 2026-09-19: healthy header → the DB itself is fine; the init failure was transient. Retry
  // init once when a hook is provided; regardless of the retry outcome a header-intact DB is never
  // renamed — "corrupt" requires a WRONG header, not merely a failed init.
  // Sync-4/Sync-17 exception: a pending sentinel + parseable JSON identifies this header-intact
  // DB as the EMPTY SHELL of an interrupted recovery — fall through to the quarantine/replay path
  // instead of answering 'transient' forever.
  if (fs.existsSync(mainDb) && sqliteHeaderOk(mainDb)) {
    if (!replayPending) {
    if (typeof retryInit === 'function') {
      try {
        const retried = retryInit()
        if (retried && typeof retried.then === 'function') {
          // async retry not supported by the sync recovery contract
          return { source: 'transient', label: 'transient init failure; SQLite header intact (no rename performed)' }
        }
        return { source: 'retry-ok', label: 'transient init failure; SQLite header intact, retry succeeded (no rename performed)' }
      } catch {
        return { source: 'transient', label: 'transient init failure persists; SQLite header intact, recovery NOT performed (healthy DB preserved)' }
      }
    }
    // No retry hook available: still never rename a header-healthy DB on an existence-only guess.
    return { source: 'transient', label: 'transient init failure; SQLite header intact (no rename performed)' }
    }
    logWarn('[dbRecovery] recovery-pending sentinel + parseable critical backup: header-intact todos.db is the empty shell of an interrupted recovery — quarantining it and replaying the JSON restore')
  }
  // P2 (dw wave5 2026-09-24): an ENCRYPTED db (db.key present) starts with ciphertext, so the
  // plaintext-magic guard above is always false for it — the old code treated every encrypted db
  // as corrupt and renamed a HEALTHY one aside on the first transient init failure, rolling back
  // to a stale backup. When a key exists, decide by the decrypt probe instead: decryptable =
  // healthy, same protection as a header-intact plaintext db (retry once, never rename);
  // undecryptable = genuinely corrupt, fall through to the recovery path. An inconclusive probe
  // (driver unavailable) stays conservative: no rename, no rollback.
  const keyFile = path.join(ud, 'db.key')
  // D13 finding 2: the recovery-pending sentinel must outrank the decrypt probe exactly like it
  // outranks the plaintext healthy-header guard above. The post-crash re-initialized ENCRYPTED
  // empty shell (db.key present, fresh empty DB decrypts with its key) used to answer 'transient'
  // here forever — the user sat on an empty DB with an unconsumed JSON snapshot, the exact state
  // the sentinel was built to catch. replayPending already requires a PARSEABLE snapshot, so the
  // guard stays conservative without one (probe verdict unchanged on that path).
  if (fs.existsSync(mainDb) && fs.existsSync(keyFile) && !replayPending) {
    const probe = encryptedProbe(mainDb, keyFile)
    if (probe !== 'no') {
      // 2026-09-25: the transient/declined outcomes used to return silently — the caller's error
      // dialog then either claimed a recovery that never happened or showed no reason at all.
      // Log the probe verdict with every no-rename return so the trail explains WHY nothing was touched.
      if (probe === 'yes' && typeof retryInit === 'function') {
        try {
          const retried = retryInit()
          if (retried && typeof retried.then === 'function') {
            logWarn('[dbRecovery] transient init failure; encrypted db decrypts with its key (probe=yes); async retry unsupported, no rename performed')
            return { source: 'transient', label: 'transient init failure; encrypted db decrypts with its key (no rename performed)' }
          }
          return { source: 'retry-ok', label: 'transient init failure; encrypted db decrypts with its key, retry succeeded (no rename performed)' }
        } catch {
          logWarn('[dbRecovery] transient init failure persists; encrypted db decrypts with its key (probe=yes), recovery NOT performed (healthy DB preserved)')
          return { source: 'transient', label: 'transient init failure persists; encrypted db decrypts with its key, recovery NOT performed (healthy DB preserved)' }
        }
      }
      const declinedLabel = probe === 'yes'
        ? 'transient init failure; encrypted db decrypts with its key (no rename performed)'
        : 'decrypt probe inconclusive (sqlite driver unavailable or db.key unreadable) — recovery declined to avoid destroying a possibly-healthy encrypted DB (no rename performed)'
      logWarn('[dbRecovery] recovery declined: probe=' + probe + ' — ' + declinedLabel)
      return { source: 'transient', label: declinedLabel }
    }
  }
  // (plainBakUsable / jsonPath / jsonExists are computed above the healthy-header guard — the
  // Sync-4/Sync-17 sentinel bypass needs them before that early-return. plainBakUsable replaces
  // the old existence-only plainBakExists here: a garbage plain-bak with no usable JSON must not
  // enter the quarantine-and-copy path at all.)
  if (!plainBakUsable && !jsonExists) return null
  // P1 2026-09-20: quarantine used to swallow rename failures (`catch {}`) and then fall through
  // to copying the backup OVER a possibly-locked/possibly-open target — a silent recovery loop
  // (corrupt file never moved, backup copy fails or hybrids the DB, dialog claims recovery every
  // launch). Now: a rename failure is LOGGED and aborts this branch with a structured
  // source:'error' result, so the caller's relaunch dialog explains the failure instead of
  // pretending recovery happened. Never copy onto a target we could not first move aside.
  // D13 finding 14: rename the SIDECARS first and the main DB LAST. The old ['', '-wal', '-shm']
  // order aborted on the first failure — a main-DB rename that succeeded while the -wal rename
  // failed (locked/AV-held) left todos.db MISSING with a live -wal beside it; the next init then
  // created a fresh empty todos.db (SQLite resets the stale WAL), and because the new file has a
  // healthy header the recovery never re-fired — the real data survived only in .corrupt-*. With
  // sidecars-first a mid-loop failure leaves todos.db in place and recovery is retried next boot.
  for (const suf of ['-shm', '-wal', '']) {
    const src = path.join(ud, 'todos.db' + suf)
    if (!fs.existsSync(src)) continue
    try {
      fs.renameSync(src, src + '.corrupt-' + stamp)
    } catch (e) {
      logWarn('[dbRecovery] failed to quarantine', src, '-', e && e.message, '— recovery branch ABORTED (no backup copied over a possibly-locked target)')
      return { source: 'error', label: 'corrupt DB could not be quarantined: ' + String(e && e.message || e) }
    }
  }
  if (!quarantineKey(ud, stamp)) {
    // M-1 (2026-09-20): the old code treated a failed key rename as best-effort and continued —
    // but the restored DB is PLAINTEXT while the stale db.key is still on disk, so the follow-up
    // init at index.js reopened the restored DB with the OLD WRONG key, the decrypt probe failed,
    // and the user got a "recovery succeeded" dialog while every launch kept failing. A stale key
    // that cannot be moved or deleted is the same abort condition as a DB rename failure: report
    // source:'error' so the caller shows a failure dialog instead of a false success.
    return { source: 'error', label: 'stale db.key could not be quarantined (rename and delete both failed) — reopening the restored plaintext DB with the old key would fail every launch' }
  }
  pruneCorruptScenes(ud)
  if (jsonExists) return { source: 'json', label: 'disaster-backup JSON (fresh)' }
  // F1 (2026-10-17): bare call before — a disk-full/EPERM failure propagated OUT and crashed
  // startup though the corrupt DB was already quarantined. Structured source:'error' like the
  // failures above, so the dialog explains it instead of crashing.
  try { copyFileAtomicRestore(path.join(ud, 'todos.db.plain-bak'), path.join(ud, 'todos.db')) } catch (e) {
    logWarn('[dbRecovery] plain-bak restore copy failed:', e && e.message, '— corrupt DB preserved in .corrupt-*')
    return { source: 'error', label: 'plain-bak restore copy failed: ' + String(e && e.message || e) + ' (corrupt DB preserved in .corrupt-*)' }
  }
  // Truthful label: when the JSON existed but failed the parseability gate, the caller's dialog
  // must say the restore came from the (possibly stale) plain-bak, not from the JSON.
  if (jsonFileExists) return { source: 'plain-bak', label: 'disaster-backup JSON unparseable, restored from plain-bak (todos.db.plain-bak, possibly stale)' }
  return { source: 'plain-bak', label: 'local plaintext backup (todos.db.plain-bak, possibly stale)' }
}

/** D19-DOM1 (2026-10-02): atomic restore copy. Both plain-bak restore sites used bare
 *  fs.copyFileSync — a torn copy of a multi-MB backup (power cut / crash mid-copy) left a
 *  todos.db TRUNCATED but with an intact first page, which SQLite's healthy-header probe
 *  classified as 'transient' forever and permanently bypassed recovery. Route through
 *  durable-fs (tmp + fsync + atomic rename): the target is either fully absent or fully
 *  the backup, never a hybrid. Exported so the restore contract is unit-testable. */
function copyFileAtomicRestore (src, dest) {
  return require('./durable-fs').writeFileDurable(dest, fs.readFileSync(src))
}


/** P2 (dw wave5 2026-09-24, sunk from index.js whenReady — this module is the pure-fs home for
 *  startup recovery orchestration): plain-bak residue precheck. Three conditions together are the
 *  crash-between-two-renames scene of migratePlainToEncrypted: no todos.db + plain-bak + no db.key
 *  → clear orphan WAL and put the plaintext copy back. No todos.db + plain-bak + a db.key still
 *  present (user hand-deleted the db etc.) → move the key aside and restore the bak; init then
 *  re-encrypts with a fresh key, data preserved. Pure fs over the userData path → unit-testable. */
function preflightMigrateResidue (ud, log) {
  const warn = (...a) => { try { (log || console).warn('[Init] ' + a.join(' ')) } catch { /* best-effort */ } }
  try {
    const mainDb = path.join(ud, 'todos.db')
    const bak = path.join(ud, 'todos.db.plain-bak')
    if (fs.existsSync(mainDb) || !fs.existsSync(bak)) return false
    // M8B fix 6 (P3): the main recovery path gates plain-bak usability on sqliteHeaderOk
    // (attemptDbRecovery's plainBakUsable) — this preflight copied on EXISTENCE only, so a torn
    // plain-bak became todos.db and init landed in the same corrupt loop the gate exists to
    // prevent. Gate symmetrically: a garbage-header bak is skipped (nothing copied, todos.db
    // stays absent, no false "recovered" log); the file is never deleted (forensics doctrine).
    if (!sqliteHeaderOk(bak)) {
      warn('迁移中断残留:todos.db.plain-bak 缺少有效 SQLite 头(疑似 torn copy)——跳过恢复,todos.db 保持缺失,文件保留待人工排查')
      return false
    }
    const key = path.join(ud, 'db.key')
    if (!fs.existsSync(key)) {
      for (const suf of ['-wal', '-shm']) { try { fs.rmSync(mainDb + suf, { force: true }) } catch {} }
      copyFileAtomicRestore(bak, mainDb)
      warn('迁移中断残留:已从 todos.db.plain-bak 恢复数据库文件')
    } else {
      // enc-migration-preflight-ignores-key-quarantine-failure (P2): the key rename failure used to
      // be swallowed (`catch {}`) and the flow CONTINUED — unconditional sidecar rm + copying the
      // plaintext bak over a fresh todos.db + return true, while the stale db.key was still on
      // disk. The follow-up init reopened the restored PLAINTEXT db with the OLD WRONG key →
      // db.js lands in the permanent transient/dbEncMismatch dead-loop state. Root-cause rule
      // (mirrors M-1 / D13 #14 doctrine): a key that cannot be moved aside ABORTS the migration —
      // log the specific error, touch nothing (todos.db stays absent, plain-bak + db.key intact)
      // and return false so the next boot retries the whole preflight.
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      try {
        fs.renameSync(key, key + '.superseded-' + stamp)
      } catch (e) {
        warn('db.key could not be renamed aside (' + ((e && e.message) || e) + ') — plain-bak restore ABORTED, todos.db left absent, next boot will retry')
        return false
      }
      for (const suf of ['-wal', '-shm']) { try { fs.rmSync(mainDb + suf, { force: true }) } catch {} }
      copyFileAtomicRestore(bak, mainDb)
      warn('todos.db missing but a plaintext backup exists: restored from plain-bak, old db.key moved aside as db.key.superseded-*')
    }
    // Orphaned migration tmp sweep (fix 2026-10-06): a crash between migratePlainToEncrypted's
    // two renames leaves a fully-written todos-encrypted.tmp forever — it was never swept nor
    // used by recovery. After the plain-bak restore put the DB back, rename the tmp aside
    // (best-effort, timestamped so repeated interrupted migrations cannot collide); leaving it
    // in place would only confuse later boots and accumulate stale encrypted snapshots.
    const encTmp = path.join(ud, 'todos-encrypted.tmp')
    if (fs.existsSync(encTmp)) {
      try {
        fs.renameSync(encTmp, encTmp + '.stale-' + new Date().toISOString().replace(/[:.]/g, '-'))
        warn('interrupted-migration residue: todos-encrypted.tmp renamed aside (no longer occupies the real filename)')
      } catch (e2) {
        warn('todos-encrypted.tmp rename failed (locked, left for next-launch retry):', (e2 && e2.message) || e2)
      }
    }
    return true
  } catch (e) {
    warn('plain-bak preflight failed', (e && e.message) || e)
    return false
  }
}

/** M2a (P3): critical-state-backup.empty-*.json side files (written by writeCriticalStateBackupAtomic's
 *  destroy-guard when an empty snapshot must not clobber a good backup) accumulated forever — no
 *  cleanup side existed. Keep the most recent KEEP (default 5) by timestamp, sweep older ones.
 *  Returns the number of entries swept. Exported for direct unit coverage. */
function sweepEmptyCriticalBackups (ud, keep, log) {
  const n = Number(keep) > 0 ? Number(keep) : 5
  let swept = 0
  try {
    // The embedded Date.now() makes the names sort chronologically (fixed prefix + epoch ms).
    const files = fs.readdirSync(ud)
      .filter(f => /^critical-state-backup\.empty-\d+\.json$/.test(f))
      .sort()
    for (const f of files.slice(0, Math.max(0, files.length - n))) {
      try { fs.rmSync(path.join(ud, f), { force: true }); swept++ } catch { /* locked → next launch */ }
    }
  } catch (e) { try { (log || console).warn('[Init] empty-critical-backup 清扫失败', e) } catch { /* best-effort */ } }
  return swept
}

/** P2 (dw wave5 2026-09-24, sunk from index.js whenReady): sweep files renamed aside by a previous
 *  "reset data" while their handles were still open (pending-delete-<ts>-*). At next startup the
 *  handles are gone; delete them best-effort. Returns the number of entries swept.
 *  M2a (P3): this is the existing startup-sweep call chain index.js already reaches, so the
 *  empty-critical-backup sweep rides along here — no index.js change needed. */
function sweepPendingDeletes (ud, log) {
  let swept = 0
  try {
    for (const f of fs.readdirSync(ud)) {
      if (!f.startsWith('pending-delete-')) continue
      try { fs.rmSync(path.join(ud, f), { force: true, recursive: true }); swept++ } catch {}
    }
  } catch (e) { try { (log || console).warn('[Init] pending-delete 清扫失败', e) } catch { /* best-effort */ } }
  swept += sweepEmptyCriticalBackups(ud, 5, log)
  return swept
}

/** Pure gate for the startup catch-block: the JSON restore writes through the command bus, so it
 *  may only run when the re-init actually brought the DB back. When re-init failed too (2026-09-26
 *  lubancat: the vendor driver itself could not load under Debian 11's glibc), every busCommit in
 *  the restore path throws ("stmts.upsertMany is not a function") and the "recovery" rebuilds
 *  nothing while the log pretends an attempt happened. */
function jsonRestoreAllowed (recoveredFrom, reinitErr) {
  return !!(recoveredFrom && recoveredFrom.source === 'json' && !reinitErr)
}

/** [structure-ratchet 2026-10-25] the recovery dialog's detail paragraph, extracted from
 *  index.js (that file sits ON its 860-line baseline — this copy lived here by domain
 *  anyway). Pure string assembly over the recovery outcome fields; mt is injected.
 *  [J4 follow-up 2026-10-25] the transient branch (retried OK, nothing restored) gets its
 *  own honest copy instead of "restored 0 tasks".
 *  [H4 2026-10-25] a rebuilt-from-backup db discloses the sync consequence. */
function recoveryDetailText ({ errText, recoveryFailed, recoveredFrom, restoredN, reinitErr, degradedNote, mt }) {
  const transientOk = !!(recoveredFrom && (recoveredFrom.source === 'retry-ok' || recoveredFrom.source === 'transient'))
  const body = recoveryFailed
    ? ' ' + recoveredFrom.label
    : transientOk
      ? mt('dbFailTransientRecovered')
      : recoveredFrom
        ? mt('dbFailRecovered', { n: restoredN })
        : mt('dbFailRecoveredNone')
  const syncNote = !recoveryFailed && recoveredFrom && (recoveredFrom.source === 'json' || recoveredFrom.source === 'plain-bak')
    ? '\n\n' + mt('dbFailSyncResetNote')
    : ''
  return String(errText) + '.' + body +
    (reinitErr ? mt('dbFailReinit', { msg: reinitErr.message }) : '') +
    (degradedNote ? '\n\n[degraded snapshot] segments missing from the recovered backup: ' + degradedNote : '') +
    syncNote
}

module.exports = { attemptDbRecovery, cleanInitReplayDecision, SUPPORTED_SCHEMA_V, restoreTasksFromCriticalBackup, restoreSegmentsFromCriticalBackup, writeCriticalStateBackupAtomic, criticalBackupPath, criticalBackupRowCount, backupJsonParseable, restoreCategoriesFromCriticalBackup, restoreTomatoRecordsFromCriticalBackup, restoreMetaEntriesFromCriticalBackup, quarantineKey, sqliteHeaderOk, encryptedProbe, preflightMigrateResidue, sweepPendingDeletes, sweepEmptyCriticalBackups, recoveryDialogAction, jsonRestoreAllowed, recoveryDetailText, loadVendorDriver, RESTORE_SEGMENT_NAMES, META_RESTORE_PREFIXES, recoveryPendingPath, markRecoveryPending, clearRecoveryPending, hasRecoveryPending, copyFileAtomicRestore, ...attLoss }
