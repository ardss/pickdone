'use strict'
/**
 * data-location.cjs — configurable data storage location + safe migration (pure node, no
 * electron: unit-testable under plain node, same module class as dbRecovery.cjs).
 *
 * Problem shape: config.json lives INSIDE userData, so it cannot redirect its own directory.
 * The redirect needs a boot file in a location that never moves with userData — a dot-file in
 * the user's home directory. Priority (wired in src/main/index.js):
 *   TODO_USER_DATA_DIR env (test isolation, highest, unchanged semantics)
 *   > boot file (this module) > electron's default userData.
 *
 * Migration doctrine: the SOURCE directory is never deleted or modified — the copy itself is
 * the rollback. A failed migration only removes files THIS migration wrote into the target,
 * then the caller re-inits the DB against the untouched source dir and the app keeps running.
 */
const fs = require('fs')
const os = require('os')
const path = require('path')

// Mirrors db.js initInner's low-disk guard philosophy, but stricter (512MB): the target volume
// must have room for the db + WAL checkpoint + backups + future growth.
const MIN_FREE_BYTES = 512 * 1024 * 1024

/** Fixed boot-file path: a dot-file in the user's home — stable across userData relocations
 *  and independent of any movable directory (AppData/Vendor dirs may themselves be redirected). */
function bootRedirectPath () {
  return path.join(os.homedir(), '.pickdone-data-location.json')
}

/** Read the boot redirect. Returns the dir ONLY when: valid JSON, userDataDir is an absolute
 *  path, and the directory exists on disk. Anything else (missing file, corrupt JSON, relative
 *  path, vanished dir) → null, so a broken boot file can never brick the app. */
function readBootRedirect () {
  try {
    const j = JSON.parse(fs.readFileSync(bootRedirectPath(), 'utf8'))
    const d = j && j.userDataDir
    if (typeof d === 'string' && d && path.isAbsolute(d) && fs.existsSync(d)) return d
  } catch (e) { /* missing / unreadable / bad JSON → no redirect */ }
  return null
}

/** Atomic write (tmp + rename): a crash mid-write must never leave a half-written boot file
 *  (a truncated JSON reads back as null above, but atomicity keeps the previous good value). */
function writeBootRedirect (dir) {
  if (!dir || typeof dir !== 'string' || !path.isAbsolute(dir)) throw new Error('boot redirect dir must be an absolute path')
  // Durable write (M2a P1): tmp → fsync → rename via durable-fs (same contract as
  // dbRecovery's markRecoveryPending / main-ipc-2 fix). The boot file decides WHERE every
  // byte of user data lives — a power cut between OS cache and rename used to be able to
  // publish the rename while the content was still only in cache. On any failure
  // writeFileDurable removes the tmp residue and rethrows (err.dtmpPath carries the tmp).
  require('./durable-fs').writeFileDurable(
    bootRedirectPath(),
    Buffer.from(JSON.stringify({ userDataDir: dir }, null, 2) + '\n', 'utf8')
  )
}

/** Clear the boot file (back to the default userData). Missing file is already clear. */
function clearBootRedirect () {
  try { fs.rmSync(bootRedirectPath(), { force: true }) } catch (e) { /* best-effort */ }
}

/** Minimal migration set: what MUST move for the app to keep its data. logs/ is deliberately
 *  excluded (rebuildable diagnostics); lockfile/wal/shm are runtime artifacts that must NOT be
 *  carried over while a handle could exist. Every entry is conditional: only files that exist
 *  in the source are copied (first launch may lack db.key/config.json/backups entirely).
 *  B#2/#3: backups/ is joined by files/ (attachment dir, same whole-tree semantics) and by
 *  allowed-backup-dirs.json (external backup roots whitelist) — both were silently dropped. */
