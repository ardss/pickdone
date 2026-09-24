/**
 * dw wave5 P2 (2026-09-24) — dbRecovery header guard must not mislabel a HEALTHY ENCRYPTED db.
 * Regression for: attemptDbRecovery only recognized the plaintext 16-byte "SQLite format 3\0"
 * magic, but this repo's steady state is a multiple-ciphers encrypted todos.db (db.js PRAGMA key)
 * whose first page is CIPHERTEXT — so the guard was always false and ANY transient init failure
 * (lock held / AV) renamed the healthy db to .corrupt-<stamp>, quarantined db.key and rolled back
 * to a stale backup, losing every increment after it.
 * Fix: when db.key exists, a read-only decrypt probe (vendor driver + PRAGMA key + sqlite_master
 * read) decides: decryptable = healthy, NO rename/rollback; undecryptable = genuinely corrupt,
 * the recovery path proceeds as before.
 * Run: node --test tests/unit/main/dw5-dbrecovery-encrypted-guard.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { createRequire } from 'module'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const require_ = createRequire(import.meta.url)
const dbRecovery = require_(path.join(ROOT, 'src/main/dbRecovery.cjs'))
const Database = require_(path.join(ROOT, 'vendor/better-sqlite3-multiple-ciphers'))

function tmpUd () {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'dw5-dbrec-'))
}

/** Build a real encrypted todos.db exactly like db.js does: 64-hex key file + PRAGMA key + a table. */
function makeEncryptedDb (ud, keyHex) {
  fs.writeFileSync(path.join(ud, 'db.key'), keyHex + '\n', 'utf8')
  const db = new Database(path.join(ud, 'todos.db'))
  db.pragma(`key='${keyHex}'`)
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
  db.prepare("INSERT INTO meta VALUES ('k', 'v')").run()
  db.close()
}

const KEY = 'a'.repeat(64)

test('P2: transient init failure on a HEALTHY ENCRYPTED db must NOT rename or roll back', () => {
  const ud = tmpUd()
  try {
    makeEncryptedDb(ud, KEY)
    // stale backup sitting next to it — the old bug rolled back to exactly this
    fs.writeFileSync(path.join(ud, 'critical-state-backup.json'), JSON.stringify({ backup: { todoState: { todoList: [], recycleList: [], schemaV: 1 } } }), 'utf8')
    const r = dbRecovery.attemptDbRecovery(ud, () => { throw new Error('SQLITE_BUSY: lock held (simulated transient failure)') })
    assert.ok(r, 'a structured result is returned')
    assert.ok(r.source === 'transient' || r.source === 'retry-ok', `encrypted-but-decryptable db must be treated as transient (got source=${r.source}, label=${r.label})`)
    assert.ok(fs.existsSync(path.join(ud, 'todos.db')), 'the healthy encrypted db is still in place')
    assert.equal(fs.readdirSync(ud).filter(f => f.includes('.corrupt-')).length, 0, 'no .corrupt- quarantine was created')
    assert.ok(fs.existsSync(path.join(ud, 'db.key')), 'db.key was not quarantined')
    // decrypt probe still works → the data really did survive untouched
    const db = new Database(path.join(ud, 'todos.db'))
    db.pragma(`key='${KEY}'`)
    assert.equal(db.prepare("SELECT value FROM meta WHERE key='k'").get().value, 'v')
    db.close()
  } finally { fs.rmSync(ud, { recursive: true, force: true }) }
})

test('P2: a GENUINELY corrupt encrypted db (undecryptable with its key) still recovers', () => {
  const ud = tmpUd()
  try {
    fs.writeFileSync(path.join(ud, 'db.key'), KEY, 'utf8')
    // real garbage: neither plaintext magic nor decryptable ciphertext
    fs.writeFileSync(path.join(ud, 'todos.db'), Buffer.alloc(4096, 0x5a))
    fs.writeFileSync(path.join(ud, 'critical-state-backup.json'), JSON.stringify({ backup: { todoState: { todoList: [{ taskId: 't1' }], recycleList: [], schemaV: 1 } } }), 'utf8')
    const r = dbRecovery.attemptDbRecovery(ud, () => { throw new Error('boom') })
    assert.ok(r && (r.source === 'json' || r.source === 'error'), `undecryptable db proceeds down the recovery path (got source=${r && r.source})`)
    assert.ok(fs.readdirSync(ud).filter(f => f.startsWith('todos.db.corrupt-')).length > 0, 'the corrupt file was quarantined')
  } finally { fs.rmSync(ud, { recursive: true, force: true }) }
})

