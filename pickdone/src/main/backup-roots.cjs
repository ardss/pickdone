/** Single source for default backup-root candidates (P0 root fix, 2026-09-26):
 *  [0] is the ACTIVE default root; [1..] are legacy roots kept for discovery/migration only.
 *  Priority: TODO_BACKUP_DIR (explicit) > <userData>/backups > legacy <parent-of-userData>/pickdone-backups.
 *  Dependency-free pure path+env module (no electron, no electron-log) so BOTH the main process
 *  (backup-dirs.js, which needs electron-log) and pure-Node consumers (dbRecovery.cjs disaster
 *  recovery, unit tests) can read the SAME derivation — no second copy of it is allowed. */
const path = require('path')

function defaultBackupRootCandidates (userDataDirPath) {
  if (process.env.TODO_BACKUP_DIR) return [process.env.TODO_BACKUP_DIR]
  return [
    path.join(userDataDirPath, 'backups'),
    path.join(path.dirname(userDataDirPath), 'pickdone-backups')
  ]
}

module.exports = { defaultBackupRootCandidates }
