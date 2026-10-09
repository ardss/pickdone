/**
 * Database layer — independently implemented local task-store schema * (todos.db / WAL / two tables todos + meta / prepared statements under the same names)
 */
const path = require('path')
const i18nM = require('./i18n')
const fs = require('fs')
const crypto = require('crypto')
const LIMITS = require('../../shared/limits.mjs') // focus-duration clamp constants (single source, audit item 4); require(esm) — Node >= 22.12
const { normalizeContent, rowToTodo, todoToRow, setSyncAuthor, selfSyncAuthor, matchTodoKeywordTerms, matchTodoKeyword, keywordLimitWindow } = require('./db-rows')
// snowDedup key-cap (R5 P3): past the cap, older-than-30d entries are pruned (see bumpSnow).
const SNOW_DEDUP_CAP = 2000
const SNOW_DEDUP_MAX_AGE_MS = 30 * 24 * 3600 * 1000
// electron-log only exists inside the packaged App; the standalone CLI (extraResources bundle) has no // node_modules/electron-log, so fall back to a no-op logger instead of crashing at require time
let log
try { log = require('electron-log') } catch { log = { info () {}, warn () {}, error () {} } }
require('./log-isolation') // test isolation: file transport -> TODO_DB_DIR/TODO_USER_DATA_DIR
const oplog = require('./db-oplog')({
  getDb: () => db,
  log,
  getPurgeChips: () => purgeChipsScratch,
  // r3 fix (2026-09-28): a failed delta-row append used to be log-only — the loss was invisible // (peers stop receiving that change until the next full snapshot while the push watermark // advances). Surface it through the Device Center sync-event channel (lazy require:
  // lan-sync-bootstrap may not be initialized yet — its emitter is guarded and no-ops then). onAppendFailure: info => { try { require('./lan-sync-bootstrap').emitOplogAppendFailure(info) } catch { /* surfacing is best-effort */ } },
}), syncSchema = require('./db-sync-schema')({ getDb: () => db, log })
// Sync v2 write-path recorder (flag-gated, see db-revisions.cjs): mirrors the oplog // contract — never fails an already-committed write, warn + continue on error.
const revisions = require('./db-revisions.cjs')({ getDb: () => db, log })
const oplogKeepLimit = require('./db-oplog').oplogKeepLimit // D3 2026-09-24: SYNC_OPLOG_KEEP single source (was a bare 10000 clamp literal)

let Database = null
function loadDriver () {
  if (Database) return Database
  // Packaged layout: the driver lives in extraResources (resources/vendor, all platform prebuilds) — NOT in app.asar. The asar copy was pruned per-arch by electron-builder's smart filtering, and the bundled CLI already resolves this same resources/vendor copy via its own relative require, so the app aligning onto it keeps one authoritative driver per package. Dev runs fall back to the repo-relative path.
  let vendorRoot = path.join(__dirname, '..', '..', 'vendor', 'better-sqlite3-multiple-ciphers')
  try {
    const { app } = require('electron')
    if (app && app.isPackaged && process.resourcesPath) {
      vendorRoot = path.join(process.resourcesPath, 'vendor', 'better-sqlite3-multiple-ciphers')
    }
  } catch { /* plain-node callers (tests, CLI dev mode): repo-relative path is correct */ }
  // Prefer the embedded official N-API prebuilt driver (no compilation needed)
  try {
    Database = require(vendorRoot)
    log.info('[TodoDB] 使用 vendor better-sqlite3-multiple-ciphers')
    return Database
  } catch (e) {
    // npm 版不在依赖里（打包面只有 vendor），fallback 必然 MODULE_NOT_FOUND——重抛真实错误，别用误导性的找不到模块掩盖 ABI/缺文件问题
    log.error('[TodoDB] vendor better-sqlite3-multiple-ciphers 加载失败', e.message)
    throw e
  }
}

let db = null
const stmts = {}
/** Drop every cached prepared statement (they belong to the closed handle; re-init prepares fresh ones) */
function stmtsClearAll () { for (const k of Object.keys(stmts)) delete stmts[k]; oplog.oplogReset() }

/** Oplog statements cache the old handle after close/re-init — reset them with the rest */

/** Database encryption key (stored at userData/db.key, same directory as the DB so it travels with migrations).
 *  Threat model: prevents the single todos.db file from being read directly by sync drives/copies/forensic tools;
 *  the key lives on the same machine, so scenarios where "the entire userData is readable" are not covered (stronger protection would need DPAPI; evaluate post-release). */
/** One-time migration of an existing plaintext DB to an encrypted DB: ATTACH the encrypted target + create tables per the existing SCHEMA + copy rows table by table,
 *  keeping the original file as a .plain-bak fallback (the driver lacks sqlcipher_export, so migration is manual) */
