/* GAP-B / GAP-C regression tests (2026-09-19): renderer tomato-ledger writes and setMeta early-
 * returned from the todo-db:call handler BEFORE notifySyncChange, and csv-import wrote through
 * dbm.call with no kick at all — those writes only reached peers at the next 5-minute periodic
 * round (product requirement: seconds-level for the tomato ledger). Covers:
 *   - setMeta via todo-db:call kicks a sync round;
 *   - tomatoAppendMany via todo-db:call kicks a sync round;
 *   - a full import:pick-preview + import:run flow kicks kickSyncRound('csv-import').
 * Real temp DB via db.init (f6 pattern), never touches real data.
 * Run: node --test tests/unit/main/gap-sync-kick-coverage.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'gap-kick-'))
const CSV_PATH = path.join(process.env.TODO_DB_DIR, 'gap-kick.csv')
fs.writeFileSync(CSV_PATH, [
  'Date: 2024-01-01 12:00:00',
  'Version: 3.0',
  '"List Name","Title","Start Date","Due Date","Completed Time","Content","Priority","Tags"',
  '"Inbox","gapkick task",,,,"",0,life'
].join('\r\n'))

const syncKicks = [] // notifySyncChange recorder (todo-db:call path)
const bootstrapKicks = [] // kickSyncRound recorder (csv-import path)
const stubs = {
  electron: {
    app: { getPath: () => process.env.TODO_DB_DIR, isPackaged: false },
    dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: [CSV_PATH] }) },
    BrowserWindow: class {},
    Notification: class { show () {} },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 800, height: 600 } }) }
  },
  // csv-import requires this lazily inside import:run — intercept the kick
  '../lan-sync-bootstrap': {
    kickSyncRound: reason => { bootstrapKicks.push(reason) },
    initLanSync () {},
    stopSyncForQuit () {}
  },
  // real scheduler.reloadAll needs the full electron window surface — not under test here
  '../scheduler': { needsCatchUp: () => false, scheduleOne () {}, reloadAll () {}, reminderInstances: () => [] },
  '../audit': { recordAppOp () {}, recordCustom () {}, record () {}, setDirResolver () {} },
  '../tomato-float': { isSelfSender: () => false, isFloatSender: () => false }
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request]
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const db = require_('../../../src/main/db.js')
db.init(process.env.TODO_DB_DIR)
const todoHandlers = require_('../../../src/main/handlers/todo.js')
const importHandlers = require_('../../../src/main/handlers/csv-import.js')

const e = { sender: { id: 4242 } }
const ctx = {
  isLocked: () => false,
  isLockWindow: () => false,
  getMainWindow: () => ({ webContents: e.sender }), // main-window-only guard: sender must BE the main window's webContents
  resyncDbWatch: () => null,
  broadcastTomatoRecordsChanged: () => {},
  broadcastTodosChanged: () => {},
  dbApi: () => ({}),
  attachDir: '',
  notifySyncChange: op => { syncKicks.push(op) }
}
const h = todoHandlers(ctx)
const imp = importHandlers({ getMainWindow: () => ({ webContents: e.sender }), dbApi: () => ({}), broadcastTodosChanged: () => {}, log: { warn () {} }, resyncDbWatch: () => null })

test('GAP-B: setMeta via todo-db:call kicks a sync round (early return used to skip it)', () => {
  const r = h['todo-db:call'](e, 'setMeta', ['gapKickMetaKey', 'v1'])
  assert.equal(r, true)
  assert.ok(syncKicks.includes('setMeta'), 'setMeta early-return path must call notifySyncChange')
})

test('GAP-B: tomatoAppendMany via todo-db:call kicks a sync round (ledger must sync in seconds)', () => {
  const before = syncKicks.length
  const r = h['todo-db:call'](e, 'tomatoAppendMany', [{ tomatoId: 'gapkick1', endTime: Date.now(), focusDuration: 25 }])
  assert.equal(r && r.accepted, 1, 'ledger row must land')
  assert.ok(syncKicks.slice(before).includes('tomatoAppendMany'), 'ledger early-return path must call notifySyncChange')
})

test('GAP-C: a full preview + import:run flow kicks kickSyncRound("csv-import")', async () => {
  const preview = await imp['import:pick-preview'](e)
  assert.equal(preview && preview.ok, true, 'preview must succeed against the temp CSV')
  const r = await imp['import:run'](e, CSV_PATH)
  assert.ok(r && r.imported >= 1, 'import must land at least one task')
  assert.ok(bootstrapKicks.includes('csv-import'), 'import:run must kick a debounced immediate sync round')
})
