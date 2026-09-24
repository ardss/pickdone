/* Daily 2026-09-24 handlers/todo.js regressions (harness: d6-sec-todo-handlers pattern —
 * real temp DB, electron/scheduler stubbed):
 * [C10] db:purge-seed-todos purges the seed tasks' OWNED attachment FILES too (files-before-rows,
 *       parity with db:purge-recycle-bin / hardDelete) — the old path dropped only the rows and
 *       orphaned local:// attachment files on disk.
 * [C11] the upsert audit label: when the caller's payload version differs from the pre-write DB
 *       row's version (a concurrent CLI/sync write raced between the audit snapshot and the bus
 *       commit — the two are NOT atomic), the specific snapshot-derived action is untrustworthy
 *       and the entry is downgraded to a coarse 'edit' via recordCustom.
 * Run: node --test tests/unit/main/daily-0924-todo-handlers.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-0924-todo-'))

const auditCalls = { app: [], custom: [] }
const stubs = {
  electron: {
    app: { getPath: () => process.env.TODO_DB_DIR, isPackaged: false },
    BrowserWindow: class {},
    Notification: class { show () {} },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 800, height: 600 } }) }
  },
  '../audit': {
    recordAppOp (...a) { auditCalls.app.push(a) },
    recordCustom (...a) { auditCalls.custom.push(a) },
    record () {},
    setDirResolver () {}
  },
  '../scheduler': { needsCatchUp: () => false, scheduleOne () {}, reloadAll () {}, reminderInstances: () => [] },
  '../tomato-float': { isSelfSender: () => false, isFloatSender: () => false }
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request]
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const realDb = require_('../../../src/main/db.js')
realDb.init(process.env.TODO_DB_DIR)
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
  dbApi: () => realDb,
  attachDir: () => process.env.TODO_DB_DIR,
  notifySyncChange: () => {}
})

const baseTask = (taskId, extra = {}) => ({
  taskId, taskContent: 'c-' + taskId, delete: false, dayStart: 0, todoTime: 0,
  updateTime: 1, status: 'update', version: 0, ...extra,
})

test('C10: purge-seed-todos removes seed-owned attachment files AND the rows (files-before-rows)', () => {
  // seed row owning an attachment file (naming rule: <taskId>_<ts>_<name>)
  realDb.call('upsert', baseTask('seed_demo1', { image: JSON.stringify([{ url: 'local://seed_demo1_1700000000_pic.png' }]) }))
  // a live row owning its OWN file must survive the seed purge
  realDb.call('upsert', baseTask('user-row-1', { image: JSON.stringify([{ url: 'local://user-row-1_1700000000_keep.png' }]) }))
  fs.writeFileSync(path.join(process.env.TODO_DB_DIR, 'seed_demo1_1700000000_pic.png'), 'seed-bytes')
  fs.writeFileSync(path.join(process.env.TODO_DB_DIR, 'user-row-1_1700000000_keep.png'), 'user-bytes')
  fs.writeFileSync(path.join(process.env.TODO_DB_DIR, 'unrelated.txt'), 'x')

  const r = api['db:purge-seed-todos'](eMain)
  assert.ok(r, 'purge committed')
  assert.equal(fs.existsSync(path.join(process.env.TODO_DB_DIR, 'seed_demo1_1700000000_pic.png')), false,
    'the seed task attachment FILE is gone (previously orphaned forever)')
  assert.equal(fs.existsSync(path.join(process.env.TODO_DB_DIR, 'user-row-1_1700000000_keep.png')), true,
    'non-seed attachments are untouched')
  assert.equal(fs.existsSync(path.join(process.env.TODO_DB_DIR, 'unrelated.txt')), true)
  const seedLeft = realDb.call('getAll', { deleted: null }).filter(t => String(t.taskId).startsWith('seed_'))
  assert.equal(seedLeft.length, 0, 'seed rows purged')
})

test('C11: a stale-base upsert (payload version != pre-write row version) downgrades the audit label to edit', () => {
  auditCalls.app.length = 0
  auditCalls.custom.length = 0
  realDb.call('upsert', baseTask('audit-race-1', { version: 5, delete: true, deletedAt: 123 }))
  // payload carries version 4 — a DIFFERENT base than the DB row (version 5) the snapshot saw:
  // the derived "restore/undo" label would be untrustworthy, expect a coarse 'edit'.
  const stale = baseTask('audit-race-1', { version: 4, delete: false })
  api['todo-db:call'](eMain, 'upsert', stale)
  assert.equal(auditCalls.custom.length, 1, 'recordCustom fires for the stale-base write')
  assert.equal(auditCalls.custom[0][0], 'edit', 'action downgraded to edit')
  assert.equal(auditCalls.app.length, 0, 'no snapshot-derived specific action recorded')

  // matching base: the regular recordAppOp path stays
  auditCalls.app.length = 0
  auditCalls.custom.length = 0
  const fresh = baseTask('audit-clean-1', { version: 0 })
  api['todo-db:call'](eMain, 'upsert', fresh)
  assert.equal(auditCalls.app.length, 1, 'matching base uses the regular recordAppOp path')
  assert.equal(auditCalls.custom.length, 0)
})
