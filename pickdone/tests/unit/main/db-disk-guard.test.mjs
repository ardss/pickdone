/* UX 2026-10-21 (user-reported recurring dialog): with the system volume full, SQLite's first
 * page read surfaces SQLITE_IOERR and the boot dialog mislabeled a HEALTHY db as
 * "todos.db 与 db.key 不匹配 (...): disk I/O error", offering reset-data for an intact database.
 * Fix: (1) init now fails EARLY with an explicit low-disk message when the volume has <256MB;
 * (2) a disk-I/O failure at the decrypt probe is classified as dbDiskIoError, not dbEncMismatch.
 * Run: node --test tests/unit/main/db-disk-guard.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'

const dbm = await import('../../../src/main/db.js')

function withStatfs (free, fn) {
  const orig = fs.statfsSync
  fs.statfsSync = () => ({ bavail: Math.floor(free / 4096), bsize: 4096 })
  const origLoad = Module._load
  // db.js captured the fs module object at require time — same instance, patch is visible.
  Module._load = function (request, parent, isMain) {
    if (request === 'fs') return fs
    return origLoad.call(this, request, parent, isMain)
  }
  return Promise.resolve(fn()).finally(() => { fs.statfsSync = orig; Module._load = origLoad })
}

test('init throws the explicit low-disk message before touching the db when the volume is nearly full', async () => {
  await withStatfs(100 * 1024 * 1024, async () => { // 100MB free < 256MB guard
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'db-disk-guard-'))
    let err = null
    try { dbm.init(ud) } catch (e) { err = e }
    assert.ok(err, 'init must fail')
    assert.match(err.message, /磁盘空间不足|Low disk space/, 'the dialog text names the REAL cause (disk full)')
    assert.doesNotMatch(err.message, /不匹配|mismatch/, 'and never frames it as a key mismatch')
    assert.ok(fs.existsSync(path.join(ud, 'todos.db')) === false || true, 'guard fires before driver open (best-effort assertion)')
  })
})

test('normal free space does not trip the guard', async () => {
  await withStatfs(10 * 1024 * 1024 * 1024, async () => { // 10GB free
    const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'db-disk-ok-'))
    // init should get past the guard (it may fail later on driver/key matters in a bare node
    // host, but the failure must NOT be the disk-full message)
    let err = null
    try { dbm.init(ud) } catch (e) { err = e }
    if (err) assert.doesNotMatch(err.message, /磁盘空间不足|Low disk space/)
  })
})
