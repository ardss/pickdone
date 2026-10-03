/* Lifecycle wave 2026-10-02 — hardDelete files-before-rows ordering:
 * [LC-A4] 'todo-db:call' hardDelete removes the task's owned attachment files BEFORE the bus
 *         commit lands. The unlink used to run only AFTER the commit — a failed/interrupted
 *         unlink (or a crash between commit and unlink) orphaned the private file with its
 *         owning row already gone, the exact rows-before-files order main-ipc-8 rejected for
 *         db:purge-recycle-bin. The inverse residual (commit fails after files deleted) is the
 *         accepted direction, asserted here: when the commit THROWS, the files are already gone.
 * Fails without the fix: the old post-commit unlink leaves the file on disk after the rejection.
 * Run: node --test tests/unit/main/lifecycle-harddelete-files-before-rows.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lifecycle-hd-order-'))

// The command bus is stubbed with a commitOp that THROWS — simulating the db-busy/constraint
// failure mid-pipeline. Asserting the file state at that throw point pins the ordering.
const busCalls = []
const stubs = {
  electron: {
    app: { getPath: () => process.env.TODO_DB_DIR, isPackaged: false },
    BrowserWindow: class {},
    Notification: class { show () {} },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 800, height: 600 } }) }
  },
  '../audit': { recordAppOp () {}, recordCustom () {}, record () {}, setDirResolver () {} },
  '../scheduler': { needsCatchUp: () => false, scheduleOne () {}, reloadAll () {}, reminderInstances: () => [] },
  '../tomato-float': { isSelfSender: () => false, isFloatSender: () => false },
  '../command-bus': {
    onCommit () {},
    commandForOp (op) { return op === 'hardDelete' ? 'todo.hardDelete' : null },
    commitOp (op, params) { busCalls.push(op); throw new Error('simulated commit failure') },
    commit () { throw new Error('not used here') },
    resolve () { throw new Error('not used here') }
  }
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request]
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const todoHandlers = require_('../../../src/main/handlers/todo.js')

const MAIN = { webContents: { id: 'main' } }
const eMain = { sender: MAIN.webContents }
const api = todoHandlers({
  isLocked: () => false,
  isLockWindow: () => false,
  getMainWindow: () => MAIN,
  resyncDbWatch: () => null,
  broadcastTomatoRecordsChanged: () => {},
  broadcastTodosChanged: () => {},
  dbm: { call: () => null, isWriteOp: () => true, LEDGER_WRITE_OPS: new Set() },
  dbApi: () => ({}),
  attachDir: () => process.env.TODO_DB_DIR,
  notifySyncChange: () => {}
})

test('LC-A4: hardDelete unlinks owned attachment files BEFORE the bus commit (files survive no failed-commit orphaning)', () => {
  const f = 'task-hd-7_1700000000_pic.png'
  fs.writeFileSync(path.join(process.env.TODO_DB_DIR, f), 'private-bytes')

  assert.throws(() => api['todo-db:call'](eMain, 'hardDelete', 'task-hd-7'), /simulated commit failure/,
    'the commit failure must surface to the renderer')
  assert.equal(busCalls.length, 1, 'the bus commit was reached')
  assert.ok(!fs.existsSync(path.join(process.env.TODO_DB_DIR, f)),
    'owned file must already be gone when the commit throws (files-before-rows) — ' +
    'post-commit unlink leaves it orphaned with the row delete rolled back')
})