function migratePlainToEncrypted (dir, file, key) {
  const encFile = path.join(dir, 'todos-encrypted.tmp')
  try {
    fs.rmSync(encFile, { force: true })
    // Test-only seam (2026-09-24 C12): a hook returning true simulates a crash mid-rename — // the hook stages the on-disk state itself, then the REAL catch/restore path runs.
    if (migrateFailHook && migrateFailHook({ dir, file, encFile })) {
      throw new Error('[TodoDB] injected migration failure (test seam)')
    }
    // ATTACH 的 KEY 是 SQL 字面量(参数化不支持),必须双写单引号——加密 key 是唯一触碰 SQL 字符串的敏感值
    const keyLiteral = String(key).replace(/'/g, "''")
    db.exec(`ATTACH DATABASE '${encFile.replace(/'/g, "''")}' AS enc KEY '${keyLiteral}'`)
    // 2026-10-10: line-anchored rewrite (an unanchored replace mangled comments containing the substring).
    const encSchema = SCHEMA
      .replace(/^[ \t]*CREATE TABLE IF NOT EXISTS /gm, 'CREATE TABLE IF NOT EXISTS enc.')
      .replace(/^[ \t]*CREATE INDEX IF NOT EXISTS /gm, 'CREATE INDEX IF NOT EXISTS enc.')
    db.exec(encSchema)
    // 表清单动态枚举,禁手工维护:2026-09-04 深审实锤硬编码四表漏了 plan_chips/tomato_records,行表化用户的账本会在迁移中被清空(P0)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name)
    for (const table of tables) {
      // Copy by NAME (see db-enc-copy.js): positional SELECT * shifted ALTER-appended columns on legacy DBs.
      require('./db-enc-copy')(db, table)    }
    db.exec('DETACH DATABASE enc')
    // Explicit wal_checkpoint(TRUNCATE) before closing: ensure the plaintext WAL tail writes have landed in the main file before the WAL can be safely deleted (otherwise .plain-bak may miss tail data)
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()
    // main-ipc-2 fsync fix (2026-09-22): the key must be PERSISTENTLY on disk before the renames // below. The old writeFileSync (at the caller, after these renames) without fsync let a power // cut persist the encrypted-DB rename while the key was still OS-cached-only — encrypted DB
    // on disk, key lost, library unrecoverable. Durable write here closes that window; the // caller's key write afterwards becomes an idempotent confirmation.
    require('./durable-fs').writeFileDurable(path.join(path.dirname(file), 'db.key'), key)
    fs.renameSync(file, file + '.plain-bak')
    fs.renameSync(encFile, file)
    for (const suffix of ['-wal', '-shm']) { try { fs.rmSync(file + suffix, { force: true }) } catch {} }
    log.info('[TodoDB] 已将存量明文库迁移为加密库（原文件保留 .plain-bak）')
    return true
  } catch (e) {
    log.error('[TodoDB] 明文→加密迁移失败，回退明文打开', e)
    try { db.close() } catch {}
    try { fs.rmSync(encFile, { force: true }) } catch {}
    // 两步 rename 中途失败的自愈:第一步(file→plain-bak)已成功而第二步(enc→file)失败时, // todos.db 缺位,init 随后的无驱动重开会让 better-sqlite3 静默新建空库——本次会话跑在空库上, // 且下次启动"无 todos.db 才恢复"的预检被跳过,旧数据永不自愈(2026-09-05 终审 P1)。把明文库放回
    try {
      if (!fs.existsSync(file) && fs.existsSync(file + '.plain-bak')) {
        fs.renameSync(file + '.plain-bak', file)
        log.warn('[TodoDB] 迁移中断:已将 .plain-bak 还原为 todos.db')
      }
    } catch (e2) { log.error('[TodoDB] plain-bak 还原失败', e2) }
    return false
  }
}

/** Test-only migration failure injection (C12, 2026-09-24): never set in production. */
let migrateFailHook = null
function __setMigrateFailHookForTests (fn) { migrateFailHook = typeof fn === 'function' ? fn : null }
/** Test-only migration-list override (C2, 2026-09-24): never set in production. */
let migrationsOverride = null
function __setMigrationsForTests (list) { migrationsOverride = Array.isArray(list) ? list : null }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS todos (
  id            TEXT PRIMARY KEY,
  userId        INTEGER,
  content       TEXT,
  description   TEXT,
  complete      INTEGER NOT NULL DEFAULT 0,
  completedAt   INTEGER NOT NULL DEFAULT 0,
  deletedAt     INTEGER NOT NULL DEFAULT 0,
  deleted       INTEGER NOT NULL DEFAULT 0,
  createdAt     INTEGER NOT NULL DEFAULT 0,
  updatedAt     INTEGER NOT NULL DEFAULT 0,
  syncTime      INTEGER NOT NULL DEFAULT 0,
  scheduledAt   INTEGER NOT NULL DEFAULT 0,
  scheduledDay  INTEGER NOT NULL DEFAULT 0,
  remindAt      INTEGER,
  reminders     TEXT,
  sort          REAL NOT NULL DEFAULT 0,
  focusMinutes  INTEGER NOT NULL DEFAULT 0,
  difficulty    INTEGER,
  recurGroupId  TEXT,
  subtasks      TEXT,
  predecessors  TEXT,
  imageUrls     TEXT,
  fileAttach    TEXT,
  categoryId    INTEGER NOT NULL DEFAULT 0,
  priority      INTEGER NOT NULL DEFAULT 0,
  deadlineTs    INTEGER NOT NULL DEFAULT 0,
  important     INTEGER NOT NULL DEFAULT 0,
  urgent        INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'add',
  version       INTEGER NOT NULL DEFAULT 0,
  tz            TEXT,
  -- Row provenance (protocol v3, 2026-09-29): the device whose write produced this row's
  -- current updatedAt. Lets the merge layer suppress same-writer stale echoes instead of
  -- minting junk conflict copies. NULL = pre-v7 legacy row (unknown author).
  syncAuthor    TEXT
);
CREATE INDEX IF NOT EXISTS idx_todos_day       ON todos (deleted, scheduledDay);
CREATE INDEX IF NOT EXISTS idx_todos_status    ON todos (status);
CREATE INDEX IF NOT EXISTS idx_todos_repeat    ON todos (recurGroupId);
CREATE INDEX IF NOT EXISTS idx_todos_category  ON todos (deleted, categoryId, scheduledDay);
CREATE INDEX IF NOT EXISTS idx_todos_complete  ON todos (deleted, complete, scheduledDay);
CREATE INDEX IF NOT EXISTS idx_todos_reminder  ON todos (remindAt);
CREATE TABLE IF NOT EXISTS categories (
  id            INTEGER PRIMARY KEY,
  userId        INTEGER,
  name          TEXT,
  color         TEXT,
  createdAt     INTEGER,
  sort          INTEGER,
  isFolder      INTEGER DEFAULT 0,
  parentId      INTEGER DEFAULT 0,
  deleted       INTEGER DEFAULT 0,
  deletedAt     INTEGER NOT NULL DEFAULT 0,
  updatedAt     INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS filters (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  name      TEXT,
  conds     TEXT,
  sort      INTEGER NOT NULL DEFAULT 0,
  createdAt INTEGER,
  deleted   INTEGER NOT NULL DEFAULT 0,
  deletedAt INTEGER NOT NULL DEFAULT 0,
  updatedAt INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS plan_chips (
  id     TEXT PRIMARY KEY,
  taskId TEXT NOT NULL,
  day    TEXT NOT NULL,
  mm     TEXT NOT NULL,
  sort   INTEGER NOT NULL DEFAULT 0,
  deleted   INTEGER NOT NULL DEFAULT 0,
  deletedAt INTEGER NOT NULL DEFAULT 0,
  updatedAt INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_plan_chips_day  ON plan_chips (day);
CREATE INDEX IF NOT EXISTS idx_plan_chips_task ON plan_chips (taskId);
CREATE TABLE IF NOT EXISTS tomato_records (
  tomatoId      TEXT PRIMARY KEY,
  endTime       INTEGER NOT NULL,
  dateKey       TEXT NOT NULL,
  focus         TEXT,
  focusTaskId   TEXT,
  focusDuration INTEGER NOT NULL DEFAULT 0,
  rest          INTEGER,
  restDuration  INTEGER,
  succeed       INTEGER NOT NULL DEFAULT 1,
  manual        INTEGER NOT NULL DEFAULT 0,
  status        TEXT,
  abandonReason TEXT,
  extra         TEXT,
  deleted       INTEGER NOT NULL DEFAULT 0,
  deletedAt     INTEGER NOT NULL DEFAULT 0,
  updatedAt     INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tomato_records_date ON tomato_records (dateKey);
-- Round-3 perf (2026-09-26): tomatoAll's 'WHERE deleted = 0 ORDER BY endTime DESC' reload scan
-- becomes an ordered index search (same row order).
CREATE INDEX IF NOT EXISTS idx_tomato_records_endtime ON tomato_records (deleted, endTime);
-- Change-capture log (P1 sync groundwork 2026-09-15): one row per successful write op, appended in
-- call() next to the ledger hook. Ring-buffered (see appendOplog); consumers read deltas via the
-- syncOplogSince op and GC coverage comes from periodic full snapshots. commitSyncBatch is the
-- sync-ack echo path and deliberately does NOT log (a real sync engine must not feed itself).
CREATE TABLE IF NOT EXISTS sync_oplog (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  entity   TEXT NOT NULL,
  entityId TEXT NOT NULL,
  ts       INTEGER NOT NULL
);
-- Sync v2 revision store (v8 twin of the migration: fresh databases get the tables from
-- SCHEMA, upgrades get them from MIGRATIONS — same dual-manifest as every other table).
-- Written only while the sync.revisions.v2 flag is on; presence is inert at v1 runtime.
CREATE TABLE IF NOT EXISTS sync_revisions (
  revisionId     TEXT PRIMARY KEY,
  entity         TEXT NOT NULL,
  entityId       TEXT NOT NULL,
  authorDeviceId TEXT NOT NULL,
  hlcPhysical    INTEGER NOT NULL,
  hlcLogical     INTEGER NOT NULL,
  parents        TEXT NOT NULL DEFAULT '[]',
  payloadHash    TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'pending',
  createdAt      INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sync_revisions_entity ON sync_revisions(entityId, hlcPhysical, hlcLogical);
CREATE INDEX IF NOT EXISTS idx_sync_revisions_hlc ON sync_revisions(hlcPhysical DESC, hlcLogical DESC);
CREATE TABLE IF NOT EXISTS sync_revision_payloads (
  revisionId TEXT PRIMARY KEY,
  payload    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sync_revision_current (
  entityId   TEXT PRIMARY KEY,
  revisionId TEXT NOT NULL
);` + syncSchema.DDL

// D4 2026-09-24: filter conds whitelist/parse live in shared/filter-core.mjs via db-filter-ops.js // (single source with cli/lib.js applyViewConds and renderer FilterView.vue)

function init (userDataPath) {
  // Re-entry policy (P2 2026-09-11): a second init while a handle is open closes the old handle cleanly first instead of throwing — rebuilding against a live handle would orphan prepared statements mid-write, and an abrupt throw broke the same-process restart idiom used across the unit tests (init without close = simulated restart). Closing first leaves no stale stmts and keeps the recovery re-init path (index.js db-fail dialog → attemptDbRecovery) working.
  if (db) { try { db.close() } catch {} db = null; stmtsClearAll() }
  try {
    initInner(userDataPath)
  } catch (e) {
    // Never leave a half-open handle behind: the reset-data flow and recovery flow both rely on unlinking/reopening after a failed init (an open handle made unlink EPERM on Windows before)
    try { if (db) db.close() } catch {}
    db = null
    stmtsClearAll()
    throw e
  }
}

function initInner (userDataPath) {
  const file = path.join(userDataPath, 'todos.db')
  fs.mkdirSync(userDataPath, { recursive: true })
  // Open in plaintext first to complete schema migration, then switch to encryption at the end (see "encryption finalization" at the end of init)
  const keyFile = path.join(userDataPath, 'db.key')
  // D18 (2026-10-02): the bare fs.readFileSync here threw on a transient Windows file lock // (EPERM/EBUSY from AV/indexer) — init failed, recovery saw an intact header and answered // 'transient' with NO backoff, and the immediate re-init failure surfaced the reset-data
  // dialog for a HEALTHY db. Bounded backoff retries inside init; still unreadable → the // coded DB_KEY_TRANSIENT_UNREADABLE error keeps the recovery path conservative (index.js // classifies it: no rename, no reset-data offer — see db-key-read.js).
  let key = null
  let hadKeyFile = false
  try {
    key = require('./db-key-read').readDbKeyWithRetry(keyFile)
    hadKeyFile = key != null
  } catch (e) {
    log.warn('[TodoDB] db.key unreadable after backoff retries — failing init as transient:', e.message)
    throw e
  }
  // 密钥内容强校验:db.key 被截断/夹带引号换行时,拼进 PRAGMA 即语法错误或注入面(三轮安全深审 H-2); // 不合规格式视为无钥/损坏,走正常恢复链而不是把垃圾送进 pragma
  if (hadKeyFile && !/^[0-9a-f]{64}$/.test(key)) {
    // sec-dbkey-prefix-logged: never log key material (the old message carried the first 8 hex // chars); length + hex-ness are enough to diagnose a truncated/garbage key file.
    log.warn('[TodoDB] db.key content invalid (expected 64 hex chars, got length=' + String(key).length + ', hex=' + /^[0-9a-fA-F]+$/.test(String(key)) + ') — continuing without key')
    key = null
    hadKeyFile = false
  }
  // C1 (P0 2026-09-24) 加密迁移崩溃中间态降级探测:migratePlainToEncrypted 的"写 db.key →
  if (hadKeyFile && fs.existsSync(file) && require('./dbRecovery.cjs').sqliteHeaderOk(file)) {
    const superseded = keyFile + '.superseded-' + new Date().toISOString().replace(/[:.]/g, '-')
    try {
      fs.renameSync(keyFile, superseded)
      log.warn('[TodoDB] 检测到"明文库+有效 db.key"迁移中间态,db.key 已降级为', path.basename(superseded), ',走明文重加密路径')
      key = null
      hadKeyFile = false
    } catch (e) {
      // 降级改名失败(被占用/AV 持有):保持旧路径——带钥打开会失败进 dbEncMismatch → 恢复链
      log.error('[TodoDB] db.key 降级改名失败,按带钥路径继续(预期解密探针失败)', e)
    }
  }
  db = new loadDriver()(file)
  if (hadKeyFile) db.pragma(`key='${key}'`)
  // Protection: explicit read probe (journal_mode does not necessarily throw on a wrong key — actual decryption happens on the first page read)
  try { db.prepare('SELECT count(*) FROM sqlite_master').get() } catch (e) {
    // Close the half-open handle before surfacing the error: the reset-data flow closes+unlinks the DB files; an open handle made unlink fail with EPERM on Windows, silently skipping the data destruction (2026-09-09)
    try { db.close() } catch {}
    db = null
    if (!hadKeyFile) throw new Error(i18nM.mt('dbEncNoKey'))
    throw new Error(i18nM.mt('dbEncMismatch', { msg: e.message }))
  }
  // Connection pragmas (ES1): synchronous/busy_timeout are per-connection state and journal_mode
  // must be re-asserted on a fresh handle — the encryption-finalization block below closes and
  // reopens the handle, and any reopen silently reverted to synchronous=FULL / busy_timeout=0
  // (write-loss window under concurrent CLI access). Reapplied after EVERY handle creation.
  const applyConnPragmas = () => {
    db.pragma('synchronous = NORMAL')
    // WAL + busy_timeout: avoids SQLITE_BUSY silently dropping writes when the desktop long-lived connection and the CLI write concurrently (a past comment claimed WAL was on when it actually was not)
    try { db.pragma('journal_mode = WAL') } catch {}
    try { db.pragma('busy_timeout = 5000') } catch {}
    // enc-pragma-wal-diagnostic-not-shipped: the try/catch above swallows pragma failures —
    // WAL/busy_timeout non-application was silent (vs ES1, commit 5cf95eba). Read both back and
    // say so loudly; a connection running with journal_mode != WAL can drop concurrent CLI writes.
    try {
      const jm = db.pragma('journal_mode', { simple: true })
      if (String(jm).toLowerCase() !== 'wal') log.error('[TodoDB] WAL mode not active (journal_mode=' + jm + ') — concurrent CLI writes may fail with SQLITE_BUSY')
    } catch { /* introspection is best-effort, never fail init over diagnostics */ }
    try {
      const bt = db.pragma('busy_timeout', { simple: true })
      if (Number(bt) !== 5000) log.error('[TodoDB] busy_timeout not applied (got ' + bt + ', expected 5000)')
    } catch { /* introspection is best-effort */ }
  }
  applyConnPragmas()

  // Fresh-install marker: table count BEFORE schema exec (afterwards our own tables exist, so the count is always > 0)
  const preSchemaTables = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n
  // Pre-release stage: no legacy-schema compatibility burden; create the current schema directly (the old v0.0 migration code was removed with the "no existing users" decision)
  db.exec(SCHEMA)

  // ===== schemaVersion single migrator: migrations run once only, no longer re-executed on every startup (probe-style column adds / unconditional UPDATEs are implicit migration debt) =====
  const getVer = () => { try { const r = db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get(); return Number(r && r.value) || 0 } catch { return 0 } }
  const setVer = v => db.prepare('INSERT INTO meta (key, value) VALUES (\'schemaVersion\', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(String(v))
  const MIGRATIONS = require('./db-migrations')(syncSchema, migrationsOverride)
  let ver = getVer()
  // C2 (P1 2026-09-24) 迁移循环设防:此前任一迁移抛错直接冒泡 → init 永久失败、整库打不开
  // (比带损启动更糟)。现在单条迁移抛错转中断:结构化日志 + 停在当前版本(schemaVersion 不推进,
  // 下次启动重试该条),库照常打开。false 返回值语义不变(中断不推进)。
  // Failed migration must abort (not `continue`): advancing would stamp the higher version so the failed migration never retries.
  for (const m of MIGRATIONS) {
    if (m.v <= ver) continue
    try {
      if (m.fn(db) === false) break
      ver = m.v
    } catch (e) {
      log.error('[TodoDB] schema 迁移 v' + m.v + ' 抛错,停于版本 ' + ver + ' 带损启动(版本不推进,下次启动重试):', e && e.message)
      break
    }
  }
  if (ver !== getVer()) setVer(ver)
  // Provenance stamp (protocol v3): load the persisted identity so local writes are authored.
  // The bootstrap re-injects it on ensureIdentity() too — this covers the process restart path
  // where the identity already exists but sync has not been enabled yet this session.
  try {
    const idr = db.prepare("SELECT value FROM settings_rows WHERE key='sync.deviceId'").get()
    if (idr && idr.value) setSyncAuthor(idr.value)
  } catch { /* settings_rows not ready: writes stay author-NULL until ensureIdentity */ }
  // PA-3: the SCHEMA/MIGRATIONS dual-manifest self-healing backstop (probe + silent ALTER of
  // missing todoToRow columns) was DELETED, not replaced by another runtime guard. A missed
  // manifest registration now fails red at CI (cli/check-schema-manifests.cjs, executed by the
  // unit suite) and, if it ever slipped through, dies loudly at the upsert prepare below —
  // schema drift must never silently ALTER itself away on the shared main/CLI startup path.
  // ===== Encryption finalization (runs after schema migration completes) =====
  // The key is stored as db.key in the same directory (the CLI opening in the same directory is automatically compatible). Threat model: prevents the single todos.db file from being read directly by sync drives/copies/forensic tools; the key lives on the same machine, so "entire userData readable" is not covered. Both fresh installs (empty DB) and existing DBs (after schema migration) reach here and uniformly switch to the encrypted state.
  if (!hadKeyFile) {
    key = crypto.randomBytes(32).toString('hex')
    if (preSchemaTables > 0) {
      const ok = migratePlainToEncrypted(userDataPath, file, key)
      // C12 (P2 2026-09-24): 迁移失败且还原后 todos.db 仍缺位(.plain-bak 缺失/还原也失败)时,
      // 下面的无参重开会让 better-sqlite3 静默新建空库——本次会话跑在空库上,且下次启动
      // "无 todos.db 才恢复"的预检被跳过,旧数据永不自愈。主动 throw 进 index.js 的恢复链。
      if (!ok && !fs.existsSync(file)) {
        db = null
        stmtsClearAll()
        throw new Error('[TodoDB] 明文→加密迁移失败且 todos.db 缺位(无 .plain-bak 可还原),转交恢复链处理')
      }
      db = new loadDriver()(file)
      // Order is critical: write db.key to disk before the pragma — if the encrypted DB is opened first and the key write fails, the DB is encrypted while the key exists only in memory and the next startup is unrecoverable
      // main-ipc-2 fsync fix (2026-09-22): writeFileDurable (tmp+fsync+rename) — writeFileSync alone
      // left the key OS-cached; a power cut after migratePlainToEncrypted's renames persisted the
      // encrypted DB without a recoverable key.
      if (ok) { require('./durable-fs').writeFileDurable(keyFile, key); db.pragma(`key='${key}'`) }
      // On migration failure keep plaintext open (functionality first); the error is already logged
    } else {
      // Fresh install: the file only ever held our just-created empty schema — no data to migrate,
      // so delete and recreate encrypted. (PRAGMA key on the already-open plaintext handle would NOT
      // encrypt existing pages → the CLI reopening with db.key reads garbage: "file is not a database")
      db.close()
      for (const f of [file, file + '-wal', file + '-shm']) { try { fs.rmSync(f, { force: true }) } catch {} }
      require('./durable-fs').writeFileDurable(keyFile, key) // main-ipc-2 fsync fix (2026-09-22), same rationale as the migration path above
      db = new loadDriver()(file)
      db.pragma(`key='${key}'`)
      db.prepare('SELECT count(*) FROM sqlite_master').get() // decrypt probe, same as open path
      db.exec(SCHEMA)
      setVer(ver) // re-stamp: the migration loop above ran on the deleted plaintext handle
    }
    log.info('[TodoDB] 数据库已启用加密')
  } else {
    db.pragma(`key='${key}'`)
  }
  // ES1: both encryption-finalization paths (plain→encrypted migration and fresh-install
  // recreate) replaced the handle above — reapply the connection pragmas on whichever
  // handle survived (idempotent on the hadKeyFile path where the handle was never swapped).
  applyConnPragmas()

  // [D13 #10] repeat-day uniqueness re-ensure (idempotent; after encryption finalization, which recreates fresh DBs from SCHEMA and drops the v9 index; skipped under the C2 test seam)
  if (!migrationsOverride) { try { require('./db-migrations').ensureRepeatDayUniqueness(db) } catch (e) { log.warn('[TodoDB] repeat-day uniqueness ensure failed (non-fatal):', e && e.message) } }


  const cols = Object.keys(todoToRow({ taskId: '' }))
  // B1 (2026-10-03) — focusMinutes accumulate-vs-replace duality. The renderer's contract
  // (store todo.js "U-1 write-once at the DB layer") treats focus minutes as MONOTONIC:
  // the only mutation that ever lowers nothing is bumpSnow's DB-side `focusMinutes = focusMinutes + ?`
  // (see stmts.bumpSnow below); writers never send a decreasing value. But a whole-row upsert
  // from a STALE cross-window snapshot (e.g. stampLocalWrite skips its own reload, so the
  // in-memory row still carries the pre-bump estimate) used to overwrite the accumulated
  // column back to the old value and sync the erasure. MAX(existing, excluded) preserves the
  // higher accumulated total: identical to `= excluded` for inserts and fresh writers, and
  // only ever rejects a DECREASE, which no legitimate writer performs. This is the class root:
  // focusMinutes is the only todos column with an accumulate-vs-replace duality (every other
  // column is last-writer-wins by design), so it gets the guard and an explicit contract
  // comment here rather than a per-call-site workaround.
  stmts.upsert = db.prepare(`INSERT INTO todos (${cols.join(', ')}) VALUES (${cols.map(c => '@' + c).join(', ')}) ON CONFLICT(id) DO UPDATE SET ${cols.filter(c => c !== 'id').map(c => c === 'focusMinutes' ? 'focusMinutes = MAX(todos.focusMinutes, excluded.focusMinutes)' : `${c} = excluded.${c}`).join(', ')}`)
  stmts.getById = db.prepare('SELECT * FROM todos WHERE id = ?')
  stmts.hardDelete = db.prepare('DELETE FROM todos WHERE id = ?')
  stmts.getMeta = db.prepare('SELECT value FROM meta WHERE key = ?')
  stmts.setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  stmts.upsertMany = db.transaction(rows => { for (const r of rows) stmts.upsert.run(r) })
  // Atomic field increment: a whole-row overwrite from a stale cross-window row loses concurrent increments (estimate from two windows in the same tick); DB-side += avoids the race
  // P1 2026-09-17: focus increments must also flip status to 'update' — the renderer's snapshot
  // filter drops rows with status='sync', so a bump on an already-synced row used to leave the
  // focus delta invisible to the cloud sync path (commitSyncBatch) forever.
  // Sync-2 (protocol v3 attribution): a focus bump is a WRITE that produces a new updatedAt —
  // it must be attributed to this device (selfSyncAuthor) like every other write path, or the
  // merge layer reads the bumped row as "unknown author" and treats every later same-writer
  // echo as divergent (junk conflict copies). NULL (identity not yet established) stays honest:
  // unknown = always-divergent = conservative, never a wrong attribution.
  stmts.bumpSnow = db.prepare("UPDATE todos SET focusMinutes = focusMinutes + @minutes, status = 'update', updatedAt = @now, syncAuthor = @author WHERE id = @taskId AND deleted = 0")
  log.info('[TodoDB] 数据库初始化完成:', file)
  return file
}

/* ---------- Query construction (mirrors queryTodos's filter parameters) ---------- */
function queryTodos ({ deleted = 0, complete = null, categoryId = null, repeatId = null,
  dayStartFrom = null, dayStartTo = null, noDate = false, keyword = null,
  important = null, urgent = null,
  orderBy = 'sort ASC, scheduledAt ASC', limit = null } = {}) {
  const where = ['deleted = @deleted']
  const p = { deleted }
  if (complete !== null) { where.push('complete = @complete'); p.complete = complete ? 1 : 0 }
  if (categoryId !== null && categoryId !== -1) { where.push('categoryId = @categoryId'); p.categoryId = categoryId }
  if (repeatId !== null) { where.push('recurGroupId = @repeatId'); p.repeatId = repeatId }
  if (important !== null) { where.push('important = @important'); p.important = important }
  if (urgent !== null) { where.push('urgent = @urgent'); p.urgent = urgent }
  if (noDate) where.push('scheduledDay = 0')
  else {
    if (dayStartFrom !== null) { where.push('scheduledDay >= @from'); p.from = dayStartFrom }
    if (dayStartTo !== null) { where.push('scheduledDay <= @to'); p.to = dayStartTo }
    if (dayStartFrom !== null || dayStartTo !== null) where.push('scheduledDay != 0')
  }
  let sql = `SELECT * FROM todos WHERE ${where.join(' AND ')}`
  // B8 (2026-10-02): --keyword used to be a raw SQL LIKE (ASCII-case-insensitive only), diverging
  // from the renderer's search (utils/search.js matchTodo: NFKC folding, whitespace-split
  // multi-term AND, subtask scope). Chosen root fix: a JS post-filter via matchTodoKeyword
  // (db-rows.js) applied to the filtered row set. NOT a DB-side fix: todoToRow stores
  // content/description verbatim (whitespace sanitization only, no NFKC), so a normalized row
  // haystack simply does not exist in SQLite and a LIKE prefilter could never be a safe superset
  // of the NFKC contract (a fullwidth row 'Ａ１' contains neither 'a1' nor 'Ａ１' when the query
  // is 'a1' and vice versa). The local CLI/db scale makes a full post-filter cheap and honest.
  const keywordTerms = matchTodoKeywordTerms(keyword)
  // orderBy is exposed via IPC; whitelist-validate to prevent SQL injection (only column name + ASC/DESC combinations allowed)
  const cols = new Set(['id', 'createdAt', 'updatedAt', 'scheduledDay', 'scheduledAt', 'completedAt', 'complete', 'remindAt', 'sort', 'priority', 'deadlineTs', 'important', 'urgent', 'categoryId', 'recurGroupId', 'status', 'content'])
  const parts = String(orderBy).split(',').map(x => x.trim().split(/\s+/))
  for (const part of parts) {
    if (!cols.has(part[0]) || (part[1] && !/^(ASC|DESC)$/i.test(part[1]))) throw new Error('queryTodos: 非法 orderBy: ' + orderBy)
  }
  sql += ` ORDER BY ${orderBy}`
  // F2: limit validated on presence (0 = explicit zero rows, negatives throw). D19-DOM1: the SQL LIMIT must not precede the JS keyword filter — window/ceiling/cap in db-rows.keywordLimitWindow.
  const win = keywordLimitWindow(keywordTerms, limit)
  if (win.sqlLimit !== null) sql += ' LIMIT ' + win.sqlLimit
  let rows = db.prepare(sql).all(p).map(rowToTodo)
  if (keywordTerms) rows = rows.filter(r => matchTodoKeyword(r, keywordTerms))
  return win.outLimit !== null ? rows.slice(0, win.outLimit) : rows
}

// F2 2026-09-15:SQLite TEXT PRIMARY KEY 不隐含 NOT NULL — taskId:null/undefined/'' 一路落到这里
// 会写成 NULL-id 幽灵行(全部幽灵行互相冲突覆盖,还可能挤掉正常 id='null' 的数据)。fail-fast 优于静默。
function assertHasTaskId (t) {
  if (!t || t.taskId == null || t.taskId === '') {
    throw new Error('[TodoDB] upsert: taskId is required, refusing to write a NULL-id ghost row (got ' + JSON.stringify(t && t.taskId) + ')')
  }
}

const makeBulkOps = require('./db-bulk-ops')(() => db, () => OPS)
// Per-task meta-key GC helpers (snowDedup / planChipsSnapshot) moved to db-meta-gc.cjs verbatim:
const { deleteSnowDedupKeysFor, deleteChipsSnapshotKeysFor, deleteEstimateKeysFor } = require('./db-meta-gc.cjs')(() => db)
// Category / filter / stats / plan-chip / tomato-ledger op groups extracted verbatim to their own
// modules (structure-size ratchet). Thin delegates in OPS below keep every db.call surface,
// return shape and the internal _dayBounds/_recToRow/_rowToRec seams unchanged; `db` is read at
// call time so the delegates always hit the live handle.
const categoryOps = require('./db-category-ops')
const filterOps = require('./db-filter-ops')
const statsOps = require('./db-stats-ops')
const planOps = require('./db-plan-ops')
const tomatoOps = require('./db-tomato-ops')
// B9 purge chip-capture scratch (single-process synchronous db.call → oplog append): the purge
// ops physically DELETE plan_chips inside their transaction, so the oplog expansion (which runs
// POST-op and can only re-query surviving rows) cannot recover the doomed chip ids. The ops
// stash them here; db-oplog's purgeRecycleBin/purgeSeedTodos case expands them into per-chip
// tombstone pointers so a peer holding the chips live learns they died instead of LWW-resurrecting
// ghost chips of purged todos. Overwritten by every purge call; empty when no purge ran.
let purgeChipsScratch = []
const OPS = {
  upsert: t => { assertHasTaskId(t); stmts.upsert.run(todoToRow(t)); return true },
  upsertMany: list => { if (!Array.isArray(list)) throw new Error('[TodoDB] upsertMany: list must be an array, got ' + typeof list); list.forEach(assertHasTaskId); stmts.upsertMany(list.map(todoToRow)); return true },
  // Atomic sync-commit (W3 2026-09-12): row upserts + todosVersion cursor advance in ONE transaction. Why atomic: writing rows with status='sync' non-atomically and crashing between the upserts and the setMeta would leave rows marked 'sync' in the DB while todosVersion stayed behind — the dirty-row filter (status !== 'sync') would then skip them forever and the cursor would never advance again =
  // silent permanent non-convergence. Inside one transaction the crash outcome is all-or-nothing: either the whole batch is re-sent on restart (old dirty semantics) or fully acknowledged (new semantics) — no intermediate state. Rows arrive in store shape; the DB layer forces status='sync' so a compromised renderer cannot write arbitrary status values through this op.
  commitSyncBatch: ({ rows, version }) => {
    // The cursor is the convergence lynchpin — a non-numeric value (String(undefined) etc.) would poison state.version with NaN on the next boot's parseInt. Fail closed at the DB layer.
    const v = Number(version)
    if (!Number.isFinite(v) || v < 0) throw new Error('[TodoDB] commitSyncBatch: invalid version ' + String(version))
    if (!Array.isArray(rows)) {
      // fail-closed (round-7 audit P0): rows=null slipping through would advance the cursor while
      // writing zero rows — dirty rows after it would never be re-sent (silent non-convergence)
      throw new Error('[TodoDB] commitSyncBatch: rows must be an array, got ' + typeof rows)
    }
    // Version monotonic fence (round-8 audit P1→P0 fix): a stale retry batch (lower v) must not roll back
    // the cursor or re-ack rows that a newer batch already confirmed — otherwise edits made between
    // the two attempts get frozen as stale 'sync' content (B3 P1 scenario). Uses .get() (SELECT
    // returns {value} shape) — the original .run() returned a write-result object whose Number() was
    // NaN → || 0 → cur was always 0 and the fence was dead code (Z2 probe confirmed).
    const curRow = stmts.getMeta.get('todosVersion')
    const cur = Number((curRow && curRow.value) || 0)
    if (v < cur) throw new Error('[TodoDB] commitSyncBatch: version ' + v + ' < current todosVersion ' + cur + ' — stale batch rejected')
    const tr = db.transaction(list => {
      for (const t of list) { assertHasTaskId(t); stmts.upsert.run(todoToRow({ ...t, status: 'sync', version: v })) }
      stmts.setMeta.run('todosVersion', String(v))
    })
    tr(rows)
    return true
  },
  bumpSnow: ({ taskId, minutes, dedupKey } = {}) => {
    // Server-side clamping: arbitrary/negative values from the renderer (including the float window) must not tamper with the focus ledger (a single focus session capped at 600 minutes)
    const m = Math.max(0, Math.min(LIMITS.FOCUS_MAX_MINUTES, Math.floor(Number(minutes) || 0)))
    // P1 2026-09-20 idempotency contract: the renderer replays bumpSnow on an AMBIGUOUS failure
    // (timeout / IPC drop where the write may or may not have landed). Without a dedup fence the
    // replay re-runs the blind `+=` and double-credits the focus ledger. Optional `dedupKey`
    // (string, e.g. the focus session id) installs a once-guard under the meta key
    // `snowDedup:<taskId>:<dedupKey>`: the check + increment + stamp run in ONE transaction, so
    // two concurrent replays cannot both pass the check. The first call credits and stamps; any
    // later call with the same key returns { ok:true, minutes:0, deduped:true } without touching
    // the row. Each key is stamped with its creation time; once the meta table holds more than
    // SNOW_DEDUP_CAP keys, entries older than SNOW_DEDUP_MAX_AGE_MS are pruned — replay protection
    // only needs recent keys (a replay lands within seconds of the ambiguous failure), while the
    // one-row-per-focus-session accumulation used to grow the meta table unboundedly. Callers that    // send no dedupKey keep the legacy non-idempotent behavior (backward compatible).
    if (dedupKey != null && dedupKey !== '') {
      const key = `snowDedup:${taskId}:${dedupKey}`
      const tr = db.transaction(() => {
        if (stmts.getMeta.get(key)) return { ok: true, minutes: 0, deduped: true }
        const r0 = stmts.bumpSnow.run({ taskId, minutes: m, now: Date.now(), author: selfSyncAuthor() })
        if (r0.changes === 0) {
          const row = stmts.getById.get(taskId)
          return { ok: false, reason: row ? 'deleted' : 'missing' }
        }
        stmts.setMeta.run(key, String(Date.now()))
        return { ok: true, minutes: m }
      })
      const out = tr()
      // Prune outside the bump transaction: the COUNT runs on every dedup'd bump but the DELETE
      // only fires past the cap. Legacy keys stamped '1' cast to epoch 0 and age out immediately.
      try {
        const n = db.prepare("SELECT COUNT(*) n FROM meta WHERE key LIKE 'snowDedup:%'").get().n
        if (n > SNOW_DEDUP_CAP) {
          db.prepare("DELETE FROM meta WHERE key LIKE 'snowDedup:%' AND CAST(value AS INTEGER) < ?")
            .run(Date.now() - SNOW_DEDUP_MAX_AGE_MS)
        }
      } catch { /* pruning is best-effort and must never fail the bump */ }
      return out
    }
    const r = stmts.bumpSnow.run({ taskId, minutes: m, now: Date.now(), author: selfSyncAuthor() })
    // Structured result: changes=0 used to collapse "missing" and "soft-deleted" into a bare false, so callers silently dropped focus credit; name the reason
    if (r.changes === 0) {
      const row = stmts.getById.get(taskId)
      return { ok: false, reason: row ? 'deleted' : 'missing' }
    }
    return { ok: true, minutes: m }
  },
  getById: id => rowToTodo(stmts.getById.get(id)),
  getAll: ({ deleted = null } = {}) => {
    if (deleted === null || deleted === undefined) return db.prepare('SELECT * FROM todos').all().map(rowToTodo)
    return db.prepare('SELECT * FROM todos WHERE deleted = ?').all(deleted ? 1 : 0).map(rowToTodo)
  },
  queryTodos,
  // 两表删除包事务:两语句间崩溃会留孤儿 chips(2026-09-05 终审 P1,与 hardDeleteMany 对齐)
  // Sync-5 result-awareness — both delegates live in db-bulk-ops.js (size-ratchet move): they
  // return the ids PHYSICALLY deleted (row-granular contract, same as purgeRecycleBin), so an
  // absent id no longer returns true nor mints a phantom tombstone oplog pointer.
  hardDelete: (...a) => makeBulkOps.hardDelete(...a),
  hardDeleteMany: (...a) => makeBulkOps.hardDeleteMany(...a),
  getMeta: k => { const r = stmts.getMeta.get(k); return r ? r.value : null },
  // Accepts both argument forms: (k, v) or [k, v] (the renderer's dbCall('setMeta', [k, v]) is passed through as a single call parameter)
  setMeta: (k, v) => { if (Array.isArray(k)) { v = k[1]; k = k[0] } stmts.setMeta.run(k, String(v)); return true },
  // Batched bulk meta write (single transaction): N standalone setMeta calls each pay a commit
  // fsync (~7ms here), which put a 2000-row test backlog past the 2min CI ceiling. Callers pass
  // [[k, v], ...]; NOT renderer-whitelisted (backfill/tests/maintenance only).
  setMetaMany: rows => { const tr = db.transaction(list => { for (const [k, v] of list) stmts.setMeta.run(String(k), String(v)) }); tr(rows); return rows.length },
  listMetaKeys: () => db.prepare('SELECT key FROM meta').all().map(r => r.key), // main-internal only (startup meta GC), NOT renderer-whitelisted
  // Monotonic sequence number for CLI tomato commands: UPDATE...RETURNING 单语句原子(两语句版在双 CLI 并发时读回同值→重号→App seq 去重丢命令,2026-09-04 深审 P1)
  nextCliTomatoSeq: () => Number(db.prepare("INSERT INTO meta (key, value) VALUES ('cliTomatoSeq', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) RETURNING value").get().value),
  // CLI sync command channel (feat/cli-sync-pair): same atomic single-statement increment as
  // nextCliTomatoSeq — two concurrent CLI processes must never mint the same seq or the App's
  // seq dedup would silently drop the second command.
  nextCliSyncSeq: () => Number(db.prepare("INSERT INTO meta (key, value) VALUES ('cliSyncSeq', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) RETURNING value").get().value),
  // D13 finding 9: result-aware like hardDelete/settingsRowDelete (D12 Sync-5/6) — deleting an
  // ABSENT key used to return true unconditionally and mint a phantom ('meta', key) tombstone
  // delta in the oplog (peers then churned on a key that never changed).
  deleteMeta: k => { const r = db.prepare('DELETE FROM meta WHERE key = ?').run(k); return r.changes > 0 },
  // P3 2026-09-17: recycle-bin rows are logically gone — counting them made the onboarding
  // "is this a fresh library" check false-positive on a library whose only rows were deleted ones.
  countAll: () => db.prepare('SELECT COUNT(*) n FROM todos WHERE deleted = 0').get().n,
  purgeRecycleBin: () => {
    // Cascade: plan chips belonging to recycle-bin rows are removed too (otherwise the timeline shows ghost chips after emptying the recycle bin, with no way to remove them)
    // 两表删除包事务(2026-09-05 终审 P1):非原子路径在两语句间崩溃会留幽灵行
    // Returns purged ids: the oplog expands them into per-id tombstone pointers (replaces the ghost-prone ('todo','*gc*') marker).
    let ids = []
    const tr = db.transaction(() => {
      ids = db.prepare('SELECT id FROM todos WHERE deleted = 1').all().map(r => r.id)
      // B9 (2026-09-26): capture the doomed chip ids BEFORE the physical delete — the oplog
      // expansion runs post-op when the rows are gone, and without these pointers a peer that
      // still holds the chips live LWW-resurrects them as ghost chips of purged todos.
      purgeChipsScratch = db.prepare('SELECT id FROM plan_chips WHERE taskId IN (SELECT id FROM todos WHERE deleted = 1)').all().map(r => r.id)
      db.prepare('DELETE FROM plan_chips WHERE taskId IN (SELECT id FROM todos WHERE deleted = 1)').run()
      deleteSnowDedupKeysFor(ids) // main-ipc-3 (2026-09-22): the rows die here — their focus-session dedup fences must not outlive them
      deleteChipsSnapshotKeysFor(ids) // snapshot meta dies with the rows (same lifecycle rule)
      deleteEstimateKeysFor(ids); makeBulkOps.pruneFiredReminderKeysFor(ids) // D10 + D22 (2026-10-02): estimate meta AND the fired-reminder watermark die with the rows (helper in db-bulk-ops.js)
      db.prepare('DELETE FROM todos WHERE deleted = 1').run()
    }); tr(); return ids
  },
  // Cascade plan_chips too (same contract as hardDelete/purgeRecycleBin, transactional); returns purged ids for per-id sync tombstones.
  purgeSeedTodos: () => {
    let ids = []
    const tr = db.transaction(() => {
      ids = db.prepare("SELECT id FROM todos WHERE substr(id, 1, 5) = 'seed_'").all().map(r => r.id)
      purgeChipsScratch = db.prepare("SELECT id FROM plan_chips WHERE taskId IN (SELECT id FROM todos WHERE substr(id, 1, 5) = 'seed_')").all().map(r => r.id) // B9: see purgeRecycleBin
      db.prepare("DELETE FROM plan_chips WHERE taskId IN (SELECT id FROM todos WHERE substr(id, 1, 5) = 'seed_')").run()
      deleteSnowDedupKeysFor(ids) // main-ipc-3 (2026-09-22): same lifecycle rule as purgeRecycleBin
      deleteChipsSnapshotKeysFor(ids) // same lifecycle rule
      deleteEstimateKeysFor(ids); makeBulkOps.pruneFiredReminderKeysFor(ids) // D10 + D22 (2026-10-02): same lifecycle rule
      db.prepare("DELETE FROM todos WHERE substr(id, 1, 5) = 'seed_'").run()
    }); tr(); return ids
  },
  // B9: oplog-side access to the LAST purge's doomed chip ids (see purgeChipsScratch). Read
  // inside oplogEntriesFor immediately after a purge op — the same synchronous call().
  getPurgeChipsScratch: () => purgeChipsScratch,
  countSeedTodos: () => db.prepare("SELECT COUNT(*) n FROM todos WHERE substr(id, 1, 5) = 'seed_'").get().n,
  // Category ops extracted verbatim to db-category-ops.js (structure-size ratchet)
  upsertCategory: (...a) => categoryOps.upsertCategory(db, ...a),
  getAllCategories: (...a) => categoryOps.getAllCategories(db, ...a),
  // Saved-filter ops extracted verbatim to db-filter-ops.js (structure-size ratchet)
  filterList: (...a) => filterOps.filterList(db, ...a),
  filterUpsert: (...a) => filterOps.filterUpsert(db, ...a),
  filterDelete: (...a) => filterOps.filterDelete(db, ...a),
  // Stats/day-bounds ops extracted verbatim to db-stats-ops.js (structure-size ratchet; the
  // _dayBounds delegate preserves the internal op surface used by CLI/tests)
  _dayBounds: (...a) => statsOps._dayBounds(...a),
  statsByDay: (...a) => statsOps.statsByDay(db, ...a),
  tomatoByDay: (...a) => statsOps.tomatoByDay(db, ...a),
  // Plan-chip ops extracted verbatim to db-plan-ops.js (structure-size ratchet)
  planAll: (...a) => planOps.planAll(db, ...a),
  planAddMany: (...a) => planOps.planAddMany(db, ...a),
  planUpdateChip: (...a) => planOps.planUpdateChip(db, ...a),
  planRemoveIds: (...a) => planOps.planRemoveIds(db, ...a),
  planMoveTask: (...a) => planOps.planMoveTask(db, ...a),
  planDeleteTask: (...a) => planOps.planDeleteTask(db, ...a),
  planDeleteTaskDay: (...a) => planOps.planDeleteTaskDay(db, ...a),
  planPrune: (...a) => planOps.planPrune(db, ...a),
  // Tomato focus-ledger ops extracted verbatim to db-tomato-ops.js (structure-size ratchet; the
  // _REC_COLS/_recToRow/_rowToRec delegates preserve the internal row-shaping seams)
  _REC_COLS: tomatoOps._REC_COLS,
  _recToRow: (...a) => tomatoOps._recToRow(...a),
  _rowToRec: (...a) => tomatoOps._rowToRec(...a),
  tomatoAll: (...a) => tomatoOps.tomatoAll(db, ...a),
  tomatoGetById: (...a) => tomatoOps.tomatoGetById(db, ...a),
  tomatoTombstones: (...a) => tomatoOps.tomatoTombstones(db, ...a),
  tomatoAppendMany: (...a) => tomatoOps.tomatoAppendMany(db, ...a),
  tomatoUpdateById: (...a) => tomatoOps.tomatoUpdateById(db, ...a),
  tomatoRemoveByIds: (...a) => tomatoOps.tomatoRemoveByIds(db, ...a),
  tomatoMigrateFromMeta: (...a) => tomatoOps.tomatoMigrateFromMeta(db, stmts, ...a),
  // Delta read for the (future) sync engine and tests: oplog rows strictly after sinceSeq, oldest first.
  // limit guards the first pull on a large existing log; callers page through via the returned max seq.
  // Main-process/CLI-only op by design: the future sync engine lives in the main process and reads the
  // db layer directly. Deliberately NOT in the renderer IPC whitelist or contracts.d.ts DbCallOp —
  // adding a renderer caller without whitelisting it would be the filterList/bumpSnow silent-outage shape.
  settingsRowsAll: () => syncSchema.rowsAll(), // settings/habits row table (P2, docs/sync §4.2)
  // Round-3 perf (2026-09-26): per-tick settings-change watermark for the external-write watcher —
  // same number rowsAll() would reduce to max(updatedAt), one aggregate instead of a full scan
  // with per-row JSON.parse. Main-internal consumer (index.js forwardTomatoCmd), like rowsAll.
  settingsRowsMaxUpdated: () => syncSchema.maxUpdated(),
  settingsRowPut: p => syncSchema.rowPut(p),
  settingsRowPutMany: p => syncSchema.rowPutMany(p),
  settingsRowDelete: p => syncSchema.rowDelete(p),
  upsertCategoryMany: makeBulkOps.upsertCategoryMany,
  filterUpsertMany: makeBulkOps.filterUpsertMany,
  categoriesAllRows: makeBulkOps.categoriesAllRows, planTombstones: makeBulkOps.planTombstones, filterTombstones: makeBulkOps.filterTombstones, // sync-side raw reads (M1/M3) — main-internal, NOT renderer-callable
syncOplogSince: ({ sinceSeq = 0, limit = 2000 } = {}) => db.prepare('SELECT seq, entity, entityId, ts FROM sync_oplog WHERE seq > ? ORDER BY seq ASC LIMIT ?').all(Number(sinceSeq) || 0, Math.max(1, oplogKeepLimit(Math.floor(Number(limit) || 2000)))),
  getMetaMany: p => require('./db-sync-ops').dispatch('getMetaMany', p), // CONTRACT (F-UI): batch meta read; impl db-sync-ops.js
  // P3a LAN sync ops (2026-09-16): delegates into db-sync-ops.js (gate: ops must exist here; impl lives in lan-sync-bootstrap.js)
  syncGetSettings: p => require('./db-sync-ops').dispatch('syncGetSettings', p),
  syncSetEnabled: p => require('./db-sync-ops').dispatch('syncSetEnabled', p),
  syncGetStatus: p => require('./db-sync-ops').dispatch('syncGetStatus', p),
  syncGetPairingCode: p => require('./db-sync-ops').dispatch('syncGetPairingCode', p),
  syncSetName: p => require('./db-sync-ops').dispatch('syncSetName', p),
  syncPairWithCode: p => require('./db-sync-ops').dispatch('syncPairWithCode', p),
  syncPairRespond: p => require('./db-sync-ops').dispatch('syncPairRespond', p),
  syncPairRequest: p => require('./db-sync-ops').dispatch('syncPairRequest', p),
  syncUnpairPeer: p => require('./db-sync-ops').dispatch('syncUnpairPeer', p),
  syncSetPeerAlias: p => require('./db-sync-ops').dispatch('syncSetPeerAlias', p), // Round-2 P1: machine-local per-peer display alias
  // X4 (2026-09-20): meta LWW conflict backup recovery (impl lan-sync-bootstrap via sync-conflict-backups.js)
  syncConflictBackupsList: p => require('./db-sync-ops').dispatch('syncConflictBackupsList', p),
  syncConflictBackupRestore: p => require('./db-sync-ops').dispatch('syncConflictBackupRestore', p),
  // One-time bootstrap: rows created before the oplog existed (any user enabling sync on an existing
  // database) have no change-capture pointers and would never propagate. Idempotent via sync.seedDone; NOT renderer-callable.
  seedSyncOplog: p => require('./db-sync-ops').dispatch('seedSyncOplog', p),
  // Main-internal: bare oplog pointer backfill for legacy rows (impl db-oplog.js — D13 size
  // ratchet; the seed passes per-row real ages, see db-oplog.appendOplogPointers).
  appendOplogPointers: rows => oplog.appendOplogPointers(rows),
}

/** 账本变更钩子:任何进程(App 主进程 IPC / CLI 直连)经 call() 落账本写 op 后触发。
 *  App 侧用它向所有窗口广播 tomato-records-changed;CLI 进程内无窗口,钩子天然不挂。
 *  放在 db 层而非 IPC handler 是根修关键:CLI 直写不经过 IPC,钩子挂 handler 上会漏广播(2026-09-04 实锤)。 */
const LEDGER_WRITE_OPS = require('./db-write-ops.cjs').LEDGER_WRITE_OPS
let ledgerChangedHook = null
function setLedgerChangedHook (fn) { ledgerChangedHook = typeof fn === 'function' ? fn : null }
// Echo suppression (2026-09-11 audit P2): renderer-originated ledger writes must not echo back to the
// writing window through the hook broadcast (recordsReload clobber, same shape as the todos echo).
// The IPC handler wraps the call with this and re-broadcasts with sender exclusion instead.
let ledgerHookSuppressCount = 0
function suppressLedgerHook () {
  ledgerHookSuppressCount++
  let done = false
  return () => { if (!done) { done = true; ledgerHookSuppressCount-- } }
}

function call (op, params) {
  const fn = OPS[op]
  if (!fn) throw new Error('[TodoDB] 未知操作: ' + op)
  const r = fn(params)
  if (ledgerChangedHook && !ledgerHookSuppressCount && LEDGER_WRITE_OPS.has(op)) { try { ledgerChangedHook(op) } catch { /* 广播失败不阻断落库 */ } }
  if (op !== 'commitSyncBatch' && WRITE_OPS.has(op)) {
    // Round-3 stability (2026-09-26): oplogEntriesFor runs real SQL for a few ops (planMoveTask/
    // planDeleteTask/planDeleteTaskDay) outside appendOplog's try/catch — a throw there (closed or
    // re-init handle) rejected the caller's invoke for an ALREADY-COMMITTED write, violating
    // appendOplog's contract; the delta row was lost either way. Now success + warn, happy path identical.
    // r4 fix (2026-09-28): when oplogEntriesFor itself throws, route through the SAME reporter
    // appendOplog uses internally — the failure counter (oplogStats), the onAppendFailure hook
    // (→ 'oplog-append-failed' syncEvent) and the warn log fire for BOTH entry points now.
    let entries = null
    try { entries = oplog.oplogEntriesFor(op, params, r) } catch (e) { oplog.reportAppendFailure(e && e.message) }
    // compute entries ONCE and share: the old shape evaluated oplogEntriesFor twice per
    // write (its planMove/planDelete arms run real SQL) even with the v2 flag off
    if (entries) { try { oplog.appendOplog(entries) } catch (e) { oplog.reportAppendFailure(e && e.message) } }
    // Sync v2 revision recording (flag-gated inside record()): same never-fail-a-committed-
    // write contract as the oplog line above; a throw is warn-only, v1 sync unaffected.
    if (entries) { try { revisions.record(entries) } catch (e) { log.warn('[db-revisions] record failed: ' + (e && e.message)) } }
  }
  return r
}

// Sync v2 introspection + flag ops (machine-local: deliberately NOT in WRITE_OPS,
// so flipping the flag is never oplog-captured or synced to peers).
OPS.revisionsList = p => revisions.list(p && p.entityId, p && p.limit)
OPS.revisionsFlag = p => {
  const d = db
  if (!d || !d.open) throw new Error('db closed')
  const on = !!(p && p.on)
  d.prepare('INSERT INTO settings_rows (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(revisions.FLAG_KEY, on ? '1' : '0')
  return { on }
}
OPS.revisionsFlagState = () => ({ on: revisions.flagEnabled(db) })

const { WRITE_OPS, isWriteOp } = require('./db-write-ops.cjs')
syncSchema.registerOps(OPS, WRITE_OPS, oplog)

/** Explicitly close the handle (for tests switching directories / graceful process exit); silent when uninitialized or already closed.
 *  P2 2026-09-11: close() used to leave the module var set, so isOpen() kept returning true after close
 *  and nothing distinguished "closed" from "open". Null it (and drop the dead prepared statements) so
 *  isOpen() is truthful and a guarded re-init becomes possible. */
function close () {
  try { if (db) db.close() } catch {}
  db = null
  stmtsClearAll()
}

// Initialized probe: within the same process (the main process's CSV import), reuse the existing connection; a second init rebuilding the handle on the same file is forbidden
function isOpen () { return !!db }

module.exports = { init, call, queryTodos, normalizeContent, isWriteOp, isOpen, close, setLedgerChangedHook, suppressLedgerHook, LEDGER_WRITE_OPS, WRITE_OPS, SCHEMA, __setMigrateFailHookForTests, __setMigrationsForTests, __revisionsForTests: revisions, __connPragmasForTests: () => (db && db.open ? { journalMode: db.pragma('journal_mode', { simple: true }), synchronous: db.pragma('synchronous', { simple: true }), busyTimeout: db.pragma('busy_timeout', { simple: true }) } : null), __payloadCountForTests: () => db.prepare('SELECT COUNT(*) n FROM sync_revision_payloads').get().n, __currentRevisionIdForTests: entityId => { const r = db.prepare('SELECT revisionId FROM sync_revision_current WHERE entityId = ?').get(entityId); return r && r.revisionId } }
