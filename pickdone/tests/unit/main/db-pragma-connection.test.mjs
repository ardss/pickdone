import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// ES1 regression: connection pragmas (synchronous=NORMAL, journal_mode=WAL, busy_timeout=5000)
// were applied only to the FIRST handle in initInner. The encryption-finalization block for a
// fresh install closes that handle and reopens an encrypted one — the surviving handle ran with
// synchronous=FULL and busy_timeout=0 (write-loss window under concurrent CLI access).
// Fresh-install path = the reopen happens on every clean init here (preSchemaTables === 0).
process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-db-pragma-'))
const require = createRequire(import.meta.url)
const db = require('../../../src/main/db')

db.init(process.env.TODO_DB_DIR)

test('ES1: connection pragmas survive the encryption-finalization handle reopen', () => {
  const p = db.__connPragmasForTests()
  assert.ok(p, 'pragma introspection hook exposed')
  assert.equal(p.synchronous, 1, 'synchronous=NORMAL (1), not FULL (2) on the final handle')
  assert.ok(p.busyTimeout >= 5000, 'busy_timeout >= 5000 on the final handle, got ' + p.busyTimeout)
  assert.equal(p.journalMode, 'wal', 'journal_mode=wal on the final handle')
})
