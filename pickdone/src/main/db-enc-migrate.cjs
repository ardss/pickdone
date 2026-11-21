/** One-time migration of an existing plaintext DB to an encrypted DB (extracted verbatim from
 *  db.js for the size ratchet — behavior identical; db.js keeps the thin wrapper and owns the
 *  module state: the live handle, SCHEMA, the fail-injection hook and the degraded flag). */
'use strict'

/** ATTACH the encrypted target + create tables per the existing SCHEMA + copy rows table by table,
 *  keeping the original file as a .plain-bak fallback (the driver lacks sqlcipher_export, so migration is manual).
 *  ctx: { db, SCHEMA, log, migrateFailHook, onDegraded } */
function migratePlainToEncrypted (ctx, dir, file, key) {
  const { db, SCHEMA, log, migrateFailHook } = ctx
  const fs = require('fs')
  const path = require('path')
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
      require('./db-enc-copy')(db, table)
    }
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
    // [H5 2026-10-25, rootcause audit] silent-plaintext degradation: the session now runs
    // UNENCRYPTED while the user believes their data is encrypted at rest. Flag it so the
    // whenReady chain surfaces ONE visible notice (quarantine-notice contract).
    if (ctx.onDegraded) ctx.onDegraded()
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

module.exports = { migratePlainToEncrypted }