function requiredFiles (srcDir) {
  const files = []
  // M2a (P3): recovery-pending.json (Sync-4/Sync-17 sentinel), renderer-crash-relaunch-count.json
  // and the legacy root critical-state-backup.json are all recovery-critical state — a migration
  // that dropped them lost the crash-recovery chain. Conditional like the rest: first launches
  // without them must not mint empty copies.
  for (const name of ['todos.db', 'todos.db-wal', 'todos.db-shm', 'db.key', 'config.json', 'cli-audit.jsonl', 'allowed-backup-dirs.json', 'recovery-pending.json', 'renderer-crash-relaunch-count.json', 'critical-state-backup.json']) {
    if (fs.existsSync(path.join(srcDir, name))) files.push(name)
  }
  for (const d of ['backups', 'files']) {
    const p = path.join(srcDir, d)
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) files.push(d)
  }
  return files
}

/** Best-effort free-bytes probe; returns null when statfs is unsupported for the volume. */
function volumeFreeBytes (dir) {
  try { const st = fs.statfsSync(dir); return st.bavail * st.bsize } catch (e) { return null }
}

function isInside (child, parent) {
  const c = path.resolve(child)
  const p = path.resolve(parent)
  return c.startsWith(p + path.sep) || c === p
}

// C#13: NTFS/Windows path comparison is case-insensitive — 'C:\Data' and 'c:\data' resolve to
// the SAME directory, so equality/containment checks must fold case there or a casing variant
// of the current dir slips past every guard. Folding is win32-only (POSIX paths are case-sensitive).
function foldCase (p) {
  return process.platform === 'win32' ? String(p).toLowerCase() : p
}

/** Target validation. Returns { ok:true } or { ok:false, reason }. opts.freeBytes lets tests
 *  inject the volume probe; opts.probeWrite skips nothing — writability is always probed live.
 *  A target that already holds a VALID data dir (todos.db + db.key) is allowed: that is the
 *  "switch back to the previous location" case, not a conflict. */
function validateTarget (targetDir, currentDir, opts) {
  const o = opts || {}
  if (!targetDir || typeof targetDir !== 'string') return { ok: false, reason: 'target dir is required' }
  if (!path.isAbsolute(targetDir)) return { ok: false, reason: 'target must be an absolute path: ' + targetDir } // check the RAW input — resolve() would silently absolutize 'relative' against cwd
  const t = path.resolve(targetDir)
  const cur = path.resolve(currentDir)
  if (foldCase(t) === foldCase(cur)) return { ok: false, reason: 'target equals the current data directory' }
  if (isInside(foldCase(t), foldCase(cur))) return { ok: false, reason: 'target is inside the current data directory' }
  // Ancestor rejection: a target that CONTAINS the current dir would have the copy write into
  // the very tree being copied (source walk sees the target's partial state) — never feasible.
  if (isInside(foldCase(cur), foldCase(t))) return { ok: false, reason: 'target contains the current data directory' }
  let st = null
  try { st = fs.statSync(t) } catch (e) { /* not existing yet — fine */ }
  if (st && !st.isDirectory()) return { ok: false, reason: 'target exists and is not a directory' }
  // M2a (P1) realpath containment re-check (protocol.js F3 shape): a junction/symlink target can
  // pass every LEXICAL check above while RESOLVING into the source subtree (OneDrive placeholder
  // dirs, user-created links). Migration would then copy the source INTO itself, and the failure
  // cleanup's rmSync — which deletes everything the migration "wrote into the target" — would
  // delete the user's real source data. Resolve both sides to their real paths (when resolvable)
  // and re-run the bidirectional containment on those; a dangling link fails statSync above.
  if (st) {
    try {
      const rt = fs.realpathSync(t)
      let rc = cur
      try { rc = fs.realpathSync(cur) } catch { /* current dir unreadable → compare against its lexical path */ }
      if (foldCase(rt) === foldCase(rc)) return { ok: false, reason: 'target resolves to the current data directory through a link (junction/symlink)' }
      if (isInside(foldCase(rt), foldCase(rc))) return { ok: false, reason: 'target resolves inside the current data directory through a link (junction/symlink)' }
      if (isInside(foldCase(rc), foldCase(rt))) return { ok: false, reason: 'target resolves around (contains) the current data directory through a link (junction/symlink)' }
    } catch (e) { /* realpath unavailable → the lexical checks above stand */ }
  }
  if (st) {
    const empty = fs.readdirSync(t).length === 0
    if (!empty) {
      const validData = fs.existsSync(path.join(t, 'todos.db')) && fs.existsSync(path.join(t, 'db.key'))
      if (!validData) return { ok: false, reason: 'target exists and is neither empty nor a valid data directory (todos.db + db.key)' }
    }
  }
  // Writability probe: real write + delete, not an access()-mode check (ACL/AV realities).
  // The probe also materializes a not-yet-existing target (a fresh location starts empty).
  try {
    fs.mkdirSync(t, { recursive: true })
    const probe = path.join(t, '.pickdone-write-probe-' + Date.now())
    fs.writeFileSync(probe, 'ok')
    fs.rmSync(probe, { force: true })
  } catch (e) { return { ok: false, reason: 'target is not writable: ' + ((e && e.message) || e) } }
  const free = (o.freeBytes != null) ? o.freeBytes : volumeFreeBytes(t)
  if (free != null && free < MIN_FREE_BYTES) return { ok: false, reason: 'target volume has insufficient free space (' + Math.floor(free / 1024 / 1024) + ' MB < ' + Math.floor(MIN_FREE_BYTES / 1024 / 1024) + ' MB)' }
  return { ok: true, target: t }
}

