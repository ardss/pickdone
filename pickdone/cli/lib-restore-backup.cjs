/**
 * lib-restore-backup.cjs — restore-backup command body, extracted from pickdone.js
 * (structural ratchet: the CLI entry had grown past its ratchet baseline; this is a pure
 * move refactor — no behavior change).
 *
 * Read-only safety command: discover + validate + guide. The DB is encrypted (better-sqlite3-multiple-ciphers
 * + db.key, see src/main/db.js), so the CLI NEVER swaps the DB file itself — the App owns real restoration.
 */
const fs = require('fs')
const path = require('path')
const dayjs = require('dayjs')

module.exports = function restoreBackup ({ opts, lib, emit }) {
  const SNAP = 'auto-'
  // The backup default root is externalized (userData parent dir / pickdone-backups, separate from todos.db); falls back to userData/backups for old or unmigrated installs
  const extRoot = path.join(path.dirname(lib.userDataDir()), 'pickdone-backups')
  const legacyRoot = path.join(lib.userDataDir(), 'backups')
  // F15 (dw wave6 2026-09-24): snapshots actually land in resolveBackupDir(settings.backupDir) —
  // a user-chosen backup dir left the CLI's two hardcoded candidates empty ("no auto-*.json
  // snapshots") while the App had plenty. Read the user dir through the lib's settings channel
  // (db.settingsState blob + settings_rows overlay — the same lib.read door every other CLI
  // command uses); absent/unreadable settings degrade to the two default candidates.
  let userDir = ''
  try {
    // Read-only discipline (unit-cli pin): the list form must never CREATE the DB — only read
    // settings through lib's door when a database already exists; a fresh/missing DB has no
    // user backup dir worth discovering anyway and degrades to the default candidates.
    if (fs.existsSync(path.join(lib.userDataDir(), 'todos.db'))) userDir = String(lib.settingsDoc().backupDir || '').trim()
  } catch { /* closed/locked DB → defaults only */ }
  const candidateDirs = [...new Set([extRoot, legacyRoot, userDir && path.resolve(userDir)].filter(Boolean))]
  const listSnapshots = root => {
    try {
      return fs.existsSync(root)
        ? fs.readdirSync(root).filter(f => f.startsWith(SNAP) && f.endsWith('.json'))
          .map(f => { const st = fs.statSync(path.join(root, f)); return { dir: root, file: f, mtime: st.mtimeMs, size: st.size } })
        : []
    } catch { return [] }
  }
  if (!opts._.length) {
    // List recoverable auto snapshots across every candidate dir, merged newest-first by mtime
    const seen = new Set()
    const files = candidateDirs.flatMap(listSnapshots)
      .filter(f => { const k = f.dir + '\n' + f.file; if (seen.has(k)) return false; seen.add(k); return true })
      .sort((a, b) => b.mtime - a.mtime)
    if (opts.json) return emit({ backupDir: candidateDirs, snapshots: files })
    if (!files.length) { console.log(`(no auto-*.json snapshots in ${candidateDirs.join(', ')})`); return }
    console.log('Recoverable snapshots (newest first):')
    files.forEach(f => console.log(`  ${path.join(f.dir, f.file)}  modified ${dayjs(f.mtime).format('YYYY-MM-DD HH:mm:ss')}  (${f.size} bytes)`))
    console.log('Run `restore-backup <path>` to validate one and see how to restore it.')
    return
  }
  const file = path.resolve(opts._[0])
  if (!fs.existsSync(file)) throw new lib.CliError(`snapshot file not found: ${file}`, 'SNAPSHOT_NOT_FOUND')
  let snap
  try { snap = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) {
    throw new lib.CliError(`snapshot is not valid JSON: ${file} (${e.message})`, 'SNAPSHOT_INVALID')
  }
  // F14 (dw wave6 2026-09-24): the old summary read legacy top-level keys (todos/todoList/
  // categories/meta/savedAt) that real renderer dumps never carry — every real snapshot
  // nests everything under dump.backup.* as JSON strings, so validation printed "Snapshot OK"
  // with counts of null for ANY parseable JSON (even garbage). Parse the real segments
  // (todoState/categoryState: JSON string or object) and count the actual row lists.
  const parseSeg = key => {
    let v = snap && snap.backup && snap.backup[key]
    if (typeof v === 'string') { try { v = JSON.parse(v) } catch { return null } }
    return (v && typeof v === 'object' && !Array.isArray(v)) ? v : null
  }
  const todoState = parseSeg('todoState')
  const catState = parseSeg('categoryState')
  // A snapshot with NO recognizable backup shape is not a pickdone dump — the old code greeted
  // any parseable JSON (even `{"foo":1}`) with "Snapshot OK" and null counts.
  if (!todoState && !catState && !Array.isArray(snap) && !Array.isArray(snap.todoList) && !Array.isArray(snap.todos)) {
    throw new lib.CliError('snapshot is valid JSON but not a pickdone backup dump (no backup.todoState/categoryState segments found)', 'SNAPSHOT_INVALID')
  }
  // schemaV guard, same contract as the restore side (dbRecovery.parseSegment / applyRestoreDump):
  // a segment written by a NEWER app version must not be misread by this (older) CLI. Covers the
  // whole versioned segment set (adversarial round): todoState/categoryState (counted here) plus
  // filterState/planState/habitsState (restored by the App from the same dump).
  for (const key of ['todoState', 'categoryState', 'filterState', 'planState', 'habitsState']) {
    const seg = parseSeg(key)
    if (seg && Number(seg.schemaV || 1) > 1) {
      throw new lib.CliError(`snapshot ${key}.schemaV=${seg.schemaV} is newer than this CLI supports — upgrade the App and restore from its Settings -> Backup`, 'SNAPSHOT_FUTURE')
    }
  }
  // Summarize whatever the JSON exposes (schema tolerant; legacy flat shapes keep working)
  const summary = {
    file,
    todos: todoState
      ? (Array.isArray(todoState.todoList) ? todoState.todoList.length : 0) + (Array.isArray(todoState.recycleList) ? todoState.recycleList.length : 0)
      : Array.isArray(snap.todos) ? snap.todos.length
        : Array.isArray(snap.todoList) ? snap.todoList.length
          : Array.isArray(snap) ? snap.length : null,
    categories: catState
      ? (Array.isArray(catState.list) ? catState.list.length : 0)
      : Array.isArray(snap.categories) ? snap.categories.length : null,
    segments: snap && snap.backup && typeof snap.backup === 'object' ? Object.keys(snap.backup).length : null,
    savedAt: snap.savedAt || snap.createTime || snap.time || (todoState && todoState.todayTimestamp) || null
  }
  if (opts.json) return emit({ ...summary, guide: 'Open the App: Settings -> Backup -> Restore from snapshot, then select this file.' })
  console.log('Snapshot OK (valid JSON): ' + file)
  if (summary.segments != null) console.log(`  backup segments: ${summary.segments}`)
  if (summary.todos != null) console.log(`  tasks: ${summary.todos}`)
  if (summary.categories != null) console.log(`  categories: ${summary.categories}`)
  if (summary.savedAt) console.log(`  savedAt: ${dayjs(summary.savedAt).format('YYYY-MM-DD HH:mm:ss')}`)
  console.log('')
  console.log('The CLI does not replace the database (the DB file is encrypted with db.key and must be restored by the App).')
  console.log('To restore: open the App -> Settings -> Backup -> Restore from snapshot, and select this file.')
  return
}
