/* W11 gates/main fixes (2026-10-26) — regression pins:
 *   1. db.js queryTodos orderBy hardening: the clause is REBUILT from validated parts only.
 *      The old code validated tokens[0] (column whitelist) and [1] (ASC|DESC) but spliced the
 *      RAW orderBy string into the SQL, so tokens 3+ ('sort ASC junk', 'sort ASC; DROP')
 *      rode into the statement verbatim. Now: any part whose shape isn't exactly [column,
 *      dir?] throws with the SAME message as before (callers surface it as an op error,
 *      unchanged), and emitted SQL contains only whitelisted tokens.
 *   2. fix-util.js backupNameTs now parses filename stamps as LOCAL time, truly mirroring
 *      autoBackup.nameToTs (which took the local-time fix 2026-09-19). Ordering consumers
 *      compare these values against each other, so behavior is unchanged — but the mirror
 *      is now true and future age-comparisons won't skew by the UTC offset.
 * Run: node --test tests/unit/main/w11-gates-main-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-w11-gates-main-'))
const db = require('../../../src/main/db.js')
const { backupNameTs } = require('../../../src/main/fix-util.js')
const autoBackup = require('../../../src/main/autoBackup.js')

db.init(process.env.TODO_DB_DIR)

/* ---------- 1. queryTodos orderBy rebuild ---------- */
test('queryTodos: valid multi-part orderBy (with and without dirs, mixed case dir) passes', () => {
  const orders = [
    'sort ASC, scheduledAt ASC', // the default shape
    'id',
    'updatedAt desc', // lowercase dir must keep working (sqlite accepted it before too)
    'sort DESC, createdAt, complete ASC',
    'content'
  ]
  for (const orderBy of orders) {
    const rows = db.queryTodos({ deleted: 0, orderBy })
    assert.ok(Array.isArray(rows), 'valid orderBy should return rows: ' + orderBy)
  }
})

test('queryTodos: extra tokens / injection shapes / unknown column throw the SAME error as before', () => {
  const bad = ['sort ASC junk', 'sort ASC; DROP', 'sort ASC; DROP TABLE todos', 'nonsenseCol ASC', 'id ASC, sort ASC bogus', 'id DESC extra tokens here']
  for (const orderBy of bad) {
    assert.throws(() => db.queryTodos({ deleted: 0, orderBy }),
      e => e instanceof Error && e.message === 'queryTodos: 非法 orderBy: ' + orderBy,
      'expected the identical 非法 orderBy error for: ' + orderBy)
  }
})

test('queryTodos: SQL is built from whitelisted parts only (source contract: raw orderBy no longer spliced in)', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../src/main/db.js'), 'utf8')
  assert.ok(!/ORDER BY \$\{orderBy\}/.test(src), 'raw orderBy must never be spliced into the SQL verbatim')
  assert.ok(/ORDER BY \$\{clauses\.join/.test(src), 'ORDER BY must be rebuilt from validated clauses')
})

/* ---------- 2. backupNameTs mirrors autoBackup.nameToTs (local-time parse) ---------- */
test('backupNameTs parses evt/auto stamps as LOCAL time, equal to autoBackup.nameToTs', () => {
  const name = 'evt-x-20261027-120000-1760000000000.json'
  const localMs = new Date(2026, 9, 27, 12, 0, 0).getTime() // local-time parse of the stamp
  assert.equal(backupNameTs(name), localMs)
  assert.equal(backupNameTs(name), autoBackup.nameToTs(name))
  // auto names too, plus the same-second dup-suffix form
  for (const n of ['auto-20261027-120000.json', 'auto-20261027-120000-dup1.json']) {
    assert.equal(backupNameTs(n), autoBackup.nameToTs(n), 'mirror must hold for ' + n)
  }
  assert.equal(backupNameTs('not-a-backup.json'), 0)
})
