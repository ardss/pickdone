/* M2 fix 1 (2026-10-09): a post-write scheduler.reloadAll/scheduleOne throw must NOT reject the
 * IPC invoke — the write has already landed (bus.commit/dbm.call returned), so a throwing reload
 * made the renderer roll back optimistic state and replay a landed write (false IPC failure).
 * Same caliber as the csv-import settleAfterImport precedent (try + log.warn).
 * Red before the fix: reloadAll stub throws → handler rejects.
 * Run: node --test tests/unit/main/m2-reloadall-guard.test.mjs */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-reloadall-'))
const ATT = fs.mkdtempSync(path.join(os.tmpdir(), 'm2-reloadall-att-'))
const electronStub = { app: { getPath: () => TMP }, BrowserWindow: class {}, ipcMain: { on: () => {} } }
const SCHED = { reloadCalls: 0, scheduleCalls: 0 }
const schedStub = {
  needsCatchUp: () => true, // force the reloadAll branch
  reloadAll () { SCHED.reloadCalls++; throw new Error('boom: transient scheduler failure') },
  scheduleOne () { SCHED.scheduleCalls++ },
  notifyTimeoutOptsForApp: () => ({}),
}
const modStubs = {
  electron: electronStub,
  '../scheduler': schedStub,
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

db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'm2-reloadall-db-')))

function makeCtx () {
  return {
    isLocked: () => false,
    isLockWindow: () => false,
    getMainWindow: () => ({ webContents: WC, isDestroyed: () => false }),
    resyncDbWatch: () => () => {},
    broadcastTomatoRecordsChanged: () => {},
    broadcastTodosChanged: () => {},
    dbApi: () => ({}),
    attachDir: () => ATT,
    notifySyncChange: () => {},
    // write-path classification is faked; the actual rows go through the REAL db via bus
    dbm: {
      LEDGER_WRITE_OPS: new Set(),
      isWriteOp: () => true,
      suppressLedgerHook: () => () => {},
      call: (op, p) => db.call(op, p),
    },
  }
}

// sender identity must match getMainWindow().webContents BY REFERENCE (assertMainWindow)
const WC = { id: 1 }
const eMain = { sender: WC }

test('M2 fix1: reloadAll throwing after a landed write resolves, never rejects the invoke', () => {
  SCHED.reloadCalls = 0; SCHED.scheduleCalls = 0
  const handlers = todoHandlers(makeCtx())
  // hardDelete of an absent id: write lands (returns []), then the reloadAll branch throws.
  const r = handlers['todo-db:call'](eMain, 'hardDelete', 'ghost-id-1')
  assert.deepEqual(r, [], 'the landed write result is returned verbatim')
  assert.equal(SCHED.reloadCalls, 1, 'reloadAll WAS attempted (guard swallows the throw, not the call)')
})

test('M2 fix1: same guard on the commands:commit write door', () => {
  SCHED.reloadCalls = 0
  const handlers = todoHandlers(makeCtx())
  const r = handlers['commands:commit'](eMain, [{ entity: 'todo', verb: 'hardDelete', payload: 'ghost-id-2' }])
  assert.equal(r.failedIndex, -1, 'no false partial-commit failure')
  assert.deepEqual(r.results, [[]])
  assert.equal(SCHED.reloadCalls, 1)
})

test('M2 fix1: purge-recycle-bin reloadAll throw does not reject the purge (fix 1 site B)', () => {
  const handlers = todoHandlers(makeCtx())
  const r = handlers['db:purge-recycle-bin'](eMain)
  assert.deepEqual(r, [], 'purge result returned even though reloadAll threw')
})

test('M2 fix1: purge-seed-todos reloadAll throw does not reject the purge (fix 1 site C)', () => {
  const handlers = todoHandlers(makeCtx())
  const r = handlers['db:purge-seed-todos'](eMain)
  assert.deepEqual(r, [])
})