const YIELD_EVERY = 8 // fs objects per event-loop yield — keeps the main process responsive
                     // (progress IPC + window events flow) during a large files/ copy

/** Yield to the event loop; called every YIELD_EVERY copied objects in migrateData. */
function tick () { return new Promise(resolve => setImmediate(resolve)) }

/** Pre-count fs objects of a migration entry (file=1; dir=tree incl. the dir itself). */
function entryObjectCount (srcDir, name) {
  const p = path.join(srcDir, name)
  if (!fs.existsSync(p)) return 0
  const st = fs.statSync(p)
  return st.isDirectory() ? countFsObjects(p) : 1
}

async function copyDirRecursive (src, dest, onFile, counter) {
  fs.mkdirSync(dest, { recursive: true })
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) await copyDirRecursive(s, d, onFile, counter)
    else {
      fs.copyFileSync(s, d)
      counter.n++
      if (onFile && counter.n % YIELD_EVERY === 0) {
        onFile(counter.n)
        await tick()
      }
    }
  }
  counter.n++ // count the dir itself so source/target tree shapes must match
}

function countFsObjects (dir) {
  let n = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    n += entry.isDirectory() ? countFsObjects(path.join(dir, entry.name)) : 1
  }
  return n
}

/** Stash the content of target paths the copy is about to OVERWRITE (the switch-back case:
 *  target already holds a valid todos.db/db.key/backups). Returned as { path -> Buffer|tree }.
 *  Without this, a post-copy verification failure's cleanup would delete the user's PRIOR
 *  data — copyFileSync overwrites, cleanup only knows "written here". */
function stashCollisions (t, names) {
  const stash = new Map()
  const stashPath = (p) => {
    const st = fs.existsSync(p) ? fs.statSync(p) : null
    if (!st) return
    if (st.isDirectory()) {
      const tree = {}
      const collect = (d, prefix) => {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const key = prefix + e.name
          if (e.isDirectory()) collect(path.join(d, e.name), key + '/')
          else tree[key] = fs.readFileSync(path.join(d, e.name))
        }
      }
      collect(p, '')
      stash.set(p, { dir: true, tree })
    } else {
      stash.set(p, { dir: false, buf: fs.readFileSync(p) })
    }
  }
  for (const name of names) stashPath(path.join(t, name))
  return stash
}

