/* D7 security round (2026-09-22) — main-process IPC/ledger fixes:
 *   F1   export-todos-to-xlsx: assertMainWindow (aux windows could pop save dialogs and write files)
 *        + export-xlsx 17-column header guard hardened against a translator comma
 *   F2   locked-float ledger gate: tomatoUpdateById narrowing reads by id (tomatoGetById) instead of
 *        a full-table tomatoAll scan per float tick
 *   F3   residual ungated channels: tomato-run-announce (main window or float sender only),
 *        update-tomato-taskbar (main window only), pick-backup-dir (main window + not locked)
 * Run: node --test tests/unit/main/d7-main-ipc-gates.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'd7-ipc-gates-'))
const MAIN = { webContents: { id: 'main' }, isDestroyed: () => false }
const eMain = { sender: MAIN.webContents }
const eAux = { sender: { id: 'aux-float' } }

const calls = { announce: [], taskbar: [], dialog: 0 }
let floatSelfSender = false
const stubs = {
  electron: {
    app: { getPath: () => TMP, isPackaged: false },
    BrowserWindow: class {},
    Notification: class { show () {} },
    dialog: {
      showOpenDialog: async () => { calls.dialog++; return { canceled: true, filePaths: [] } },
      showSaveDialog: async () => { calls.dialog++; return { canceled: true } }
    },
    shell: { openPath: async () => '', openExternal: async () => '' },
    screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 800, height: 600 } }) }
  },
  '../tomato-float': { isSelfSender: () => floatSelfSender, isFloatSender: () => floatSelfSender },
  '../tomato-announce': {
    announceFromRenderer: p => { calls.announce.push(p); return 'announced' },
    listAnnounces: () => []
  },
  '../tomato-taskbar': { update: p => { calls.taskbar.push(p) } },
  '../scheduler': { reminderInstances: () => [], needsCatchUp: () => false, scheduleOne () {}, reloadAll () {} },
  '../audit': { recordAppOp () {}, setDirResolver () {} },
  '../updater': { check: async () => ({ active: false }), downloadUpdate: async () => false, quitAndInstall: () => false, getStatus: () => ({ active: false }), init () {}, flushOnceOnReady () {}, forwardFlushAck () {} }
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request]
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const noop = () => {}
const SEVENTEEN_COLS = Array.from({ length: 17 }, (_, i) => 'col' + (i + 1)).join(',')
const ctxBase = {
  isLocked: () => false,
  isLockWindow: () => false,
  app: { getPath: () => TMP },
  getMainWindow: () => MAIN,
  notifySyncChange: noop,
  allowWithinRate: () => true,
  i18n: { mt: k => (k === 'exportCols' ? SEVENTEEN_COLS : k) },
  attachDir: () => TMP,
  resyncDbWatch: () => null,
  broadcastTomatoRecordsChanged: noop,
  broadcastTodosChanged: noop,
  dbApi: () => ({}),
  showMainOrLock: noop,
  rebuildTrayMenu: noop,
  updateTomatoTray: p => { calls.taskbar.push(['tray', p]) }
}

// ---- F1: export-todos-to-xlsx main-window gate ----
const systemHandlers = require_('../../../src/main/handlers/system.js')
test('F1: export-todos-to-xlsx rejects auxiliary windows (no save dialog popped)', async () => {
  const api = systemHandlers(ctxBase)
  assert.throws(() => api['export-todos-to-xlsx'](eAux, {}), /forbidden: main window only/)
  assert.equal(calls.dialog, 0, 'a rejected sender must never reach the native save dialog')
})
test('F1: export-todos-to-xlsx honors the locked gate; main window reaches the exporter', async () => {
  const locked = systemHandlers({ ...ctxBase, isLocked: () => true })
  assert.throws(() => locked['export-todos-to-xlsx'](eMain, {}), /locked/)
  const api = systemHandlers(ctxBase)
  calls.dialog = 0
  const r = await api['export-todos-to-xlsx'](eMain, { fileName: 'x.xlsx', rows: [] })
  assert.deepEqual(r, { canceled: true }, 'main window passes the gate and reaches the (stubbed) save dialog')
  assert.equal(calls.dialog, 1)
})

// ---- F1b: export-xlsx header parse hardening (translator comma) ----
const { parseExportColumns, EXPECTED_EXPORT_COLS } = require_('../../../src/main/export-xlsx.js')
test('F1b: parseExportColumns rejects a translator comma with a clear count error', () => {
  const bad = SEVENTEEN_COLS + ',extra' // 18 columns
  assert.throws(() => parseExportColumns(bad), /must have 17 columns, got 18.*unescaped comma/)
  assert.equal(EXPECTED_EXPORT_COLS, 17)
})
test('F1b: parseExportColumns rejects empty cell names and trims whitespace', () => {
  assert.throws(() => parseExportColumns(SEVENTEEN_COLS.replace('col2', '')), /empty name/)
  assert.deepEqual(parseExportColumns(' a , b ,' + SEVENTEEN_COLS.split(',').slice(2).join(',')),
    ['a', 'b', ...Array.from({ length: 15 }, (_, i) => 'col' + (i + 3))])
})

// ---- F2: locked-float tomatoUpdateById uses an indexed by-id read ----
const db = require_('../../../src/main/db.js')
db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'd7-ledger-')))
const todoHandlers = require_('../../../src/main/handlers/todo.js')
const h = todoHandlers({ ...ctxBase, isLocked: () => true, isLockWindow: () => false, getMainWindow: () => null })
const eFloat = { sender: { id: 42 } }
test('F2: locked float tomatoUpdateById succeeds via tomatoGetById with ZERO tomatoAll scans', () => {
  db.call('tomatoAppendMany', [{ tomatoId: 'd7t1', endTime: Date.now(), focus: 'x', focusTaskId: 't1', succeed: true }])
  floatSelfSender = true
  const realCall = db.call
  let tomatoAllCalls = 0
  let getByIdCalls = 0
  db.call = (op, p) => { if (op === 'tomatoAll') tomatoAllCalls++; if (op === 'tomatoGetById') getByIdCalls++; return realCall(op, p) }
  try {
    const r = h['todo-db:call'](eFloat, 'tomatoUpdateById', { tomatoId: 'd7t1', patch: { focus: 'y' } })
    assert.equal(r, true, 'live same-day row passes the narrowed lock gate')
  } finally { db.call = realCall; floatSelfSender = false }
  assert.equal(tomatoAllCalls, 0, 'the lock gate must not run a full-table tomatoAll scan per tick')
  assert.equal(getByIdCalls, 1, 'the gate must read the row by id (tomatoGetById)')
  assert.equal(db.call('tomatoGetById', 'd7t1').focus, 'y')
})
test('F2: tomatoGetById matches reader semantics (tombstoned row reads as null)', () => {
  floatSelfSender = true
  try {
    db.call('tomatoAppendMany', [{ tomatoId: 'd7t2', endTime: Date.now(), succeed: true }])
    db.call('tomatoRemoveByIds', ['d7t2'])
    assert.equal(db.call('tomatoGetById', 'd7t2'), null, 'deleted=0 filter, same as tomatoAll')
    assert.equal(db.call('tomatoGetById', 'missing'), null)
    assert.throws(() => h['todo-db:call'](eFloat, 'tomatoUpdateById', { tomatoId: 'd7t2', patch: { focus: 'z' } }), /app is locked/,
      'a tombstoned target must not pass the lock gate (nothing visible could be patched)')
  } finally { floatSelfSender = false }
})

// ---- F3: residual ungated channels ----
const tomatoHandlers = require_('../../../src/main/handlers/tomato.js')
test('F3: tomato-run-announce accepts main window and the float itself, rejects other senders', () => {
  const api = tomatoHandlers(ctxBase)
  assert.equal(api['tomato-run-announce'](eMain, { status: 'start' }), 'announced')
  floatSelfSender = true
  try { assert.equal(api['tomato-run-announce'](eFloat, { status: 'stop' }), 'announced') } finally { floatSelfSender = false }
  assert.throws(() => api['tomato-run-announce']({ sender: { id: 'evil' } }, {}), /forbidden: main window or tomato float only/)
  assert.equal(calls.announce.length, 2, 'rejected senders must not write announce meta rows')
})
test('F3: update-tomato-taskbar is main-window-only (tray tooltip spoofing)', () => {
  const api = tomatoHandlers(ctxBase)
  assert.throws(() => api['update-tomato-taskbar'](eAux, { status: 'default' }), /forbidden: main window only/)
  calls.taskbar.length = 0
  api['update-tomato-taskbar'](eMain, { status: 'default' })
  assert.deepEqual(calls.taskbar, [{ status: 'default' }, ['tray', '']], 'main window reaches the single tray-tooltip writer')
})
test('F3: pick-backup-dir is main-window + unlocked only', async () => {
  const api = require_('../../../src/main/handlers/backup.js')(ctxBase)
  await assert.rejects(api['pick-backup-dir'](eAux), /forbidden: main window only/)
  const locked = require_('../../../src/main/handlers/backup.js')({ ...ctxBase, isLocked: () => true })
  await assert.rejects(locked['pick-backup-dir'](eMain), /locked/)
  calls.dialog = 0
  assert.equal(await api['pick-backup-dir'](eMain), null, 'main window passes (stubbed dialog cancels)')
  assert.equal(calls.dialog, 1, 'exactly one dialog open, from the gated main-window call')
})
