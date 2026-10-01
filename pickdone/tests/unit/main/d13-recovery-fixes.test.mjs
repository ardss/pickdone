/* D13 fix-wave regression tests (dbRecovery), fixes 2 + 14:
 *   fix 2  the recovery-pending sentinel outranks the ENCRYPTED-db decrypt probe exactly like it
 *          outranks the plaintext healthy-header guard: a post-crash re-initialized encrypted
 *          empty shell (db.key present, fresh DB decrypts) used to answer 'transient' forever,
 *          leaving the user on an empty DB with an unconsumed JSON snapshot. Without the
 *          sentinel the probe verdict is unchanged (guard stays conservative).
 *   fix 14 the quarantine loop renames the SIDECARS first and the main DB LAST — a mid-loop
 *          rename failure can no longer leave todos.db MISSING with a live -wal beside it (the
 *          next init then created a fresh empty DB and recovery never re-fired).
 * Run: node --test tests/unit/main/d13-recovery-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const dbRecovery = require('../../../src/main/dbRecovery.cjs')
const Database = require('../../../vendor/better-sqlite3-multiple-ciphers')

/** Fresh sandbox with a FRESH parent per test (criticalBackupPath scans <parent>/backups). */
function sandbox () {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'd13-recovery-'))
  const ud = path.join(parent, 'ud')
  fs.mkdirSync(ud)
  return ud
}

function writeParseableBackup (ud) {
  fs.writeFileSync(path.join(ud, 'critical-state-backup.json'), JSON.stringify({
    backup: { todoState: JSON.stringify({ todoList: [{ taskId: 't1' }], recycleList: [] }) }
  }))
}

test('fix 2: encrypted empty shell + sentinel + parseable JSON → JSON restore replay (was transient forever)', () => {
  const ud = sandbox()
  writeParseableBackup(ud)
  // A real ENCRYPTED empty shell: ciphertext header (no SQLite magic) + decryptable with db.key
  const key = 'a'.repeat(64)
  const dbPath = path.join(ud, 'todos.db')
  const d = new Database(dbPath)
  d.pragma(`key='${key}'`)
  d.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')
  d.close()
  fs.writeFileSync(path.join(ud, 'db.key'), key + '\n')
  // baseline: no sentinel → the decrypt probe says healthy, nothing is renamed
  const before = dbRecovery.attemptDbRecovery(ud, null)
  assert.equal(before.source, 'transient', 'without the sentinel the probe guard stays conservative')
  assert.equal(fs.existsSync(dbPath), true, 'baseline: the db file survives')
  // with the sentinel: the empty shell is quarantined and the JSON replay is armed
  assert.equal(dbRecovery.markRecoveryPending(ud, { reason: 'json-restore-unconsumed' }), true)
  const after = dbRecovery.attemptDbRecovery(ud, null)
  assert.equal(after.source, 'json', 'red before the fix: the encrypted branch answered transient forever')
  assert.equal(fs.existsSync(dbPath), false, 'the empty shell was quarantined aside')
})

test('fix 2: sentinel + encrypted db but NO parseable JSON → still transient (conservative)', () => {
  const ud = sandbox()
  fs.writeFileSync(path.join(ud, 'critical-state-backup.json'), '{torn')
  const key = 'b'.repeat(64)
  const dbPath = path.join(ud, 'todos.db')
  const d = new Database(dbPath)
  d.pragma(`key='${key}'`)
  d.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)')
  d.close()
  fs.writeFileSync(path.join(ud, 'db.key'), key)
  assert.equal(dbRecovery.markRecoveryPending(ud, {}), true)
  const r = dbRecovery.attemptDbRecovery(ud, null)
  assert.equal(r.source, 'transient', 'no usable snapshot → no replay, probe guard stands')
  assert.equal(fs.existsSync(dbPath), true)
})

test('fix 14: a failed -wal quarantine leaves todos.db IN PLACE (sidecars renamed first)', () => {
  const ud = sandbox()
  writeParseableBackup(ud)
  // corrupt main db + a live wal; garbage headers so the healthy-header/decrypt guards stand down
  const dbPath = path.join(ud, 'todos.db')
  fs.writeFileSync(dbPath, 'garbage-not-sqlite')
  fs.writeFileSync(dbPath + '-wal', 'garbage-wal')
  const origRename = fs.renameSync
  fs.renameSync = (src, dst) => {
    if (String(src).endsWith('-wal')) throw new Error('EBUSY: wal held by AV')
    return origRename(src, dst)
  }
  try {
    const r = dbRecovery.attemptDbRecovery(ud, null)
    assert.equal(r.source, 'error', 'the rename failure aborts with a structured error')
    assert.equal(fs.existsSync(dbPath), true,
      'red before the fix: the main DB was renamed FIRST and left missing while the -wal lived on')
  } finally { fs.renameSync = origRename }
})

test('fix 14: healthy path still quarantines all three files (order change is behavior-neutral)', () => {
  const ud = sandbox()
  writeParseableBackup(ud)
  const dbPath = path.join(ud, 'todos.db')
  fs.writeFileSync(dbPath, 'garbage-not-sqlite')
  fs.writeFileSync(dbPath + '-wal', 'wal')
  fs.writeFileSync(dbPath + '-shm', 'shm')
  const r = dbRecovery.attemptDbRecovery(ud, null)
  assert.equal(r.source, 'json')
  assert.equal(fs.existsSync(dbPath), false)
  assert.equal(fs.existsSync(dbPath + '-wal'), false)
  assert.equal(fs.existsSync(dbPath + '-shm'), false)
})
