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
  const file = bootRedirectPath()
  const tmp = file + '.tmp-' + process.pid
  fs.writeFileSync(tmp, JSON.stringify({ userDataDir: dir }, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, file)
}

/** Clear the boot file (back to the default userData). Missing file is already clear. */
function clearBootRedirect () {
  try { fs.rmSync(bootRedirectPath(), { force: true }) } catch (e) { /* best-effort */ }
}

/** Minimal migration set: what MUST move for the app to keep its data. logs/ is deliberately
 *  excluded (rebuildable diagnostics); lockfile/wal/shm are runtime artifacts that must NOT be
 *  carried over while a handle could exist. Every entry is conditional: only files that exist
 *  in the source are copied (first launch may lack db.key/config.json/backups entirely). */
function requiredFiles (srcDir) {
  const files = []
  for (const name of ['todos.db', 'todos.db-wal', 'todos.db-shm', 'db.key', 'config.json', 'cli-audit.jsonl']) {
    if (fs.existsSync(path.join(srcDir, name))) files.push(name)
  }
  if (fs.existsSync(path.join(srcDir, 'backups')) && fs.statSync(path.join(srcDir, 'backups')).isDirectory()) files.push('backups')
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
  if (t === cur) return { ok: false, reason: 'target equals the current data directory' }
  if (isInside(t, cur)) return { ok: false, reason: 'target is inside the current data directory' }
  let st = null
  try { st = fs.statSync(t) } catch (e) { /* not existing yet — fine */ }
  if (st && !st.isDirectory()) return { ok: false, reason: 'target exists and is not a directory' }
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

function copyDirRecursive (src, dest) {
  fs.mkdirSync(dest, { recursive: true })
  let n = 0
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name)
    const d = path.join(dest, entry.name)
    if (entry.isDirectory()) n += copyDirRecursive(s, d)
    else { fs.copyFileSync(s, d); n++ }
  }
  return n + 1 // count the dir itself so source/target tree shapes must match
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

/**
 * Synchronous migration. PRECONDITION: the caller has closed the DB handle (better-sqlite3's
 * close checkpoints TRUNCATEs the WAL and removes -wal/-shm); this function assumes the source
 * files are static. On ANY failure the only deletions are files this call wrote into the
 * target — the source stays byte-identical, which IS the rollback. On success the boot file
 * is written so the NEXT launch picks the new dir up.
 */
function migrateData (srcDir, targetDir, opts) {
  const v = validateTarget(targetDir, srcDir, opts)
  if (!v.ok) return { ok: false, error: v.reason }
  const t = v.target
  const written = [] // every target path this call created — the ONLY things we may delete on failure
  const names = requiredFiles(srcDir)
  let stash = new Map()
  try {
    fs.mkdirSync(t, { recursive: true })
    stash = stashCollisions(t, names) // pre-existing target content the copy will overwrite
    for (const name of names) {
      const s = path.join(srcDir, name)
      const d = path.join(t, name)
      if (name === 'backups') { copyDirRecursive(s, d); written.push(d) }
      else { fs.copyFileSync(s, d); written.push(d) }
    }
    // Post-copy verification: db non-empty, key present, backups tree shape identical.
    const dbSt = fs.existsSync(path.join(t, 'todos.db')) ? fs.statSync(path.join(t, 'todos.db')) : null
    if (!dbSt || dbSt.size <= 0) throw new Error('verification failed: target todos.db missing or empty')
    if (!fs.existsSync(path.join(t, 'db.key'))) throw new Error('verification failed: target db.key missing')
    if (fs.existsSync(path.join(srcDir, 'backups')) &&
        countFsObjects(path.join(srcDir, 'backups')) !== countFsObjects(path.join(t, 'backups'))) {
      throw new Error('verification failed: backups tree mismatch')
    }
  } catch (e) {
    for (const p of written) {
      try { fs.rmSync(p, { recursive: true, force: true }) } catch (e2) { /* best-effort cleanup */ }
    }
    restoreCollisions(stash) // put back any pre-existing target content the copy overwrote
    return { ok: false, error: String((e && e.message) || e) }
  }
  try { writeBootRedirect(t) } catch (e) {
    return { ok: false, error: 'copied but failed to write the boot redirect file: ' + String((e && e.message) || e) }
  }
  return { ok: true, target: t }
}

module.exports = {
  bootRedirectPath, readBootRedirect, writeBootRedirect, clearBootRedirect,
  requiredFiles, validateTarget, migrateData, volumeFreeBytes,
  MIN_FREE_BYTES
}
