/**
 * dw-wave6 F20 — encryptedProbe must map a db.key READ-IO FAILURE to 'unknown' (conservative),
 * not to the destructive 'no'.
 * Regression for: `catch { return 'no' }` around the key read. The caller (attemptDbRecovery)
 * already existsSync-gated the key file, so a read failure there is a transient IO problem
 * (AV scan / lock held / sharing violation) — mapping it to 'no' ("genuinely corrupt") sent a
 * HEALTHY encrypted db down the rename+quarantine+stale-backup-rollback chain, re-opening the
 * exact wave5 hole ("healthy encrypted db renamed aside") through a side door.
 * Contract: only a READABLE key that is not 64-hex counts as keyless ('no'); unreadable → 'unknown'.
 * Failure injection: db.key created as a DIRECTORY — existsSync passes, readFileSync throws EISDIR.
 * Run: node --test tests/unit/main/dw6-dbrecovery-probe-conservative.test.mjs
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

const KEY = 'b'.repeat(64)

function makeEncryptedDb (ud, keyHex) {
  fs.writeFileSync(path.join(ud, 'db.key'), keyHex + '\n', 'utf8')
  const db = new Database(path.join(ud, 'todos.db'))
  db.pragma(`key='${keyHex}'`)
  db.exec('CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT)')
  db.close()
}

test('F20: unreadable db.key (EISDIR failure injection) probes unknown, never no', () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'dw6-probe-'))
  try {
    makeEncryptedDb(ud, KEY)
    // failure injection: replace the key FILE with a DIRECTORY — existsSync true, readFileSync throws
    fs.rmSync(path.join(ud, 'db.key'))
    fs.mkdirSync(path.join(ud, 'db.key'))
    const probe = dbRecovery.encryptedProbe(path.join(ud, 'todos.db'), path.join(ud, 'db.key'))
    assert.equal(probe, 'unknown', 'an unreadable key must stay inconclusive (conservative)')
    assert.notEqual(probe, 'no', 'an unreadable key must NEVER read as "genuinely corrupt"')
  } finally { fs.rmSync(ud, { recursive: true, force: true, maxRetries: 3 }) }
})

test('F20: unreadable key keeps the HEALTHY db alive end-to-end (no rename, no rollback)', () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'dw6-probe-'))
  try {
    makeEncryptedDb(ud, KEY)
    fs.writeFileSync(path.join(ud, 'critical-state-backup.json'), JSON.stringify({ backup: { todoState: { schemaV: 1, todoList: [{ taskId: 'stale' }], recycleList: [] } } }), 'utf8')
    // same failure injection at the attemptDbRecovery level
    fs.rmSync(path.join(ud, 'db.key'))
    fs.mkdirSync(path.join(ud, 'db.key'))
    const r = dbRecovery.attemptDbRecovery(ud, () => { throw new Error('SQLITE_BUSY: transient') })
    assert.equal(r && r.source, 'transient', 'inconclusive probe declines recovery')
    assert.match(r.label, /inconclusive/i, 'the dialog copy says the probe was inconclusive')
    assert.ok(fs.existsSync(path.join(ud, 'todos.db')), 'the healthy db stays in place')
    assert.equal(fs.readdirSync(ud).filter(f => f.includes('.corrupt-')).length, 0, 'no quarantine happened')
    // the db is still the REAL one: decrypts with its key
    const db = new Database(path.join(ud, 'todos.db'))
    db.pragma(`key='${KEY}'`)
    assert.ok(db.prepare('SELECT count(*) AS n FROM meta').get().n >= 0)
    db.close()
  } finally { fs.rmSync(ud, { recursive: true, force: true, maxRetries: 3 }) }
})

test('F20: a READABLE non-64-hex key still probes no (keyless plaintext continuation, unchanged)', () => {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'dw6-probe-'))
  try {
    makeEncryptedDb(ud, KEY)
    fs.writeFileSync(path.join(ud, 'db.key'), 'not-hex-at-all', 'utf8')
    const probe = dbRecovery.encryptedProbe(path.join(ud, 'todos.db'), path.join(ud, 'db.key'))
    assert.equal(probe, 'no', 'readable but non-hex key = db.js keyless rules apply')
  } finally { fs.rmSync(ud, { recursive: true, force: true, maxRetries: 3 }) }
})
