/**
 * Database layer — independently implemented local task-store schema
 * (todos.db / WAL / two tables todos + meta / prepared statements under the same names)
 */
const path = require('path')
const i18nM = require('./i18n')
const fs = require('fs')
const crypto = require('crypto')
const LIMITS = require('../../shared/limits.mjs') // focus-duration clamp constants (single source, audit item 4); require(esm) — Node >= 22.12
const { normalizeContent, rowToTodo, rowToCategory, todoToRow } = require('./db-rows')
const dayjs = require('dayjs')
// electron-log only exists inside the packaged App; the standalone CLI (extraResources bundle) has no
// node_modules/electron-log, so fall back to a no-op logger instead of crashing at require time
let log
try { log = require('electron-log') } catch { log = { info () {}, warn () {}, error () {} } }
const oplog = require('./db-oplog')({ getDb: () => db, log }), syncSchema = require('./db-sync-schema')({ getDb: () => db, log })

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
    // ATTACH 的 KEY 是 SQL 字面量(参数化不支持),必须双写单引号——加密 key 是唯一触碰 SQL 字符串的敏感值
    const keyLiteral = String(key).replace(/'/g, "''")
    db.exec(`ATTACH DATABASE '${encFile.replace(/'/g, "''")}' AS enc KEY '${keyLiteral}'`)
    const encSchema = SCHEMA.replace(/CREATE TABLE IF NOT EXISTS /g, 'CREATE TABLE IF NOT EXISTS enc.')
      .replace(/CREATE INDEX IF NOT EXISTS /g, 'CREATE INDEX IF NOT EXISTS enc.')
    db.exec(encSchema)
    // 表清单动态枚举,禁手工维护:2026-09-04 深审实锤硬编码四表漏了 plan_chips/tomato_records,行表化用户的账本会在迁移中被清空(P0)
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name)
    for (const table of tables) {
      // Root fix (2026-09-19, maint/d4): `INSERT INTO enc.t SELECT * FROM main.t` copies BY POSITION.
      // Legacy DBs got important/urgent/reminders/predecessors appended via ALTER TABLE in positions
      // that differ from the current SCHEMA string order — a positional copy silently shifted those
      // values into the wrong columns on the user's first encrypted launch (per-column corruption of
      // every pre-v2 row). Build an explicit shared column list from PRAGMA table_info of BOTH sides
      // and copy by NAME; column order no longer matters.
      const qt = '"' + String(table).replace(/"/g, '""') + '"'
      // Column names via LIMIT-0 statements' .columns() (schema-qualified PRAGMA table_info isn't
      // accepted by this driver build's parser)
      const mainCols = db.prepare('SELECT * FROM main.' + qt + ' LIMIT 0').columns().map(c => c.name)
      const encCols = new Set(db.prepare('SELECT * FROM enc.' + qt + ' LIMIT 0').columns().map(c => c.name))
      const shared = mainCols.filter(c => encCols.has(c)).map(c => '"' + c.replace(/"/g, '""') + '"')
      if (!shared.length) throw new Error('migration: table "' + table + '" has no columns shared with the current schema')
      db.exec('INSERT INTO enc.' + qt + ' (' + shared.join(', ') + ') SELECT ' + shared.join(', ') + ' FROM main.' + qt)
    }
    db.exec('DETACH DATABASE enc')
    // Explicit wal_checkpoint(TRUNCATE) before closing: ensure the plaintext WAL tail writes have landed in the main file before the WAL can be safely deleted (otherwise .plain-bak may miss tail data)
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
    db.close()
    fs.renameSync(file, file + '.plain-bak')
    fs.renameSync(encFile, file)
    for (const suffix of ['-wal', '-shm']) { try { fs.rmSync(file + suffix, { force: true }) } catch {} }
    log.info('[TodoDB] 已将存量明文库迁移为加密库（原文件保留 .plain-bak）')
    return true
  } catch (e) {
    log.error('[TodoDB] 明文→加密迁移失败，回退明文打开', e)
    try { db.close() } catch {}
    try { fs.rmSync(encFile, { force: true }) } catch {}
    // 两步 rename 中途失败的自愈:第一步(file→plain-bak)已成功而第二步(enc→file)失败时,
    // todos.db 缺位,init 随后的无驱动重开会让 better-sqlite3 静默新建空库——本次会话跑在空库上,
    // 且下次启动"无 todos.db 才恢复"的预检被跳过,旧数据永不自愈(2026-09-05 终审 P1)。把明文库放回
    try {
      if (!fs.existsSync(file) && fs.existsSync(file + '.plain-bak')) {
        fs.renameSync(file + '.plain-bak', file)
        log.warn('[TodoDB] 迁移中断:已将 .plain-bak 还原为 todos.db')
      }
    } catch (e2) { log.error('[TodoDB] plain-bak 还原失败', e2) }
    return false
  }
}

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
  tz            TEXT
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
-- Change-capture log (P1 sync groundwork 2026-09-15): one row per successful write op, appended in
-- call() next to the ledger hook. Ring-buffered (see appendOplog); consumers read deltas via the
-- syncOplogSince op and GC coverage comes from periodic full snapshots. commitSyncBatch is the
-- sync-ack echo path and deliberately does NOT log (a real sync engine must not feed itself).
CREATE TABLE IF NOT EXISTS sync_oplog (
  seq      INTEGER PRIMARY KEY AUTOINCREMENT,
  entity   TEXT NOT NULL,
  entityId TEXT NOT NULL,
  ts       INTEGER NOT NULL
);` + syncSchema.DDL

const FILTER_DATE_MODES = new Set(['all', 'today', 'week', 'overdue', 'none'])
/** Filter-condition normalization: whitelist validation for dateMode/catId/priority, falling back on invalid values (an unknown dateMode makes filtering silently degrade to "all") */
function normConds (c) {
  const v = c && typeof c === 'object' ? c : {}
  const intOf = x => (Number.isFinite(x) && Number.isInteger(x) ? x : -1)
  return {
    catId: intOf(v.catId),
    priority: intOf(v.priority),
    dateMode: FILTER_DATE_MODES.has(v.dateMode) ? v.dateMode : 'all'
  }
}

/** Filter-condition JSON parsing (non-objects become empty conditions) */
function parseConds (s) {
  try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? normConds(v) : normConds(null) } catch { return normConds(null) }
}

function init (userDataPath) {
  // Re-entry policy (P2 2026-09-11): a second init while a handle is open closes the old handle cleanly first instead of throwing — rebuilding against a live handle would orphan prepared statements mid-write, and an abrupt throw broke the same-process restart idiom used across the unit tests (init without close = simulated restart). Closing first leaves no stale stmts and keeps the recovery re-init path (index.js db-fail dialog → attemptDbRecovery) working.
  if (db) { try { db.close() } catch {} db = null; stmtsClearAll() }
  try {
    initInner(userDataPath)
  } catch (e) {
    // Never leave a half-open handle behind: the reset-data flow and recovery flow both rely on
    // unlinking/reopening after a failed init (an open handle made unlink EPERM on Windows before)
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
  let hadKeyFile = fs.existsSync(keyFile)
  let key = hadKeyFile ? fs.readFileSync(keyFile, 'utf8').trim() : null
  // 密钥内容强校验:db.key 被截断/夹带引号换行时,拼进 PRAGMA 即语法错误或注入面(三轮安全深审 H-2);
  // 不合规格式视为无钥/损坏,走正常恢复链而不是把垃圾送进 pragma
  if (hadKeyFile && !/^[0-9a-f]{64}$/.test(key)) {
    log.warn('[TodoDB] db.key 内容非 64 位 hex(可能损坏),按无钥路径处理:', JSON.stringify(String(key).slice(0, 8)))
    key = null
    hadKeyFile = false
  }
  db = new loadDriver()(file)
  if (hadKeyFile) db.pragma(`key='${key}'`)
  // Protection: explicit read probe (journal_mode does not necessarily throw on a wrong key — actual decryption happens on the first page read)
  try { db.prepare('SELECT count(*) FROM sqlite_master').get() } catch (e) {
    // Close the half-open handle before surfacing the error: the reset-data flow closes+unlinks the DB files
    // and an open handle made unlink fail with EPERM on Windows, silently skipping the data destruction (2026-09-09)
    try { db.close() } catch {}
    db = null
    if (!hadKeyFile) throw new Error(i18nM.mt('dbEncNoKey'))
    throw new Error(i18nM.mt('dbEncMismatch', { msg: e.message }))
  }
  db.pragma('synchronous = NORMAL')
  // WAL + busy_timeout: avoids SQLITE_BUSY silently dropping writes when the desktop long-lived connection and the CLI write concurrently (a past comment claimed WAL was on when it actually was not)
  try { db.pragma('journal_mode = WAL') } catch {}
  try { db.pragma('busy_timeout = 5000') } catch {}

  // Fresh-install marker: table count BEFORE schema exec (afterwards our own tables exist, so the count is always > 0)
  const preSchemaTables = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='table'").get().n
  // Pre-release stage: no legacy-schema compatibility burden; create the current schema directly (the old v0.0 migration code was removed with the "no existing users" decision)
  db.exec(SCHEMA)

  // ===== schemaVersion single migrator: migrations run once only, no longer re-executed on every startup (probe-style column adds / unconditional UPDATEs are implicit migration debt) =====
  const getVer = () => { try { const r = db.prepare("SELECT value FROM meta WHERE key='schemaVersion'").get(); return Number(r && r.value) || 0 } catch { return 0 } }
  const setVer = v => db.prepare('INSERT INTO meta (key, value) VALUES (\'schemaVersion\', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(String(v))
  const MIGRATIONS = [
    { v: 1, fn: d => { d.exec('UPDATE todos SET remindAt = 0 WHERE remindAt IS NULL') } },
    { v: 2, fn: d => {
      // data-layer important/urgent for the Eisenhower matrix (2026-08-29) + multi-reminder list
      const cols = d.prepare('PRAGMA table_info(todos)').all().map(c => c.name)
      if (!cols.includes('important')) d.exec('ALTER TABLE todos ADD COLUMN important INTEGER NOT NULL DEFAULT 0')
      if (!cols.includes('urgent')) d.exec('ALTER TABLE todos ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0')
      if (!cols.includes('reminders')) d.exec('ALTER TABLE todos ADD COLUMN reminders TEXT')
    } },
    { v: 3, fn: d => {
      // Plan chips: meta.dayPlanState JSON → plan_chips row storage (2026-09-03 root fix). The original JSON key is renamed and kept as backup.
      // Failure handling: return false → schemaVersion not advanced → retried on next startup (INSERT OR IGNORE is idempotent; the original key remains).
      const r = d.prepare("SELECT value FROM meta WHERE key='dayPlanState'").get()
      if (!r) return true
      try {
        const doc = JSON.parse(r.value)
        const ins = d.prepare('INSERT OR IGNORE INTO plan_chips (id, taskId, day, mm, sort) VALUES (?,?,?,?,?)')
        const tr = d.transaction(() => {
          let n = 0
          for (const day of Object.keys(doc)) {
            if (day.startsWith('_')) continue
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue
            for (const [taskId, arr] of Object.entries(doc[day])) {
              if (!Array.isArray(arr)) continue
              for (const e of arr) {
                if (!e || !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(e.mm || ''))) continue
                const id = (e && typeof e === 'object' && e.id) ? String(e.id) : ('pl_mig_' + n)
                ins.run(id, taskId, day, String(e.mm), n); n++
              }
            }
          }
        }); tr()
        d.prepare("INSERT INTO meta (key, value) VALUES ('dayPlanState.bak', ?) ON CONFLICT(key) DO NOTHING").run(r.value) // the first backup is never overwritten
        d.prepare("DELETE FROM meta WHERE key='dayPlanState'").run()
        return true
      } catch (e) {
        console.error('[TodoDB] dayPlanState 迁移失败(保留原键,schemaVersion 不推进,下次启动重试):', e)
        return false
      }
    } },
    { v: 4, fn: d => { const c=d.prepare('PRAGMA table_info(todos)').all().map(x=>x.name); if(!c.includes('predecessors')) d.exec('ALTER TABLE todos ADD COLUMN predecessors TEXT'); return true } },
    { v: 5, fn: d => {
      // P1 sync groundwork (2026-09-15): tombstone + updatedAt columns on every synced table.
      // Only todos carried updatedAt/deletedAt before; filters/plan_chips/tomato_records deletes were
      // physical (unpropagatable) and categories had no change timestamp. Defaults keep existing rows.
      const want = {
        categories: ['deletedAt INTEGER NOT NULL DEFAULT 0', 'updatedAt INTEGER NOT NULL DEFAULT 0'],
        filters: ['deleted INTEGER NOT NULL DEFAULT 0', 'deletedAt INTEGER NOT NULL DEFAULT 0', 'updatedAt INTEGER NOT NULL DEFAULT 0'],
        plan_chips: ['deleted INTEGER NOT NULL DEFAULT 0', 'deletedAt INTEGER NOT NULL DEFAULT 0', 'updatedAt INTEGER NOT NULL DEFAULT 0'],
        tomato_records: ['deleted INTEGER NOT NULL DEFAULT 0', 'deletedAt INTEGER NOT NULL DEFAULT 0', 'updatedAt INTEGER NOT NULL DEFAULT 0']
      }
      for (const [table, cols] of Object.entries(want)) {
        const have = new Set(d.prepare('PRAGMA table_info(' + table + ')').all().map(c => c.name))
        for (const col of cols) {
          const name = col.split(' ')[0]
          if (!have.has(name)) d.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`)
        }
      }
      return true
    } },
    { v: 6, fn: d => syncSchema.migrateV6(d) },
  ]
  let ver = getVer()
  // Failed migration must abort (not `continue`): advancing would stamp the higher version so the failed migration never retries.
  for (const m of MIGRATIONS) { if (m.v > ver) { if (m.fn(db) === false) break; ver = m.v } }
  if (ver !== getVer()) setVer(ver)
  // SCHEMA/MIGRATIONS dual-manifest decoupling backstop: if a future SCHEMA column addition is forgotten in MIGRATIONS, CREATE TABLE IF NOT EXISTS is
  // a no-op for existing tables and the upsert prepare dies at startup referencing the missing column. Here, probe and add columns uniformly via PRAGMA
  // based on todoToRow's real column set (NOT NULL columns get default values)
  {
    const want = Object.keys(todoToRow({ taskId: '' }))
    const have = new Set(db.prepare('PRAGMA table_info(todos)').all().map(c => c.name))
    for (const col of want) {
      if (!have.has(col)) {
        const def = todoToRow({ taskId: '' })[col]
        const sqlDefault = typeof def === 'number' ? def
          : typeof def === 'boolean' ? (def ? 1 : 0)
          : typeof def === 'string' ? `'${def.replace(/'/g, "''")}'`
          : 'NULL'
        const affinity = typeof def === 'number' || typeof def === 'boolean' ? 'INTEGER' : 'TEXT'
        db.exec(`ALTER TABLE todos ADD COLUMN ${col} ${affinity} DEFAULT ${sqlDefault}`)
        log.warn('[TodoDB] 探测补列(迁移清单漏登记兜底):', col)
      }
    }
  }

  // ===== Encryption finalization (runs after schema migration completes) =====
  // The key is stored as db.key in the same directory (the CLI opening in the same directory is automatically compatible). Threat model: prevents the single
  // todos.db file from being read directly by sync drives/copies/forensic tools; the key lives on the same machine, so "entire userData readable" is not covered.
  // Both fresh installs (empty DB) and existing DBs (after schema migration) reach here and uniformly switch to the encrypted state.
  if (!hadKeyFile) {
    key = crypto.randomBytes(32).toString('hex')
    if (preSchemaTables > 0) {
      const ok = migratePlainToEncrypted(userDataPath, file, key)
      db = new loadDriver()(file)
      // Order is critical: write db.key to disk before the pragma — if the encrypted DB is opened first and the key write fails, the DB is encrypted while the key exists only in memory and the next startup is unrecoverable
      if (ok) { fs.writeFileSync(keyFile, key, 'utf8'); db.pragma(`key='${key}'`) }
      // On migration failure keep plaintext open (functionality first); the error is already logged
    } else {
      // Fresh install: the file only ever held our just-created empty schema — no data to migrate,
      // so delete and recreate encrypted. (PRAGMA key on the already-open plaintext handle would NOT
      // encrypt existing pages → the CLI reopening with db.key reads garbage: "file is not a database")
      db.close()
      for (const f of [file, file + '-wal', file + '-shm']) { try { fs.rmSync(f, { force: true }) } catch {} }
      fs.writeFileSync(keyFile, key, 'utf8')
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

  const cols = Object.keys(todoToRow({ taskId: '' }))
  stmts.upsert = db.prepare(`INSERT INTO todos (${cols.join(', ')}) VALUES (${cols.map(c => '@' + c).join(', ')}) ON CONFLICT(id) DO UPDATE SET ${cols.filter(c => c !== 'id').map(c => `${c} = excluded.${c}`).join(', ')}`)
  stmts.getById = db.prepare('SELECT * FROM todos WHERE id = ?')
  stmts.hardDelete = db.prepare('DELETE FROM todos WHERE id = ?')
  stmts.getMeta = db.prepare('SELECT value FROM meta WHERE key = ?')
  stmts.setMeta = db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  stmts.upsertMany = db.transaction(rows => { for (const r of rows) stmts.upsert.run(r) })
  // Atomic field increment: a whole-row overwrite from a stale cross-window row loses concurrent increments (estimate from two windows in the same tick); DB-side += avoids the race
  // P1 2026-09-17: focus increments must also flip status to 'update' — the renderer's snapshot
  // filter drops rows with status='sync', so a bump on an already-synced row used to leave the
  // focus delta invisible to the cloud sync path (commitSyncBatch) forever.
  stmts.bumpSnow = db.prepare("UPDATE todos SET focusMinutes = focusMinutes + @minutes, status = 'update', updatedAt = @now WHERE id = @taskId AND deleted = 0")
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
  if (keyword) {
    // Escape LIKE wildcards, otherwise input like %/_ changes the match semantics (searching "100%" hits everything)
    const esc = String(keyword).replace(/[\\%_]/g, ch => '\\' + ch)
    sql += " AND (content LIKE @kw ESCAPE '\\' OR description LIKE @kw ESCAPE '\\')"
    p.kw = `%${esc}%`
  }
  // orderBy is exposed via IPC; whitelist-validate to prevent SQL injection (only column name + ASC/DESC combinations allowed)
  const cols = new Set(['id', 'createdAt', 'updatedAt', 'scheduledDay', 'scheduledAt', 'completedAt', 'complete', 'remindAt', 'sort', 'priority', 'deadlineTs', 'important', 'urgent', 'categoryId', 'recurGroupId', 'status', 'content'])
  const parts = String(orderBy).split(',').map(x => x.trim().split(/\s+/))
  for (const part of parts) {
    if (!cols.has(part[0]) || (part[1] && !/^(ASC|DESC)$/i.test(part[1]))) throw new Error('queryTodos: 非法 orderBy: ' + orderBy)
  }
  sql += ` ORDER BY ${orderBy}`
  // F2 fix: `if (limit)` made limit=0 fail-open (0 === unlimited, while negatives threw) — validate on
  // presence (null/undefined only), so 0 is an explicit "zero rows" and all invalid values fail closed.
  if (limit !== null && limit !== undefined) { const n = Number(limit); if (!Number.isFinite(n) || n < 0) throw new Error('queryTodos: invalid limit'); sql += ' LIMIT ' + n }
  return db.prepare(sql).all(p).map(rowToTodo)
}

// F2 2026-09-15:SQLite TEXT PRIMARY KEY 不隐含 NOT NULL — taskId:null/undefined/'' 一路落到这里
// 会写成 NULL-id 幽灵行(全部幽灵行互相冲突覆盖,还可能挤掉正常 id='null' 的数据)。fail-fast 优于静默。
function assertHasTaskId (t) {
  if (!t || t.taskId == null || t.taskId === '') {
    throw new Error('[TodoDB] upsert: taskId is required, refusing to write a NULL-id ghost row (got ' + JSON.stringify(t && t.taskId) + ')')
  }
}

const makeBulkOps = require('./db-bulk-ops')(() => db, () => OPS)
const OPS = {
  upsert: t => { assertHasTaskId(t); stmts.upsert.run(todoToRow(t)); return true },
  upsertMany: list => { if (!Array.isArray(list)) throw new Error('[TodoDB] upsertMany: list must be an array, got ' + typeof list); list.forEach(assertHasTaskId); stmts.upsertMany(list.map(todoToRow)); return true },
  // Atomic sync-commit (W3 2026-09-12): row upserts + todosVersion cursor advance in ONE transaction. Why atomic: writing rows with status='sync' non-atomically and crashing between the upserts and the setMeta would leave rows marked 'sync' in the DB while todosVersion stayed behind — the dirty-row filter (status !== 'sync') would then skip them forever and the cursor would never advance again =
  // silent permanent non-convergence. Inside one transaction the crash outcome is all-or-nothing: either the whole batch is re-sent on restart (old dirty semantics) or fully acknowledged (new semantics) — no intermediate state. Rows arrive in store shape; the DB layer forces status='sync' so a compromised renderer cannot write arbitrary status values through this op.
  commitSyncBatch: ({ rows, version }) => {
    // The cursor is the convergence lynchpin — a non-numeric value (String(undefined) etc.) would
    // poison state.version with NaN on the next boot's parseInt. Fail closed at the DB layer.
    const v = Number(version)
    if (!Number.isFinite(v) || v < 0) throw new Error('[TodoDB] commitSyncBatch: invalid version ' + String(version))
    if (!Array.isArray(rows)) {
      // fail-closed (round-7 audit P0): rows=null slipping through would advance the cursor while
      // writing zero rows — dirty rows after it would never be re-sent (silent non-convergence)
      throw new Error('[TodoDB] commitSyncBatch: rows must be an array, got ' + typeof rows)
    }
    // Version monotonic fence (round-8 audit P1): a stale retry batch (lower v) must not roll back
    // the cursor or re-ack rows that a newer batch already confirmed — otherwise edits made between
    // the two attempts get frozen as stale 'sync' content (B3 P1 scenario)
    // Version monotonic fence (round-8 audit P1→P0 fix): a stale retry batch (lower v) must not
    // roll back the cursor or re-ack rows that a newer batch already confirmed. Uses .get() (SELECT
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
  bumpSnow: ({ taskId, minutes }) => {
    // Server-side clamping: arbitrary/negative values from the renderer (including the float window) must not tamper with the focus ledger (a single focus session capped at 600 minutes)
    const m = Math.max(0, Math.min(LIMITS.FOCUS_MAX_MINUTES, Math.floor(Number(minutes) || 0)))
    const r = stmts.bumpSnow.run({ taskId, minutes: m, now: Date.now() })
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
  hardDelete: id => { const tr = db.transaction(() => { db.prepare('DELETE FROM plan_chips WHERE taskId=?').run(String(id)); stmts.hardDelete.run(id) }); tr(); return true },
  hardDeleteMany: ids => { const tr = db.transaction(() => ids.forEach(i => { db.prepare('DELETE FROM plan_chips WHERE taskId=?').run(String(i)); stmts.hardDelete.run(i) })); tr(); return true },
  getMeta: k => { const r = stmts.getMeta.get(k); return r ? r.value : null },
  // Accepts both argument forms: (k, v) or [k, v] (the renderer's dbCall('setMeta', [k, v]) is passed through as a single call parameter)
  setMeta: (k, v) => { if (Array.isArray(k)) { v = k[1]; k = k[0] } stmts.setMeta.run(k, String(v)); return true },
  // Main-process internal only (not in the ALLOWED_RENDERER_OPS whitelist): used by the startup meta GC
  listMetaKeys: () => db.prepare('SELECT key FROM meta').all().map(r => r.key),
  // Monotonic sequence number for CLI tomato commands: UPDATE...RETURNING 单语句原子(两语句版在双 CLI 并发时读回同值→重号→App seq 去重丢命令,2026-09-04 深审 P1)
  nextCliTomatoSeq: () => Number(db.prepare("INSERT INTO meta (key, value) VALUES ('cliTomatoSeq', '1') ON CONFLICT(key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) RETURNING value").get().value),
  deleteMeta: k => { db.prepare('DELETE FROM meta WHERE key = ?').run(k); return true },
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
      db.prepare('DELETE FROM plan_chips WHERE taskId IN (SELECT id FROM todos WHERE deleted = 1)').run()
      db.prepare('DELETE FROM todos WHERE deleted = 1').run()
    }); tr(); return ids
  },
  // Cascade plan_chips too (same contract as hardDelete/purgeRecycleBin, transactional); returns purged ids for per-id sync tombstones.
  purgeSeedTodos: () => {
    let ids = []
    const tr = db.transaction(() => {
      ids = db.prepare("SELECT id FROM todos WHERE substr(id, 1, 5) = 'seed_'").all().map(r => r.id)
      db.prepare("DELETE FROM plan_chips WHERE taskId IN (SELECT id FROM todos WHERE substr(id, 1, 5) = 'seed_')").run()
      db.prepare("DELETE FROM todos WHERE substr(id, 1, 5) = 'seed_'").run()
    }); tr(); return ids
  },
  countSeedTodos: () => db.prepare("SELECT COUNT(*) n FROM todos WHERE substr(id, 1, 5) = 'seed_'").get().n,
  upsertCategory: (c) => {
    const now = Date.now()
    // H2 2026-09-16 root fix (startup dirty-write storm): the renderer re-upserts every category on
    // each boot; the old path rewrote all N rows with updatedAt=now and re-stamped tombstone
    // deletedAt, producing N fake oplog deltas per launch. Now: existing row is compared field by
    // field and an identical upsert is a no-op returning false (oplog produces no delta for it).
    const cur = db.prepare('SELECT * FROM categories WHERE id = ?').get(c && c.id)
    // Stamp deletedAt at tombstone time: callers never pass it, and a tombstone without a timestamp
    // can never be time-ordered or reconciled by a sync engine (review V1-F5). An already-tombstoned
    // row keeps its original deletedAt (re-upserting the same deleted category must not re-stamp it).
    const deletedAt = (c && c.deletedAt) || (c && c.delete ? ((cur && cur.deletedAt) || now) : 0)
    const row = {
      id: c && c.id,
      userId: c && c.userId,
      name: c && c.name,
      color: c && c.color,
      createdAt: c && c.createdAt,
      sort: c && c.sort,
      isFolder: (c && c.isFolder) ? 1 : 0,
      parentId: c && c.parentId,
      // callers may flag deletion via `delete` (renderer shape) or `deleted` (row shape); normalize to 1/0
      deleted: (c && (c.deleted != null ? c.deleted : c.delete)) ? 1 : 0,
      deletedAt,
      updatedAt: (c && c.updatedAt) || now
    }
    if (cur) {
      const eq = (a, b) => (a == null ? null : a) === (b == null ? null : b)
      const same = ['id', 'userId', 'name', 'color', 'createdAt', 'sort', 'isFolder', 'parentId', 'deleted', 'deletedAt']
        .every(k => eq(row[k], cur[k])) &&
        // updatedAt only counts as a diff when the caller explicitly supplied one (otherwise it is
        // just our own now-stamp and would make every no-op upsert look like a change)
        (c.updatedAt == null || eq(row.updatedAt, cur.updatedAt))
      if (same) return false
    }
    db.prepare(`INSERT INTO categories (id,userId,name,color,createdAt,sort,isFolder,parentId,deleted,deletedAt,updatedAt)
      VALUES (@id,@userId,@name,@color,@createdAt,@sort,@isFolder,@parentId,@deleted,@deletedAt,@updatedAt)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, color=excluded.color, createdAt=excluded.createdAt,
        sort=excluded.sort, isFolder=excluded.isFolder, parentId=excluded.parentId, deleted=excluded.deleted,
        deletedAt=excluded.deletedAt, updatedAt=excluded.updatedAt
      `).run(row) // 全字段 DO UPDATE:漏 isFolder/parentId 曾致拖入/拖出文件夹静默打回(2026-09-04 深审 P0);userId 不更新(行属不变)
    return true
  },
  getAllCategories: () => db.prepare('SELECT * FROM categories WHERE deleted = 0 ORDER BY sort').all().map(rowToCategory),
  // ===== Saved filters (smart lists): conds stores the condition JSON (catId/priority/dateMode) =====
  // Deletes are tombstones (P1 sync groundwork): a soft-deleted filter row must survive to propagate
  // to other devices; the recycle semantics stay invisible because filterList filters deleted=0.
  filterList: () => db.prepare('SELECT * FROM filters WHERE deleted = 0 ORDER BY sort, id').all().map(r => ({ id: r.id, name: r.name, conds: parseConds(r.conds), sort: r.sort })),
  filterUpsert: f => {
    const name = String(f && f.name || '').slice(0, 50)
    const conds = JSON.stringify(normConds(f && f.conds))
    if (f.id) {
      // P2 2026-09-17 no-op suppression (same rule as upsertCategory): re-saving identical content
      // used to overwrite updatedAt=now (faking LWW freshness) and emit a fake oplog delta per save.
      // Un-deletes on conflict are intentional, so a resurrected tombstone still writes.
      const cur = db.prepare('SELECT name, conds, sort, deleted FROM filters WHERE id = ?').get(f.id)
      if (cur && cur.deleted === 0 && cur.name === name && cur.conds === conds && cur.sort === (f.sort || 0)) return false
      db.prepare('UPDATE filters SET name=?, conds=?, sort=?, deleted=0, deletedAt=0, updatedAt=? WHERE id=?').run(name, conds, f.sort || 0, Date.now(), f.id)
      return f.id
    }
    const r = db.prepare('INSERT INTO filters (name, conds, sort, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?)').run(name, conds, f.sort || 0, Date.now(), Date.now())
    return Number(r.lastInsertRowid)
  },
  filterDelete: id => { db.prepare('UPDATE filters SET deleted=1, deletedAt=?, updatedAt=? WHERE id = ?').run(Date.now(), Date.now(), id); return true },
  // Per-day task total/completed counts (by due date), plus completion counts by "completion day" (unaffected by due date)
  // scheduledDay stores millisecond timestamps; callers may pass a YYYYMMDD integer (CLI), uniformly converted to a millisecond range
  _dayBounds: ({ from, to }) => {
    const conv = v => {
      if (v == null) return null
      if (v >= 1e11) return v // already in milliseconds
      const s = String(v)
      const y = +s.slice(0, 4); const mo = +s.slice(4, 6); const d = +s.slice(6, 8)
      // F2/H2: digit-slicing a 9-11 digit Unix-seconds value (e.g. 1758000000) yields a
      // "valid but wrong" date (year 1757, month 00) that is NOT NaN and silently poisons stats.
      // Validate the sliced calendar fields; anything outside month 1-12 / day 1-31 is a USAGE error.
      if (!(mo >= 1 && mo <= 12) || !(d >= 1 && d <= 31)) {
        throw new Error('[TodoDB] _dayBounds: ' + v + ' is not a parseable date (YYYYMMDD slices to month ' + mo + ', day ' + d + '), refusing to run BETWEEN a bogus range')
      }
      return new Date(y, mo - 1, d).getTime()
    }
    const f = conv(from)
    const t = conv(to)
    // F2 2026-09-15:new Date('垃圾').getTime()=NaN 可通过 == null 检查,SQL BETWEEN NaN 绑定成 NULL
    // → 静默恒空统计(CLI stats 场景下"空结果"比报错更骗人)。NaN = 调用方传了无法解析的日期,USAGE 错误如实上抛。
    for (const [name, v] of [['from', f], ['to', t]]) {
      if (v != null && Number.isNaN(v)) throw new Error('[TodoDB] _dayBounds: ' + name + ' is not a parseable date, refusing to run BETWEEN NaN (silent empty stats)')
    }
    // 终点=to 当日本地日末:用 dayjs 加一天再减 1ms,夏令时切换日(23/25h)不错位 1 小时(2026-09-05 终审 P2;固定 +86400000 只对中国时区成立)
    return [f == null ? null : f, t == null ? null : +dayjs(t).add(1, 'day').startOf('day') - 1]
  },
  statsByDay: ({ from, to }) => {
    const [f, t] = OPS._dayBounds({ from, to })
    // P2 2026-09-17: null bounds used to bind SQL BETWEEN NULL → silently always-empty, unlike
    // tomatoByDay which substitutes open-ended sentinels. scheduledDay is a millisecond timestamp;
    // 0 / 8.64e15 bracket every representable day (same sentinel semantics as tomatoByDay's
    // '0000-00-00'/'9999-99-99'). The completion-day keys are YYYYMMDD integers: 0 / 99991231.
    const fLo = f == null ? 0 : f
    const tHi = t == null ? 8640000000000000 : t
    const rows = db.prepare(`SELECT scheduledDay ds, SUM(complete) done, COUNT(*) total FROM todos
      WHERE deleted=0 AND scheduledDay BETWEEN ? AND ? GROUP BY scheduledDay`).all(fLo, tHi)
    // 完成日查询的边界须与 strftime 产出的 YYYYMMDD 同单位(2026-09-05 终审 P1:与毫秒边界 BETWEEN 恒假→恒空)
    const fKey = f == null ? 0 : Number(dayjs(f).format('YYYYMMDD'))
    const tKey = t == null ? 99991231 : Number(dayjs(t).format('YYYYMMDD'))
    const doneByCompletionDay = db.prepare(`SELECT CAST(strftime('%Y%m%d', completedAt/1000, 'unixepoch', 'localtime') AS INTEGER) ds, COUNT(*) n
      FROM todos
      WHERE deleted=0 AND complete=1 AND completedAt > 0
        AND CAST(strftime('%Y%m%d', completedAt/1000, 'unixepoch', 'localtime') AS INTEGER) BETWEEN ? AND ?
      GROUP BY ds`).all(fKey, tKey)
    return { rows, doneByCompletionDay }
  },
  // 真实专注账:聚合 tomato_records 行表按 dateKey 求和(2026-09-04 起账本唯一事实源=行表,不再读 meta blob);
  // 旧实现查 todos.focusMinutes(=预计番茄)导致"补录的专注在 stats 里恒为 0/缺天"
  tomatoByDay: ({ from, to }) => {
    const [f, t] = OPS._dayBounds({ from, to })
    const fKey = f == null ? null : dayjs(f).format('YYYY-MM-DD')
    const tKey = t == null ? null : dayjs(t).format('YYYY-MM-DD')
    // 2026-09-04 根修:账本迁 tomato_records 行表后聚合一跳完成
    // succeed=1 only: abandoned pomodoros are not focus time — same filter as the renderer's StatisticsView
    const rows = db.prepare(`SELECT dateKey ds, SUM(focusDuration) focus FROM tomato_records
      WHERE succeed = 1 AND deleted = 0 AND dateKey BETWEEN ? AND ? GROUP BY dateKey`).all(
        fKey ? fKey : '0000-00-00', tKey ? tKey : '9999-99-99')
    return rows.map(r => ({ ds: r.ds, focus: r.focus || 0 }))
  },
  // ===== Plan chips (timeline planning layer) formal row storage (2026-09-03 root fix) =====
  // Previously meta.dayPlanState JSON whole-package + LS dual-write with three-way concurrency — the architectural root of four data-loss incidents;
  // with row storage there is a single write channel (SQLite serialized) + write-op broadcast + cascading cleanup on task deletion, so the race is structurally eliminated.
  // plan_chips deletes are tombstones (P1 sync groundwork): user-facing chip removals must propagate
  // to other devices. planPrune is time-based GC (old days fall off) and stays physical — devices
  // reconcile pruned history via periodic full snapshots, so tombstoning it would only grow the table.
  // H2 2026-09-16: sort was missing from the snapshot SELECT — the snapshot/restore round-trip lost
  // chip ordering and restore's ON CONFLICT upsert then overwrote sort with 0.
  planAll: () => db.prepare('SELECT id, taskId, day, mm, sort FROM plan_chips WHERE deleted = 0 ORDER BY day, mm, sort').all(),
  planAddMany: chips => {
    // Skip-and-collect (round-3 review): one malformed chip used to throw for the WHOLE batch —
    // a poison pill in the sync flush wedged plan ingestion forever. Invalid rows are skipped
    // (never applied); the valid rows commit and their ids are returned.
    const list = (Array.isArray(chips) ? chips : [chips]).filter(c => c && c.taskId &&
      /^\d{4}-\d{2}-\d{2}$/.test(String(c.day)) && /^([01]\d|2[0-3]):[0-5]\d$/.test(String(c.mm)))
      .map(c => ({
        id: (c && c.id) || 'pl_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
        taskId: String(c.taskId || ''), day: String(c.day || ''), mm: String(c.mm || ''), sort: Number(c.sort) || 0
      }))
    const ins = db.prepare('INSERT INTO plan_chips (id, taskId, day, mm, sort, deleted, deletedAt, updatedAt) VALUES (@id,@taskId,@day,@mm,@sort,0,0,@updatedAt) ON CONFLICT(id) DO UPDATE SET taskId=excluded.taskId, day=excluded.day, mm=excluded.mm, sort=excluded.sort, deleted=0, deletedAt=0, updatedAt=excluded.updatedAt')
    const now = Date.now()
    const tr = db.transaction(() => list.forEach(c => ins.run({ ...c, updatedAt: now }))); tr()
    return list.map(c => c.id)
  },
  planUpdateChip: ({ id, day, mm }) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(day))) throw new Error('planUpdateChip: day 必须 YYYY-MM-DD')
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(mm))) throw new Error('planUpdateChip: mm 必须 HH:mm')
    const r = db.prepare('UPDATE plan_chips SET day=?, mm=?, updatedAt=? WHERE id=? AND deleted=0').run(String(day), String(mm), Date.now(), String(id))
    return r.changes > 0
  },
  planRemoveIds: ids => {
    const list = Array.isArray(ids) ? ids : [ids]
    const del = db.prepare('UPDATE plan_chips SET deleted=1, deletedAt=?, updatedAt=? WHERE id = ?')
    const now = Date.now()
    const tr = db.transaction(() => list.forEach(i => del.run(now, now, String(i)))); tr()
    return true
  },
  planMoveTask: ({ taskId, fromDay, toDay }) => {
    const okDay = v => /^\d{4}-\d{2}-\d{2}$/.test(String(v))
    if (!okDay(fromDay) || !okDay(toDay)) return 0 // reject malformed day keys outright, preventing chips from landing in invisible buckets
    const r = db.prepare('UPDATE plan_chips SET day=?, updatedAt=? WHERE taskId=? AND day=? AND deleted=0').run(String(toDay), Date.now(), String(taskId), String(fromDay))
    return r.changes
  },
  planDeleteTask: taskId => { db.prepare('UPDATE plan_chips SET deleted=1, deletedAt=?, updatedAt=? WHERE taskId=?').run(Date.now(), Date.now(), String(taskId)); return true },
  planDeleteTaskDay: ({ taskId, day }) => { db.prepare('UPDATE plan_chips SET deleted=1, deletedAt=?, updatedAt=? WHERE taskId=? AND day=?').run(Date.now(), Date.now(), String(taskId), String(day)); return true },
  planPrune: ({ keepDays }) => {
    const keep = Array.isArray(keepDays) ? keepDays.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(String(d))) : []
    if (!keep.length) return 0
    const ph = keep.map(() => '?').join(',')
    const r = db.prepare(`DELETE FROM plan_chips WHERE day NOT IN (${ph})`).run(...keep)
    return r.changes
  },
  // ===== Tomato focus ledger: formal row storage (2026-09-04 root fix, plan_chips same pattern) =====
  // Single source of truth for the ledger; LS keeps only timer transient state. All writers (main window / float window / CLI) go through these atomic ops,
  // structurally eliminating the entire class of "multi-writer full-blob overwrite → deletion resurrected / new records erased" incidents.
  _REC_COLS: ['endTime', 'dateKey', 'focus', 'focusTaskId', 'focusDuration', 'rest', 'restDuration', 'succeed', 'manual', 'status', 'abandonReason'],
  _recToRow (r) {
    const o = { tomatoId: String(r.tomatoId) }
    for (const k of OPS._REC_COLS) {
      let v = r[k]
      if (k === 'endTime' || k === 'rest') v = Math.max(0, Math.round(Number(v) || 0))
      else if (k === 'focusDuration') v = Math.min(LIMITS.FOCUS_MAX_MINUTES, Math.max(0, Math.round(Number(v) || 0))) // clamp at the DB layer; P3 2026-09-17: lower bound is 0, not 1 — a bad value (0/NaN/garbage) must not be inflated into a phantom focus minute that LAN merge "max" then amplifies
      else if (k === 'restDuration') v = Math.min(LIMITS.REST_MAX_MINUTES, Math.max(0, Math.round(Number(v) || 0)))
      else if (k === 'succeed') v = v === false ? 0 : 1
      else if (k === 'manual') v = v ? 1 : 0
      o[k] = v == null ? null : v
    }
    // Preserve unknown/future fields as a JSON blob (won't be lost when writing back after forward-compatible reads)
    const known = new Set(['tomatoId', ...OPS._REC_COLS])
    const UNSAFE_KEYS = new Set(['__proto__', 'constructor', 'prototype'])
    const extra = {}
    for (const k of Object.keys(r || {})) if (!known.has(k) && !UNSAFE_KEYS.has(k)) extra[k] = r[k]
    o.extra = Object.keys(extra).length ? JSON.stringify(extra) : null
    // (2026-09-19) The old `if (!o.succeed && o.succeed !== 0) o.succeed = 1` re-default here was dead
    // code: the loop above already coerces succeed to exactly 0 (false) or 1 (everything else, including
    // undefined/garbage) via `v = v === false ? 0 : 1`, so the branch could never fire. Deleted instead of
    // "fixed" — every caller (cli/lib.js backfill/record ops, sync-apply, index.js restore) funnels rows
    // through this function, so no separate validation layer is needed.
    return o
  },
  _rowToRec (r) {
    const rec = {
      tomatoId: r.tomatoId, endTime: r.endTime, dateKey: r.dateKey,
      focus: r.focus || '', focusTaskId: r.focusTaskId || null,
      focusDuration: r.focusDuration || 0, rest: r.rest || 0, restDuration: r.restDuration || 0,
      succeed: !!r.succeed, manual: !!r.manual, status: r.status || 'local', abandonReason: r.abandonReason || ''
    }
    if (r.extra) {
      try {
        // Key-filtered copy instead of Object.assign: JSON.parse materializes a "__proto__" own key
        // and assign's [[Set]] would turn it into a prototype swap on rec (security review 2026-09-11)
        const extra = JSON.parse(r.extra)
        for (const k of Object.keys(extra)) {
          if (k === '__proto__' || k === 'constructor' || k === 'prototype') continue
          rec[k] = extra[k]
        }
      } catch (e) { /* corrupted extra fields do not block the main fields */ }
    }
    return rec
  },
  tomatoAll: () => db.prepare('SELECT * FROM tomato_records WHERE deleted = 0 ORDER BY endTime DESC').all().map(OPS._rowToRec),
  tomatoAppendMany: rows => {
    const list = Array.isArray(rows) ? rows : [rows]
    const ins = db.prepare(`INSERT INTO tomato_records (tomatoId, endTime, dateKey, focus, focusTaskId, focusDuration, rest, restDuration, succeed, manual, status, abandonReason, extra, deleted, deletedAt, updatedAt)
      VALUES (@tomatoId, @endTime, @dateKey, @focus, @focusTaskId, @focusDuration, @rest, @restDuration, @succeed, @manual, @status, @abandonReason, @extra, 0, 0, @updatedAt)
      ON CONFLICT(tomatoId) DO UPDATE SET endTime=excluded.endTime, dateKey=excluded.dateKey, focus=excluded.focus, focusTaskId=excluded.focusTaskId,
        focusDuration=excluded.focusDuration, rest=excluded.rest, restDuration=excluded.restDuration, succeed=excluded.succeed, manual=excluded.manual,
        status=excluded.status, abandonReason=excluded.abandonReason, extra=excluded.extra, deleted=0, deletedAt=0, updatedAt=excluded.updatedAt`)
    // F2 2026-09-15 行级容错(架构根因:批量接口的失败粒度应是"行级"而非"批级"):
    // 此前任一行缺 tomatoId/endTime 抛错回滚整批 → 渲染端 pending 队列被一条坏行劫持无限重试,
    // 同批合法账本行永不落库。现改为事务内跳过无效行并记入返回值 rejected,合法行照常落库;
    // renderer acknowledges the batch on fulfilment and logs rejected rows, then drops them from its
    // pending queue (报错以 console.error 上报,行按 rejected 索引剔除)。
    const rejected = []
    let accepted = 0
    const tr = db.transaction(() => list.forEach((raw, index) => {
      const reject = reason => rejected.push({
        index,
        tomatoId: raw && raw.tomatoId != null ? String(raw.tomatoId) : null,
        reason
      })
      if (!raw || !raw.tomatoId) { reject('tomatoId required'); return }
      if (!raw.endTime) { reject('endTime required'); return }
      const r = OPS._recToRow(Object.assign({ dateKey: '', succeed: true, manual: false }, raw))
      // dateKey 无条件由 endTime 重导(2026-09-04 深审 P0:三补录入口曾各按 startTs 落 dateKey,跨午夜记录与统计/时间轴 endTime 口径分裂)
      // dateKey 从调用方传入值起不再被信任,格式校验降级为派生后的防御断言
      r.dateKey = dayjs(r.endTime).format('YYYY-MM-DD')
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.dateKey))) { reject('dateKey derive failed'); return }
      ins.run({ ...r, updatedAt: Date.now() })
      accepted++
    }))
    tr()
    return { accepted, rejected }
  },
  tomatoUpdateById: ({ tomatoId, patch }) => {
    const cur = db.prepare('SELECT * FROM tomato_records WHERE tomatoId = ?').get(String(tomatoId))
    if (!cur) return false
    const rec = Object.assign(OPS._rowToRec(cur), patch || {})
    // dateKey 双向强制 = dayjs(endTime):改 endTime 重导(改时间忘改日),只传 dateKey 也拒绝(脱离 endTime 的 dateKey patch = 幽灵行后门,2026-09-04 深审 P0)
    rec.dateKey = dayjs(rec.endTime).format('YYYY-MM-DD')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(rec.dateKey))) throw new Error('tomatoUpdateById: bad endTime produces invalid dateKey')
    const r = OPS._recToRow(rec)
    // `AND deleted = 0`: a tombstoned (removed) record is invisible to every reader — reporting success
    // on it would tell the caller a patch landed that nobody can ever see (review V1-F2)
    const res = db.prepare(`UPDATE tomato_records SET endTime=@endTime, dateKey=@dateKey, focus=@focus, focusTaskId=@focusTaskId,
      focusDuration=@focusDuration, rest=@rest, restDuration=@restDuration, succeed=@succeed, manual=@manual,
      status=@status, abandonReason=@abandonReason, extra=@extra, updatedAt=@updatedAt WHERE tomatoId=@tomatoId AND deleted = 0`).run(Object.assign({ tomatoId: String(tomatoId), updatedAt: Date.now() }, r))
    return res.changes > 0
  },
  // Tombstone delete (P1 sync groundwork): ledger removals must propagate to other devices; every
  // reader (tomatoAll/tomatoByDay) filters deleted=0, so behaviour matches the old physical delete.
  tomatoRemoveByIds: ids => {
    const list = Array.isArray(ids) ? ids : [ids]
    const del = db.prepare('UPDATE tomato_records SET deleted=1, deletedAt=?, updatedAt=? WHERE tomatoId = ?')
    const now = Date.now()
    const tr = db.transaction(() => list.forEach(i => del.run(now, now, String(i))))
    tr()
    return true
  },
  // One-time migration: bulk-insert the full ledger from the old meta blob.
  // 守卫不能只靠"表空"——用户删光账本后表空是合法状态,不删 meta blob 会整批复活已删记录(P0,并行审查实锤)。
  // 所以:无论走哪条分支,迁移完成即删 meta blob;"blob 不存在"才是真正的已迁移哨兵。
  tomatoMigrateFromMeta: () => {
    const delBlob = () => { try { db.prepare('DELETE FROM meta WHERE key = ?').run('db.tomatoState') } catch { /* 清理失败不阻断 */ } }
    const n = db.prepare('SELECT COUNT(*) c FROM tomato_records').get().c
    if (n > 0) { delBlob(); return 0 }
    // 损坏 blob 不删(2026-09-10 P2):此前 JSON.parse 失败 catch 成 {} → list 空 → delBlob 直接把
    // 旧账本 blob 抹掉,记录永久丢失(可能只是磁盘位翻转/半截写入)。parse 失败 = warn + 返回 0
    // 保留 blob,下次(比如从备份恢复后)还有迁移机会;只有成功解析才走迁移/清理。
    // 纯解析逻辑抽到 fix-util.parseTomatoMetaBlob 便于 node --test 覆盖。
    const parsed = require('./fix-util').parseTomatoMetaBlob(stmts.getMeta.get('db.tomatoState')?.value)
    if (!parsed.ok) { log.warn('[TodoDB] tomatoMigrateFromMeta: 旧 meta blob 损坏(JSON 解析失败),保留 blob 不迁移不删除'); return 0 }
    const list = parsed.list
    if (!list.length) { delBlob(); return 0 }
    OPS.tomatoAppendMany(list)
    delBlob()
    return list.length
  },
  // Delta read for the (future) sync engine and tests: oplog rows strictly after sinceSeq, oldest first.
  // limit guards the first pull on a large existing log; callers page through via the returned max seq.
  // Main-process/CLI-only op by design: the future sync engine lives in the main process and reads the
  // db layer directly. Deliberately NOT in the renderer IPC whitelist or contracts.d.ts DbCallOp —
  // adding a renderer caller without whitelisting it would be the filterList/bumpSnow silent-outage shape.
  settingsRowsAll: () => syncSchema.rowsAll(), // settings/habits row table (P2, docs/sync §4.2)
  settingsRowPut: p => syncSchema.rowPut(p),
  settingsRowPutMany: p => syncSchema.rowPutMany(p),
  settingsRowDelete: p => syncSchema.rowDelete(p),
  upsertCategoryMany: makeBulkOps.upsertCategoryMany,
  filterUpsertMany: makeBulkOps.filterUpsertMany,