function restoreCollisions (stash) {
  for (const [p, v] of stash) {
    try {
      if (v.dir) {
        fs.rmSync(p, { recursive: true, force: true })
        fs.mkdirSync(p, { recursive: true })
        for (const [key, buf] of Object.entries(v.tree)) {
          const f = path.join(p, key)
          fs.mkdirSync(path.dirname(f), { recursive: true })
          fs.writeFileSync(f, buf)
        }
      } else {
        fs.writeFileSync(p, v.buf)
      }
    } catch (e) { /* best-effort restore */ }
  }
}

/** Stat identity of a file (size + mtimeMs) — the torn-DB probe below compares two of these. */
function statIdentity (p) {
  const s = fs.statSync(p)
  return s.size + ':' + s.mtimeMs
}

/** Read the boot redirect WITH its failure reason (index.js uses this to tell the user WHY the
 *  configured location was not honored — a vanished target dir used to fall back silently).
 *  status: 'ok' | 'missing' (valid JSON, absolute path, dir gone) | 'invalid' (bad JSON/relative)
 *  | 'none' (no boot file). */
function readBootRedirectState () {
  let raw = null
  try { raw = fs.readFileSync(bootRedirectPath(), 'utf8') } catch (e) { return { status: 'none', dir: null } }
  let d = null
  try {
    const j = JSON.parse(raw)
    d = j && j.userDataDir
  } catch (e) { return { status: 'invalid', dir: null } }
  if (typeof d !== 'string' || !d || !path.isAbsolute(d)) return { status: 'invalid', dir: null }
  if (!fs.existsSync(d)) return { status: 'missing', dir: d }
  return { status: 'ok', dir: d }
}

let relocationPending = false // B#5: in-process gate for the migrate→relaunch window (see getRelocationPending)

/**
 * Asynchronous migration. PRECONDITION: the caller has closed the DB handle (better-sqlite3's
 * close checkpoints TRUNCATEs the WAL and removes -wal/-shm); this function assumes the source
 * files are static. On ANY failure the only deletions are files this call wrote into the
 * target — the source stays byte-identical, which IS the rollback. On success the boot file
 * is written so the NEXT launch picks the new dir up.
 *
 * opts.onProgress(p) — p is { phase: 'copy', done, total } during the copy (done advances every
 * YIELD_EVERY objects; the event loop yields alongside, so progress IPC and window events keep
 * flowing) and { phase: 'verify' } / { phase: 'boot' } at the tail.
 */
let migrationInFlight = false // M2a (P2): reentry gate — two overlapping migrations would race on the boot file and the copy

/** Reentry gate + in-flight flag wrapper around the migration body (see below). A second
 *  data:relocate while one is running (or while a finished one awaits relaunch —
 *  getRelocationPending) is refused outright instead of racing it. */
async function migrateData (srcDir, targetDir, opts = {}) {
  if (migrationInFlight || getRelocationPending()) {
    return { ok: false, error: 'migration already in progress' }
  }
  migrationInFlight = true
  try {
    return await migrateDataInner(srcDir, targetDir, opts)
  } finally {
    migrationInFlight = false // relocationPending (set on success) intentionally outlives this
  }
}

