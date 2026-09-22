/** Durable atomic file write (main-ipc-2 fsync fix, 2026-09-22).
 *  Plain Node, no electron — requireable from node --test.
 *
 *  Problem: every critical atomic write (the encryption db.key around the encrypted-DB rename,
 *  disaster-recovery JSON, config.json) used writeFileSync + renameSync. Neither call fsyncs, so
 *  after a power cut the OS cache may hold the data while the RENAME (a metadata operation that
 *  can hit disk earlier) is already persistent — e.g. an encrypted todos.db on disk with db.key
 *  still only in memory = the library is unrecoverable. The order guarantee the comments promise
 *  ("write db.key to disk before the pragma / before the rename") was never actually enforced at
 *  the persistence layer.
 *
 *  writeFileDurable: write tmp → fsync(file fd) → rename → best-effort fsync(parent dir).
 *  Directory fsync is POSIX-only; on Windows the dir open fails and is ignored (renameSync on
 *  NTFS is metadata-journaled, the file-data fsync above is the load-bearing part). On any
 *  failure the tmp residue is removed and the error rethrown.
 *
 *  fsMod is injectable so unit tests can keep driving failure injection through the same entry
 *  point (existing backup/config-store suites). A minimal fs-like fake without openSync falls
 *  back to the path-based writeFileSync (no fsync — only ever used by those fakes). */
const fs = require('fs')
const path = require('path')

function writeFileDurable (file, data, fsMod = fs) {
  const tmp = file + '.dtmp'
  let fd = null
  try {
    if (typeof fsMod.openSync === 'function') {
      fd = fsMod.openSync(tmp, 'w')
      fsMod.writeFileSync(fd, data)
      // The load-bearing durability step: data hits the disk BEFORE the rename below.
      fsMod.fsyncSync(fd)
      fsMod.closeSync(fd)
      fd = null
    } else {
      // Test-fake fallback: path-based write without fsync (fakes exist to inject failures).
      fsMod.writeFileSync(tmp, data)
    }
    fsMod.renameSync(tmp, file)
  } catch (err) {
    try { (fsMod.rmSync || fs.rmSync)(tmp, { force: true }) } catch { /* best-effort */ }
    throw err
  } finally {
    if (fd !== null) { try { fsMod.closeSync(fd) } catch { /* already closed */ } }
  }
  // Best-effort durability of the rename itself (POSIX). Windows cannot openSync a directory —
  // ignore that failure; the tmp-file fsync already ordered the data before the rename.
  try {
    const dirFd = fs.openSync(path.dirname(file), 'r')
    try { fs.fsyncSync(dirFd) } finally { fs.closeSync(dirFd) }
  } catch { /* platform without directory fsync */ }
}

module.exports = { writeFileDurable }