syncOplogSince: ({ sinceSeq = 0, limit = 2000 } = {}) => db.prepare('SELECT seq, entity, entityId, ts FROM sync_oplog WHERE seq > ? ORDER BY seq ASC LIMIT ?').all(Number(sinceSeq) || 0, Math.max(1, Math.min(10000, Math.floor(Number(limit) || 2000)))),
  // P3a LAN sync ops (2026-09-16): delegates into db-sync-ops.js (gate: ops must exist here; impl lives in lan-sync-bootstrap.js)
  syncGetSettings: p => require('./db-sync-ops').dispatch('syncGetSettings', p),
  syncSetEnabled: p => require('./db-sync-ops').dispatch('syncSetEnabled', p),
  syncGetStatus: p => require('./db-sync-ops').dispatch('syncGetStatus', p),
  syncGetPairingCode: p => require('./db-sync-ops').dispatch('syncGetPairingCode', p),
  syncSetName: p => require('./db-sync-ops').dispatch('syncSetName', p),
  syncPairWithCode: p => require('./db-sync-ops').dispatch('syncPairWithCode', p),
  syncAddPeer: p => require('./db-sync-ops').dispatch('syncAddPeer', p),
  syncPairRespond: p => require('./db-sync-ops').dispatch('syncPairRespond', p),
  syncPairRequest: p => require('./db-sync-ops').dispatch('syncPairRequest', p),
  // One-time bootstrap: rows created before the oplog existed (any user enabling sync on an
  // existing database) have no change-capture pointers and would never propagate. Idempotent via
  // the sync.seedDone meta flag; NOT renderer-callable (main-internal, like the meta GC ops).
  seedSyncOplog: p => require('./db-sync-ops').dispatch('seedSyncOplog', p),
  // Main-internal: bare oplog pointer backfill for legacy rows (used by the seedSyncOplog seed).
  appendOplogPointers: rows => {
    const now = Date.now()
    const ins = db.prepare('INSERT INTO sync_oplog (entity, entityId, ts) SELECT ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM sync_oplog WHERE entity = ? AND entityId = ?)')
    let seeded = 0
    for (const r of rows || []) seeded += ins.run(r.entity, String(r.id), now, r.entity, String(r.id)).changes
    return { seeded }
  },
}

