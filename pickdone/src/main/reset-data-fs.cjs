/**
 * Reset-data file destruction — extracted from index.js (F1 2026-10-17 size-ratchet trim; pure fs
 * over the userData path, testable in isolation).
 *
 * Root cause carried here (F1 2026-10-17): the deletion list used to miss the recovery-pending
 * sentinel and the critical-state disaster backup — after "reset data" the next boot's
 * cleanInitReplayDecision (sentinel + parseable critical-state-backup.json) replayed the JSON
 * restore and RESURRECTED the data the user had just destroyed. The list now covers both, and the
 * ACTIVE default-root copy (<userData>/backups/critical-state-backup.json — where the replay
 * actually reads it, backup-roots.cjs defaultBackupRootCandidates[0]; legacy roots resolve through
 * the same criticalBackupPath function) is swept best-effort after the in-userData loop.
 */
const fs = require('fs')
const path = require('path')
const fixUtil = require('./fix-util')
const dbRecovery = require('./dbRecovery.cjs')

function deleteResetTargets (ud, ts, onFailure) {
  const failures = []
  const report = (name, err) => {
    failures.push(name + ': ' + (err && err.message || err))
    if (typeof onFailure === 'function') onFailure(name, err && err.message || err)
  }
  for (const f of ['todos.db', 'todos.db-wal', 'todos.db-shm', 'db.key', 'todos.db.plain-bak',
    'recovery-pending.json', 'critical-state-backup.json']) {
    const p = path.join(ud, f)
    try {
      fs.unlinkSync(p)
    } catch (err) {
      try {
        fs.renameSync(p, path.join(ud, fixUtil.pendingDeleteName(f, ts)))
      } catch (err2) { report(f, err2) }
    }
  }
  const critPath = dbRecovery.criticalBackupPath(ud)
  if (fs.existsSync(critPath)) {
    try { fs.unlinkSync(critPath) } catch (err) {
      try { fs.renameSync(critPath, path.join(ud, fixUtil.pendingDeleteName('critical-state-backup.json', ts))) } catch (err2) { report('critical-state-backup.json', err2) }
    }
  }
  return failures
}

module.exports = { deleteResetTargets, RESET_TARGET_FILES: ['todos.db', 'todos.db-wal', 'todos.db-shm', 'db.key', 'todos.db.plain-bak', 'recovery-pending.json', 'critical-state-backup.json'] }
