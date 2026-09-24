/** Backup directory whitelist — moved verbatim from index.js (content unchanged)
 *  Backup directory: the renderer passes settings.backupDir (empty = externalized default root, parent-of-userData/pickdone-backups).
 *  Whitelist: allows the userData default directory or a directory explicitly picked by the user via the pick-backup-dir dialog (persisted to
 *  userData/allowed-backup-dirs.json; only the main-process dialog can append to it). A compromised renderer could pass any
 *  backupDir to make the main process write JSON to an arbitrary path — tightened to a registration scheme: unregistered directories are always rejected and fall back to the default directory. */
const path = require('path')
const fs = require('fs')
const log = require('electron-log')

// Lazy electron require: this module is also consumed by pure-Node CLI code
// (cli/lib-restore-backup.cjs) where `electron` cannot resolve at require time.
let _app = null
const getApp = () => { _app = _app || require('electron').app; return _app }

const allowedBackupDirs = new Set()
function allowedBackupDirsFile () { return path.join(getApp().getPath('userData'), 'allowed-backup-dirs.json') }

/** Single source for default backup-root candidates (P0 root fix, 2026-09-25):
 *  [0] is the ACTIVE default root; [1..] are legacy roots kept for discovery/migration only.
 *  Priority: TODO_BACKUP_DIR (explicit) > <userData>/backups (inside the isolation dir — a dev
 *  instance with TODO_USER_DATA_DIR can no longer leak auto snapshots into the repo tree via the
 *  old parent-of-userData derivation) > legacy <parent-of-userData>/pickdone-backups.
 *  Both consumers (main process defaultBackupRoot and the CLI restore-backup discovery) read THIS
 *  function — no second copy of the derivation is allowed. */
function defaultBackupRootCandidates (userDataDirPath) {
  if (process.env.TODO_BACKUP_DIR) return [process.env.TODO_BACKUP_DIR]
  return [
    path.join(userDataDirPath, 'backups'),
    path.join(path.dirname(userDataDirPath), 'pickdone-backups')
  ]
}

/** Active default backup root. Previously externalized to parent-of-userData/pickdone-backups so
 *  wiping userData spared the backups; that derivation made dev instances (userData under the repo)
 *  write snapshots into the repo tree. The default now lives INSIDE userData (TODO_BACKUP_DIR can
 *  externalize it explicitly) and the old external snapshots are migrated in once. */
function defaultBackupRoot () {
  const ud = getApp().getPath('userData')
  const [root, ...legacyRoots] = defaultBackupRootCandidates(ud)
  for (const legacy of legacyRoots) migrateLegacyBackups(legacy, root)
  return root
}

/** One-time, idempotent migration: move *.json from a legacy backup dir into the active root when
 *  the corresponding file is absent there; name conflicts drop only the legacy copy; failure warns
 *  and never blocks backups. A legacy dir equal to the root is skipped (self-move would delete). */
function migrateLegacyBackups (legacyDir, root) {
  try {
    const legacy = path.resolve(legacyDir)
    if (legacy === path.resolve(root)) return
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
    if (moved) log.info('[Backup] 已将旧默认备份目录快照迁移至新默认根:', legacy, '->', root, `(${moved} 个文件)`)
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
  const fallback = defaultBackupRoot() // default root: TODO_BACKUP_DIR or <userData>/backups (single source: defaultBackupRootCandidates)
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

module.exports = { resolveBackupDir, defaultBackupRoot, defaultBackupRootCandidates, saveAllowedBackupDirs, loadAllowedBackupDirs, allowedBackupDirs }
