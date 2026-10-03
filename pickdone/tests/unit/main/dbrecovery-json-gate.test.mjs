/**
 * Regression: JSON-restore gate must require a SUCCESSFUL re-init (2026-09-26, lubancat live).
 *
 * The startup catch-block used to run the JSON restore purely on `source === 'json'`. When the
 * re-init ALSO failed (board case: the vendor sqlite driver cannot load under Debian 11 glibc),
 * the restore still ran — every busCommit inside it throws ("stmts.upsertMany is not a function"
 * against empty prepared statements) and the "recovery" rebuilds nothing while the log shows a
 * restore attempt. The gate now lives in dbRecovery.jsonRestoreAllowed(source, reinitErr).
 *
 * Run: node --test tests/unit/main/dbrecovery-json-gate.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const dbRecovery = await import('../../../src/main/dbRecovery.cjs')

test('jsonRestoreAllowed: json source + successful re-init -> restore runs', () => {
  assert.equal(dbRecovery.jsonRestoreAllowed({ source: 'json', label: 'x' }, null), true)
})

test('jsonRestoreAllowed: json source but re-init FAILED -> restore must NOT run (bus would throw on empty stmts)', () => {
  assert.equal(dbRecovery.jsonRestoreAllowed({ source: 'json', label: 'x' }, new Error('GLIBC_2.33 not found')), false)
})

test('jsonRestoreAllowed: non-json sources never restore through the bus', () => {
  for (const source of ['retry-ok', 'transient', 'plain-bak', 'error', null, undefined]) {
    assert.equal(dbRecovery.jsonRestoreAllowed(source === null ? null : { source }, null), false, `source=${source}`)
  }
})

/* ---------------- restore-plainbak-copied-without-header-gate (2026-10-02) ----------------
 * The plain-bak branch gated on EXISTENCE only and copied without validation, so a torn
 * todos.db.plain-bak overwrote todos.db (the file it was supposed to rescue). Gate symmetrically
 * with the JSON parseability one: a plain-bak counts as a recoverable source only when its SQLite
 * header is intact; a garbage one is never deleted (forensics doctrine, same as .corrupt-*). */
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'

function tmpUd () {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'plainbak-gate-'))
  const ud = path.join(parent, 'ud')
  fs.mkdirSync(ud)
  return ud
}

test('plain-bak gate: garbage plain-bak + no usable JSON → recovery declines (null), todos.db untouched', () => {
  const ud = tmpUd()
  fs.writeFileSync(path.join(ud, 'todos.db'), Buffer.alloc(100, 0x41)) // garbage: header intact? NO — 0x41 is not the magic
  fs.writeFileSync(path.join(ud, 'todos.db.plain-bak'), 'not a database')
  const before = fs.readFileSync(path.join(ud, 'todos.db'))
  const r = dbRecovery.attemptDbRecovery(ud, null)
  assert.notEqual(r && r.source, 'plain-bak', 'red before the fix: the existence-only gate copied the garbage plain-bak over todos.db')
  assert.equal(fs.readFileSync(path.join(ud, 'todos.db')).equals(before), true, 'todos.db must not be overwritten')
  assert.equal(fs.existsSync(path.join(ud, 'todos.db.plain-bak')), true, 'the garbage plain-bak is preserved for forensics, never deleted')
})

test('plain-bak gate: valid-SQLite-header plain-bak still restores with source plain-bak', () => {
  const ud = tmpUd()
  fs.writeFileSync(path.join(ud, 'todos.db'), Buffer.alloc(100, 0x41)) // genuinely bad main db
  fs.writeFileSync(path.join(ud, 'todos.db.plain-bak'), Buffer.from('SQLite format 3\x00' + '.'.repeat(32), 'binary'))
  const r = dbRecovery.attemptDbRecovery(ud, null)
  assert.equal(r && r.source, 'plain-bak', 'companion green: a healthy plain-bak remains a recoverable source')
  assert.equal(fs.readFileSync(path.join(ud, 'todos.db')).toString('binary', 0, 15), 'SQLite format 3', 'the plain-bak was copied back')
})

test('plain-bak gate: garbage plain-bak + usable JSON → the JSON still outranks (existing contract)', () => {
  const ud = tmpUd()
  fs.writeFileSync(path.join(ud, 'todos.db'), Buffer.alloc(100, 0x41))
  fs.writeFileSync(path.join(ud, 'todos.db.plain-bak'), 'not a database')
  fs.writeFileSync(path.join(ud, 'critical-state-backup.json'), JSON.stringify({
    backup: { todoState: JSON.stringify({ todoList: [{ taskId: 't1' }], recycleList: [] }) }
  }))
  const r = dbRecovery.attemptDbRecovery(ud, null)
  assert.equal(r && r.source, 'json', 'jsonExists outranking at the restore decision point is unchanged')
  assert.equal(fs.existsSync(path.join(ud, 'todos.db.plain-bak')), true, 'the garbage plain-bak still survives the JSON branch')
})
