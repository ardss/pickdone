/** C6 (2026-10-02) — 'commands:commit' batch length cap.
 *
 * The Phase-1 write door accepted unbounded batch arrays; a compromised/buggy renderer could
 * tie up the main process resolving + executing every entry. Now >1000 entries is rejected
 * with a coded TOO_LARGE error BEFORE any entry resolves (never a partial commit).
 *
 * Run: node --test tests/unit/main/c6-commands-commit-batch-cap.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// Minimal electron stub: handlers/todo.js requires electron-log + nothing else electron-y at load
// that plain node cannot satisfy (log-isolation tolerates missing dirs via TODO_* env).
process.env.TODO_DB_DIR = process.env.TODO_DB_DIR || path.join(osTmp(), 'c6-todo-')
function osTmp () { return require('node:os').tmpdir() }

const todoHandlers = require('../../../src/main/handlers/todo.js')

const MAIN_WC = { id: 'main-wc' }
const eMain = { sender: MAIN_WC }
const noop = () => {}
const ctx = {
  isLocked: () => false,
  isLockWindow: () => false,
  getMainWindow: () => ({ webContents: MAIN_WC, isDestroyed: () => false }),
  resyncDbWatch: noop, broadcastTomatoRecordsChanged: noop, broadcastTodosChanged: noop,
  dbApi: () => ({}), attachDir: () => process.env.TODO_DB_DIR, notifySyncChange: noop,
  dbm: { call: () => ({}), isWriteOp: () => false, LEDGER_WRITE_OPS: new Set() },
}

test('C6: a batch over 1000 entries is rejected with coded TOO_LARGE before any execution', () => {
  const handlers = todoHandlers(ctx)
  const big = Array.from({ length: 1001 }, (_, i) => ({ entity: 'todo', verb: 'upsert', payload: { taskId: String(i) } }))
  try {
    handlers['commands:commit'](eMain, big)
    assert.fail('must have thrown')
  } catch (err) {
    assert.equal(err.code, 'TOO_LARGE', 'red before the fix: unbounded batch accepted')
    assert.match(err.message, /1000/)
  }
})

test('C6: the cap is the boundary — 1000 entries pass the gate (USAGE on unknown, not TOO_LARGE)', () => {
  const handlers = todoHandlers(ctx)
  // 1000 entries of an UNKNOWN command: resolution (USAGE) happens after the cap gate, so the
  // error must be USAGE-shaped ("not a known command"), proving the gate let the batch through.
  const atCap = Array.from({ length: 1000 }, () => ({ entity: 'nope', verb: 'nope' }))
  try {
    handlers['commands:commit'](eMain, atCap)
    assert.fail('unknown command must throw USAGE')
  } catch (err) {
    assert.notEqual(err.code, 'TOO_LARGE')
  }
})

test('C6: non-array single commands are unaffected (wrapped list under the cap)', () => {
  const handlers = todoHandlers(ctx)
  try {
    handlers['commands:commit'](eMain, { entity: 'nope', verb: 'nope' })
    assert.fail('unknown command must throw USAGE')
  } catch (err) {
    assert.notEqual(err.code, 'TOO_LARGE', 'single-command shape never trips the batch cap')
  }
})
