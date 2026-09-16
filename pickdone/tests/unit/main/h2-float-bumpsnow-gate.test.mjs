/* H2 fix #1 regression: during lock, the float-window ledger exemption for bumpSnow must be narrowed
   like tomatoAppendMany/tomatoUpdateById — the target task must exist and not be soft-deleted,
   otherwise a trapped float window could inflate focusMinutes on any taskId indefinitely.
   Run: node --test tests/unit/main/h2-float-bumpsnow-gate.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

// ---- stub electron-native modules before requiring the handler chain ----
const stubs = {
  electron: {
    Notification: class { show () {} },
    BrowserWindow: class {},
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 800, height: 600 } }) },
    app: { getPath: () => fs.mkdtempSync(path.join(os.tmpdir(), 'h2-float-audit-')), isPackaged: false }
  },
  '../tomato-float': { isSelfSender: () => true, isFloatSender: () => true },
  '../scheduler': { reminderInstances: () => [], scheduleOne () {}, reloadAll () {} },
  '../audit': { recordAppOp () {}, setDirResolver () {} }
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request]
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const db = require_('../../../src/main/db.js')
db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'h2-float-gate-')))
const todoHandlers = require_('../../../src/main/handlers/todo.js')

const noop = () => {}
const h = todoHandlers({
  isLocked: () => true,
  isLockWindow: () => false, // float window is NOT the lock window: exemption path applies
  getMainWindow: () => null,
  resyncDbWatch: () => null,
  broadcastTomatoRecordsChanged: noop,
  broadcastTodosChanged: noop,
  dbApi: () => ({}),
  attachDir: ''
})
const e = { sender: { id: 42 } }

test('locked float window: bumpSnow on a live task passes the narrowed gate', () => {
  db.call('upsert', { taskId: 'fl_live', taskContent: 'x', complete: false, delete: false })
  const r = h['todo-db:call'](e, 'bumpSnow', { taskId: 'fl_live', minutes: 25 })
  assert.equal(r.ok, true)
  assert.equal(db.call('getById', 'fl_live').estimate, 25)
})

test('locked float window: bumpSnow on a missing task is rejected (app is locked)', () => {
  assert.throws(() => h['todo-db:call'](e, 'bumpSnow', { taskId: 'fl_missing', minutes: 600 }), /app is locked/)
  assert.equal(db.call('getById', 'fl_missing'), null)
})

test('locked float window: bumpSnow on a soft-deleted task is rejected (app is locked)', () => {
  db.call('upsert', { taskId: 'fl_dead', taskContent: 'x', complete: false, delete: true })
  assert.throws(() => h['todo-db:call'](e, 'bumpSnow', { taskId: 'fl_dead', minutes: 600 }), /app is locked/)
  assert.equal(db.call('getById', 'fl_dead').estimate, 0, 'focusMinutes must not be inflated')
})
