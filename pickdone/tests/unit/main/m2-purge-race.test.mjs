/* M2 fix 2 (2026-10-09): db:purge-recycle-bin collect→commit race — a task soft-deleted BETWEEN
 * the ids collection and the purgeBin commit is purged by the commit but its attachment files
 * were never in the pre-collected ids (orphaned private files). Fix: the commit result carries
 * the ACTUALLY purged ids (db.purgeRecycleBin is row-granular); the handler sweeps the
 * difference post-commit.
 * Chosen caliber: the race-row IS purged (rows win) and its files are cleaned in a post-commit
 * sweep — a failed unlink there stays warn-only (the files-before-rows doctrine already ran for
 * the pre-collected set).
 * Red before the fix: raceB's file survives the purge forever.
 * Run: node --test tests/unit/main/m2-purge-race.test.mjs */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-purge-'))
const ATT = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-purge-att-'))
const electronStub = { app: { getPath: () => TMP }, BrowserWindow: class {}, ipcMain: { on: () => {} } }
const modStubs = {
  electron: electronStub,
  '../scheduler': { needsCatchUp: () => false, reloadAll () {}, scheduleOne () {}, notifyTimeoutOptsForApp: () => ({}) },
  '../tomato-float': { isSelfSender: () => false },
  '../audit': { recordAppOp () {}, recordCustom () {} },
  '../attachments': { pruneMissingAliases () {} },
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (modStubs[request]) return modStubs[request]
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const db = require_('../../../src/main/db.js')
const todoHandlers = require_('../../../src/main/handlers/todo.js')

db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'm2-purge-db-')))

// sender identity must match getMainWindow().webContents BY REFERENCE (assertMainWindow)
const WC = { id: 1 }
const eMain = { sender: WC }

test('M2 fix2: a task soft-deleted between collect and commit has its files purged too', () => {
  // Two recycle-bin rows. raceA is visible to the collect query; raceB lands "during the race".
  db.call('upsert', { taskId: 'raceA', taskContent: 'a', delete: 1, deletedAt: 1000, updateTime: 1000 })
  db.call('upsert', { taskId: 'raceB', taskContent: 'b', delete: 1, deletedAt: 1000, updateTime: 1000 })
  const fA = path.join(ATT, 'raceA_1700000000000_note.png')
  const fB = path.join(ATT, 'raceB_1700000000000_note.png')
  fs.writeFileSync(fA, 'x'); fs.writeFileSync(fB, 'x')

  // Simulate the race: the collect query (executed by the handler via dbm.call) misses raceB,
  // while the REAL purgeBin commit (via the real bus → real db) purges BOTH rows.
  const handlers = todoHandlers({
    isLocked: () => false,
    isLockWindow: () => false,
    getMainWindow: () => ({ webContents: WC, isDestroyed: () => false }),
    resyncDbWatch: () => () => {},
    broadcastTomatoRecordsChanged: () => {},
    broadcastTodosChanged: () => {},
    dbApi: () => ({}),
    attachDir: () => ATT,
    notifySyncChange: () => {},
    dbm: {
      LEDGER_WRITE_OPS: new Set(),
      isWriteOp: () => true,
      suppressLedgerHook: () => () => {},
      call (op, p) {
        const r = db.call(op, p)
        if (op === 'queryTodos') return r.filter(t => t.taskId !== 'raceB') // raceB arrives mid-race
        return r
      },
    },
  })

  const r = handlers['db:purge-recycle-bin'](eMain)
  assert.deepEqual([...r].sort(), ['raceA', 'raceB'], 'the commit physically purged BOTH rows')
  assert.equal(fs.existsSync(fA), false, 'pre-collected row: files-before-rows removed it')
  assert.equal(fs.existsSync(fB), false,
    'RED before the fix: the race row was purged but its file was never in the collected ids — orphaned forever')
  // both rows physically gone from the db
  assert.equal(db.call('getById', 'raceB'), null)
})