/** 账本变更钩子:任何进程(App 主进程 IPC / CLI 直连)经 call() 落账本写 op 后触发。
 *  App 侧用它向所有窗口广播 tomato-records-changed;CLI 进程内无窗口,钩子天然不挂。
 *  放在 db 层而非 IPC handler 是根修关键:CLI 直写不经过 IPC,钩子挂 handler 上会漏广播(2026-09-04 实锤)。 */
const LEDGER_WRITE_OPS = new Set(['tomatoAppendMany', 'tomatoUpdateById', 'tomatoRemoveByIds', 'tomatoMigrateFromMeta'])
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
  if (op !== 'commitSyncBatch' && WRITE_OPS.has(op)) oplog.appendOplog(oplog.oplogEntriesFor(op, params, r))
  return r
}

// Explicit write-op list: the todo-db:call handler uses it to decide reloadAll+broadcastTodosChanged.
// Do not guess with regexes — write ops like hardDeleteMany/filterDelete/clearCategories were once missed, leaving cross-window data stale.

const WRITE_OPS = new Set([
  'upsert', 'upsertMany', 'commitSyncBatch', 'bumpSnow', 'hardDelete', 'hardDeleteMany', 'setMeta', 'deleteMeta',
  'purgeRecycleBin', 'purgeSeedTodos', 'upsertCategory',
  'filterUpsert', 'filterDelete',
  'planAddMany', 'planUpdateChip', 'planRemoveIds', 'planMoveTask',
  'tomatoAppendMany', 'tomatoUpdateById', 'tomatoRemoveByIds', 'tomatoMigrateFromMeta',
  'planDeleteTask', 'planDeleteTaskDay', 'planPrune', 'settingsRowPut', 'settingsRowPutMany', 'settingsRowDelete',
  'upsertCategoryMany', 'filterUpsertMany'
])
const isWriteOp = op => WRITE_OPS.has(op)
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

module.exports = { init, call, queryTodos, normalizeContent, isWriteOp, isOpen, close, setLedgerChangedHook, suppressLedgerHook, LEDGER_WRITE_OPS, WRITE_OPS, SCHEMA }
