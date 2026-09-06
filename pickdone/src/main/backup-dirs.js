/** Backup directory whitelist — moved verbatim from index.js (content unchanged)
 *  Backup directory: the renderer passes settings.backupDir (empty = externalized default root, parent-of-userData/pickdone-backups).
 *  Whitelist: allows the userData default directory or a directory explicitly picked by the user via the pick-backup-dir dialog (persisted to
 *  userData/allowed-backup-dirs.json; only the main-process dialog can append to it). A compromised renderer could pass any
 *  backupDir to make the main process write JSON to an arbitrary path — tightened to a registration scheme: unregistered directories are always rejected and fall back to the default directory. */
const path = require('path')
const fs = require('fs')
const { app } = require('electron')
const log = require('electron-log')

const allowedBackupDirs = new Set()
function allowedBackupDirsFile () { return path.join(app.getPath('userData'), 'allowed-backup-dirs.json') }

/** Default backup root externalized: pickdone-backups under the userData parent directory (e.g. %APPDATA%\pickdone-backups).
 *  The old default userData/backups lived alongside todos.db in userData; wiping userData killed both DB and backups. Externalized, backups survive independently.
 *  Only a "default": when the user explicitly set a directory in settings.backupDir, the user's setting is honored (whitelist/symlink defenses unchanged). */
function defaultBackupRoot () {
  const ud = app.getPath('userData')
  const root = path.join(path.dirname(ud), 'pickdone-backups')
  migrateLegacyBackups(ud, root)
  return root
}

/** One-time, idempotent migration of the old default directory: when the new default root lacks the corresponding file, move *.json from userData/backups over.
 *  rename is naturally idempotent (the source disappears after moving); on name conflicts only the old-side copy is dropped, never overwriting the new root; failure only warns and does not block backups. */
function migrateLegacyBackups (ud, root) {
  try {
    const legacy = path.join(ud, 'backups')
    if (!fs.existsSync(legacy)) return
    const files = fs.readdirSync(legacy).filter(f => f.endsWith('.json'))
    if (!files.length) return
    fs.mkdirSync(root, { recursive: true })
    let moved = 0
    for (const f of files) {
      const src = path.join(legacy, f)
      const dst = path.join(root, f)
      if (fs.existsSync(dst)) { try { fs.unlinkSync(src) } catch {} continue }
      try { fs.renameSync(src, dst); moved++ } catch {}
    }
    if (moved) log.info('[Backup] 已将旧默认备份目录快照迁移至外置根:', legacy, '->', root, `(${moved} 个文件)`)
  } catch (e) { log.warn('[Backup] 旧备份目录迁移跳过:', e && e.message) }
}
function loadAllowedBackupDirs () {
  if (allowedBackupDirs.size) return
  try { for (const d of JSON.parse(fs.readFileSync(allowedBackupDirsFile(), 'utf8'))) allowedBackupDirs.add(path.resolve(d)) } catch {}
}
function saveAllowedBackupDirs () {
  try { fs.writeFileSync(allowedBackupDirsFile(), JSON.stringify([...allowedBackupDirs])) } catch {}
}
function resolveBackupDir (configured) {
  const fallback = defaultBackupRoot() // externalized default root (formerly userData/backups, sharing the DB's fate)
  loadAllowedBackupDirs()
  const dir = configured || fallback
  const resolved = path.resolve(dir)
  if (resolved !== path.resolve(fallback) && !allowedBackupDirs.has(resolved)) {
    log.warn('[Backup] backupDir 未登记，回落默认目录:', dir)
    return fallback
  }
  // Prevent symlink bypass: after a user explicitly picks a directory, an attacker could create a symlink inside it pointing to any path
  // (e.g. C:\Windows\System32); the main process's path.resolve does not follow symlinks, but file writes will.
  // fs.lstat returns metadata of the symlink itself; detection is via stat.isSymbolicLink().
  try {
    fs.mkdirSync(resolved, { recursive: true })
    const st = fs.lstatSync(resolved)
    if (st.isSymbolicLink()) {
      log.warn('[Backup] backupDir 是符号链接，回落默认目录:', dir)
      return fallback
    }
  } catch (e) {
    log.warn('[Backup] backupDir stat 失败，回落默认目录:', dir, e.message)
    return fallback
  }
  return resolved
}

module.exports = { resolveBackupDir, defaultBackupRoot, saveAllowedBackupDirs, loadAllowedBackupDirs, allowedBackupDirs }