async function migrateDataInner (srcDir, targetDir, opts = {}) {
  const onProgress = typeof opts.onProgress === 'function' ? opts.onProgress : null
  const report = p => { try { if (onProgress) onProgress(p) } catch (e) { /* progress is best-effort */ } }
  // Torn-DB defense #1: after a clean close the WAL/SHM are GONE. A resurrected NON-EMPTY one
  // means an external writer (CLI process) re-opened the db between close() and here — the
  // copy would capture a torn snapshot. (An empty residual file is inert and may copy.)
  for (const side of ['-wal', '-shm']) {
    const p = path.join(srcDir, 'todos.db' + side)
    if (fs.existsSync(p) && fs.statSync(p).size > 0) {
      return { ok: false, error: 'source database appears to be in use by another process (non-empty todos.db' + side + ')' }
    }
  }
  const dbSrc = path.join(srcDir, 'todos.db')
  let dbIdentityBefore
  try { dbIdentityBefore = statIdentity(dbSrc) } catch (e) {
    return { ok: false, error: 'source todos.db is missing' }
  }
  const v = validateTarget(targetDir, srcDir, opts)
  if (!v.ok) return { ok: false, error: v.reason }
  const t = v.target
  const written = [] // every target path this call created — the ONLY things we may delete on failure
  const names = requiredFiles(srcDir)
  let stash = new Map()
  try {
    fs.mkdirSync(t, { recursive: true })
    stash = stashCollisions(t, names) // pre-existing target content the copy will overwrite
    // Progress denominator: pre-count every fs object the copy will create. A source that
    // GROWS mid-copy would skew done/total slightly — harmless (progress only) and the
    // stat-identity check below still fails the whole migration for the db itself.
    let total = 0
    for (const name of names) total += entryObjectCount(srcDir, name)
    const counter = { n: 0 }
    for (const name of names) {
      const s = path.join(srcDir, name)
      const d = path.join(t, name)
      if (name === 'backups' || name === 'files') { await copyDirRecursive(s, d, n => report({ phase: 'copy', done: n, total }), counter); written.push(d) }
      else { fs.copyFileSync(s, d); counter.n++; written.push(d); if (counter.n % YIELD_EVERY === 0) await tick() }
    }
    report({ phase: 'copy', done: total, total })
    // Torn-DB defense #2: the source db's stat identity must be IDENTICAL before/after the copy —
    // a change mid-flight means a concurrent writer advanced it while we snapshotted it.
    if (statIdentity(dbSrc) !== dbIdentityBefore) throw new Error('source database changed during the copy (concurrent writer)')
    // Post-copy verification: db non-empty, key present, dir trees shape-identical.
    report({ phase: 'verify' })
    const dbSt = fs.existsSync(path.join(t, 'todos.db')) ? fs.statSync(path.join(t, 'todos.db')) : null
    if (!dbSt || dbSt.size <= 0) throw new Error('verification failed: target todos.db missing or empty')
    if (!fs.existsSync(path.join(t, 'db.key'))) throw new Error('verification failed: target db.key missing')
    for (const d of ['backups', 'files']) {
      if (fs.existsSync(path.join(srcDir, d)) &&
          countFsObjects(path.join(srcDir, d)) !== countFsObjects(path.join(t, d))) {
        throw new Error('verification failed: ' + d + ' tree mismatch')
      }
    }
    // Boot write lives INSIDE the same rollback contract: a failure here must also undo the
    // copy (otherwise the target holds a full data dir with NO redirect — and cleanup would
    // previously have skipped it, orphaning content next to the user's prior data).
    report({ phase: 'boot' })
    writeBootRedirect(t)
    relocationPending = true // B#5: the window until relaunch — backup writers consult getRelocationPending()
  } catch (e) {
    for (const p of written) {
      try { fs.rmSync(p, { recursive: true, force: true }) } catch (e2) { /* best-effort cleanup */ }
    }
    restoreCollisions(stash) // put back any pre-existing target content the copy overwrote
    return { ok: false, error: String((e && e.message) || e) }
  }
  return { ok: true, target: t }
}

/** B#5: true from a successful migrateData until process exit (relaunch). In-process backup
 *  writers (auto-backup, backup-dir mutation) must refuse while this is set: their write would
 *  land in the OLD dir after the boot file already points at the new one. */
function getRelocationPending () {
  return relocationPending
}

module.exports = {
  bootRedirectPath, readBootRedirect, readBootRedirectState, writeBootRedirect, clearBootRedirect,
  requiredFiles, validateTarget, migrateData, volumeFreeBytes,
  getRelocationPending,
  MIN_FREE_BYTES
}