test('P2: healthy PLAINTEXT header is still protected (pre-existing guard, regression)', () => {
  const ud = tmpUd()
  try {
    fs.writeFileSync(path.join(ud, 'todos.db'), Buffer.concat([Buffer.from('SQLite format 3\x00', 'binary'), Buffer.alloc(100)]))
    const r = dbRecovery.attemptDbRecovery(ud, () => { throw new Error('transient') })
    assert.equal(r.source, 'transient')
    assert.ok(fs.existsSync(path.join(ud, 'todos.db')))
    assert.equal(fs.readdirSync(ud).filter(f => f.includes('.corrupt-')).length, 0)
  } finally { fs.rmSync(ud, { recursive: true, force: true }) }
})

test('P2: encrypted db + transient failure + NO backup sources → transient, nothing touched', () => {
  const ud = tmpUd()
  try {
    makeEncryptedDb(ud, KEY)
    const r = dbRecovery.attemptDbRecovery(ud, () => { throw new Error('lock') })
    assert.equal(r.source, 'transient')
    assert.ok(fs.existsSync(path.join(ud, 'todos.db')))
    assert.ok(fs.existsSync(path.join(ud, 'db.key')))
  } finally { fs.rmSync(ud, { recursive: true, force: true }) }
})

// --- preflightMigrateResidue / sweepPendingDeletes (sunk from index.js whenReady) ---

test('preflight: 无库+有bak+无key = 迁移两步 rename 崩溃现场 → plain-bak 放回,孤儿 WAL 清除', () => {
  const ud = tmpUd()
  try {
    fs.writeFileSync(path.join(ud, 'todos.db.plain-bak'), Buffer.from('SQLite format 3\x00plaintext-bak', 'binary'))
    fs.writeFileSync(path.join(ud, 'todos.db-wal'), 'orphan')
    const changed = dbRecovery.preflightMigrateResidue(ud)
    assert.equal(changed, true)
    assert.ok(fs.existsSync(path.join(ud, 'todos.db')), 'the plaintext bak was restored as todos.db')
    assert.ok(!fs.existsSync(path.join(ud, 'todos.db-wal')), 'the orphan WAL was cleared')
    assert.ok(!fs.existsSync(path.join(ud, 'db.key')))
  } finally { fs.rmSync(ud, { recursive: true, force: true }) }
})

test('preflight: 无库+有bak+有key(用户手删库)→ key 移为 superseded,bak 放回', () => {
  const ud = tmpUd()
  try {
    fs.writeFileSync(path.join(ud, 'todos.db.plain-bak'), 'plaintext-bak')
    fs.writeFileSync(path.join(ud, 'db.key'), KEY)
    dbRecovery.preflightMigrateResidue(ud)
    assert.ok(fs.existsSync(path.join(ud, 'todos.db')))
    assert.ok(!fs.existsSync(path.join(ud, 'db.key')), 'the stale key is out of the way')
    assert.equal(fs.readdirSync(ud).filter(f => f.startsWith('db.key.superseded-')).length, 1)
  } finally { fs.rmSync(ud, { recursive: true, force: true }) }
})

test('preflight: 库存在或 bak 不存在 → no-op', () => {
  const ud = tmpUd()
  try {
    assert.equal(dbRecovery.preflightMigrateResidue(ud), false, 'no bak → no-op')
    fs.writeFileSync(path.join(ud, 'todos.db'), 'x')
    fs.writeFileSync(path.join(ud, 'todos.db.plain-bak'), 'y')
    assert.equal(dbRecovery.preflightMigrateResidue(ud), false, 'db exists → no-op (post-migration bak cleanup happens later, not here)')
    assert.equal(fs.readFileSync(path.join(ud, 'todos.db'), 'utf8'), 'x', 'the live db was not overwritten')
  } finally { fs.rmSync(ud, { recursive: true, force: true }) }
})

test('sweep: pending-delete-<ts>-* 文件被清除,其他文件保留', () => {
  const ud = tmpUd()
  try {
    fs.writeFileSync(path.join(ud, 'pending-delete-123-todos.db'), 'junk')
    fs.mkdirSync(path.join(ud, 'pending-delete-456-dir'))
    fs.writeFileSync(path.join(ud, 'pending-delete-456-dir', 'inner'), 'junk')
    fs.writeFileSync(path.join(ud, 'todos.db'), 'keep')
    const swept = dbRecovery.sweepPendingDeletes(ud)
    assert.equal(swept, 2)
    assert.equal(fs.readdirSync(ud).filter(f => f.startsWith('pending-delete-')).length, 0)
    assert.ok(fs.existsSync(path.join(ud, 'todos.db')))
  } finally { fs.rmSync(ud, { recursive: true, force: true }) }
})
