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
// Single source for default backup roots (P0 root fix): derivation lives in src/main/backup-dirs.js
// (electron lazy-required there so this pure-Node CLI can require it) — no second copy here.
const { defaultBackupRootCandidates } = require('../src/main/backup-dirs.js')
// Restore-segment registry single source (see the schemaV guard below) — pure fs module,
// no electron at top level, so this pure-Node CLI can require it.
const dbRecovery = require('../src/main/dbRecovery.cjs')

/** maint/d23 P3: CLI-local twin of src/main/backup-dirs.js resolveBackupDir (that module cannot be
 *  required from pure Node — its getApp()/electron-log surface is main-process-only, and this file
 *  already reaches into it only for the dependency-free backup-roots.cjs derivation). Deliberate
 *  twin, documented: same semantics, read-only —
 *   - empty/absent backupDir → the ACTIVE default root (TODO_BACKUP_DIR-aware, backup-roots.cjs [0]);
 *   - a configured dir NOT registered in userData/allowed-backup-dirs.json (only the App's
 *     pick-backup-dir dialog ever appends there) falls back to the default root;
 *   - a symlinked backup dir falls back (the App's symlink-bypass guard, backup-dirs.js:98-107).
 *  Shared by evt-snapshot writing (cli/lib.js) and restore discovery (this module) so the CLI's
 *  snapshot dir can no longer split from the App's. */
function resolveCliBackupDir (configured, userDataDirPath) {
  const fallback = path.resolve(defaultBackupRootCandidates(userDataDirPath)[0])
  const raw = String(configured || '').trim()
  if (!raw) return fallback
  const resolved = path.resolve(raw)
  if (resolved === fallback) return fallback
  let allowed = new Set()
  try {
    allowed = new Set((JSON.parse(fs.readFileSync(path.join(userDataDirPath, 'allowed-backup-dirs.json'), 'utf8')) || []).map(d => path.resolve(d)))
  } catch { /* unreadable whitelist = nothing registered (first-run state) */ }
  if (!allowed.has(resolved)) return fallback
  try {
    if (fs.lstatSync(resolved).isSymbolicLink()) return fallback
  } catch { /* not created yet — the App's resolveBackupDir mkdirs it; keep the choice */ }
  return resolved
}

module.exports = function restoreBackup ({ opts, lib, emit }) {
  // D20-DOMB6 (2026-10-02): discovery used to match only auto-* while the App restores BOTH
  // families (handlers/backup.js accepts /^(auto|evt)-/) — evt-* pre-delete event snapshots were
  // invisible to the CLI's discover/validate guide. D20-DOMB14: the filter is now the STRICT
  // stamp regexes from src/main/autoBackup.js (single source) — collision-suffixed names
  // ("...json (1)" style copies) fail the regexes and no longer sort in as epoch-0 stamps.
  const { RE_AUTO, RE_EVT } = require('../src/main/autoBackup.js')
  const SNAP_TEST = f => RE_AUTO.test(f) || RE_EVT.test(f)
  // Active default root first (<userData>/backups, or TODO_BACKUP_DIR), then the legacy external
  // parent-of-userData/pickdone-backups kept for old snapshots discovery.
  const defaultRoots = defaultBackupRootCandidates(lib.userDataDir())
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
  // maint/d23 P3: route the user dir through the resolveBackupDir twin — a non-whitelisted or
  // relative backupDir used to be probed raw here while the App wrote to the resolved default
  // root, so discovery missed snapshots. (The default roots already cover the fallback target.)
  const resolvedUser = resolveCliBackupDir(userDir, lib.userDataDir())
  const candidateDirs = [...new Set([...defaultRoots, resolvedUser].filter(Boolean))]
  const listSnapshots = root => {
    try {
      return fs.existsSync(root)
        ? fs.readdirSync(root).filter(SNAP_TEST)
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
    if (!files.length) { console.log(`(no auto-*/evt-*.json snapshots in ${candidateDirs.join(', ')})`); return }
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
  // a segment written by a NEWER app version must not be misread by this (older) CLI. The segment
  // set is DERIVED from dbRecovery's RESTORE_SEGMENTS registry (the single source whose doc comment
  // promises "comment and code can no longer drift") — the previous hand-copied 6-segment literal
  // missed tomatoRecords, so a schemaV=2 tomatoRecords segment passed this CLI's validation while
  // the App's restore refused the dump.
  // restore-schema-gate-three-copies (P3, symptom of "restore gates not single-sourced"): the
  // `> 1` literal here was a third copy of the schema gate (renderer SCHEMA_V / dbRecovery
  // SUPPORTED_SCHEMA_V / this one) — it stayed behind the moment the constant moves. Consume the
  // exported binding so a future bump cannot drift the CLI from the App. (Renderer↔main remain
  // two declarations by necessity: ESM↔CJS across the process boundary.)
  for (const key of dbRecovery.RESTORE_SEGMENT_NAMES) {
    const seg = parseSeg(key)
    if (seg && Number(seg.schemaV || 1) > dbRecovery.SUPPORTED_SCHEMA_V) {
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

// Attached AFTER the function assignment (a property set before it would be lost when
// module.exports is replaced). Consumed by cli/lib.js (evt-snapshot dir) and this module's discovery.
module.exports.resolveBackupDir = resolveCliBackupDir
