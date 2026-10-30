/** M2b fix round (2026-10-23) — ops-robustness domain (updater / scheduler / backup / settings).
 *
 *  1. [P2] updater: a settled 'ready' state (update downloaded, "restart and install" armed) must
 *     not be downgraded by a late 'error' event, the check() catch, or 'update-not-available';
 *     'update-not-available' must also respect the in-flight-manual-download guard.
 *  2. [P2] scheduler: the notification-click fallback (showMainEntry unwired/throwing) no longer
 *     bare-shows the main window — fail closed, the lock must never be bypassed by a reminder click.
 *  3. [P2] backup: run-auto-backup's empty-snapshot guard covers the FIRST-EVER run (empty dir + 0
 *     rows → quarantine, no empty point seeded into the restore namespace) and reads the newest
 *     point in 1MB chunks instead of a whole-file readFileSync (up to 64MB on the main thread).
 *  4. [P3] settings: notify-settings-updated uses the boolean makeSenderIsMain twin — a destroyed
 *     main window no longer throws TypeError on .webContents; it degrades to 'forbidden'.
 *
 * Run: node --test tests/unit/main/w7-ops-robust.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import os from 'node:os'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'w7-ops-'))
const TMP_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'w7-ud-'))

// ---- one interception for the whole file (persistent, like d10-updater-manual-download) ----
const ELECTRON_STUB = {
  app: { getPath: () => TMP_USER_DATA, isPackaged: false, getVersion: () => '0.0.0-test', setLoginItemSettings () {}, on () {}, once () {} },
  BrowserWindow: class { static getAllWindows () { return [] } },
  Notification: class { show () {} on () {} },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 800, height: 600 } }) }
}
let autoUpdaterStub = null
let floatSelfSender = false
const stubs = {
  electron: ELECTRON_STUB,
  'electron-updater': { get autoUpdater () { return autoUpdaterStub } },
  '../tomato-float': { isSelfSender: () => floatSelfSender, isFloatSender: () => floatSelfSender },
  '../tomato-taskbar': { setBaseTitle () {} }
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (stubs[request]) return stubs[request]
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

// ============================== 1. updater: ready never downgraded ==============================
function freshUpdater (stub) {
  autoUpdaterStub = stub
  const resolved = require_.resolve('../../../src/main/updater.js')
  delete require_.cache[resolved]
  return require_('../../../src/main/updater.js')
}

function capturingUpdaterStub () {
  const handlers = {}
  const autoUpdater = {
    isUpdaterActive: () => true,
    autoDownload: false,
    on: (evt, fn) => { handlers[evt] = fn },
    checkForUpdates: async () => ({}),
    downloadUpdate: async () => ({}),
    quitAndInstall: () => {}
  }
  return { autoUpdater, handlers }
}

function driveToReady (updater, handlers, autoUpdater) {
  // init()'s syncAutoDownload defaulted autoDownload on; the scenario is "found but NOT
  // auto-downloaded" (same flip as d10-updater-manual-download).
  if (autoUpdater) autoUpdater.autoDownload = false
  handlers['update-available']({ version: '9.9.9' })
  assert.equal(updater.getStatus().status, 'available')
  handlers['update-downloaded']({ version: '9.9.9' })
  assert.equal(updater.getStatus().status, 'ready')
}

test('w7 updater: a late error event must not downgrade the settled ready state', () => {
  const { autoUpdater, handlers } = capturingUpdaterStub()
  const updater = freshUpdater(autoUpdater)
  updater.init(null)
  driveToReady(updater, handlers, autoUpdater)
  handlers.error(new Error('net flake after download'))
  assert.equal(updater.getStatus().status, 'ready', 'red before the fix: error event overwrote ready')
  assert.equal(updater.getStatus().info.version, '9.9.9', 'downloaded info preserved')
})

test('w7 updater: check() catch must not downgrade the settled ready state', async () => {
  const { autoUpdater, handlers } = capturingUpdaterStub()
  autoUpdater.checkForUpdates = async () => { throw new Error('offline') }
  const updater = freshUpdater(autoUpdater)
  updater.init(null)
  driveToReady(updater, handlers, autoUpdater)
  const r = await updater.check()
  assert.equal(r.active, true)
  assert.equal(updater.getStatus().status, 'ready', 'red before the fix: check() catch overwrote ready')
})

test('w7 updater: update-not-available respects the ready guard; idle path unchanged', () => {
  const { autoUpdater, handlers } = capturingUpdaterStub()
  const updater = freshUpdater(autoUpdater)
  updater.init(null)
  // idle: normal semantics preserved
  handlers['update-not-available']({ version: '0.0.0-test' })
  assert.equal(updater.getStatus().status, 'uptodate')
  // downloaded → ready; a later check() reporting "no update" must not clear the ready state
  driveToReady(updater, handlers, autoUpdater)
  handlers['update-not-available']({ version: '0.0.0-test' })
  assert.equal(updater.getStatus().status, 'ready', 'red before the fix: uptodate overwrote ready')
})

test('w7 updater: update-not-available during an in-flight manual download is ignored', async () => {
  const { autoUpdater, handlers } = capturingUpdaterStub()
  autoUpdater.downloadUpdate = () => new Promise(() => {}) // hang in flight
  const updater = freshUpdater(autoUpdater)
  updater.init(null)
  autoUpdater.autoDownload = false // found-but-not-downloaded scenario (autoDownload defaults on after init)
  handlers['update-available']({ version: '9.9.9' })
  void updater.downloadUpdate()
  assert.equal(updater.getStatus().status, 'downloading')
  handlers['update-not-available']({ version: '0.0.0-test' })
  assert.equal(updater.getStatus().status, 'downloading', 'mid-download status owned by the manual download')
})

// ================== 2. scheduler: notification-click fallback fails closed ==================
const windowRef = require_('../../../src/main/window-ref.js')
const scheduler = require_('../../../src/main/scheduler.js')

function fakeMainWin () {
  const calls = { show: 0, focus: 0, send: [] }
  return {
    calls,
    isDestroyed: () => false,
    show () { calls.show++ },
    focus () { calls.focus++ },
    webContents: { send (ch, payload) { calls.send.push([ch, payload]) } }
  }
}

test('w7 scheduler: a throwing show entry never falls back to a bare win.show (lock-safe)', () => {
  const win = fakeMainWin()
  windowRef.setMainWindow(win)
  try {
    scheduler.setShowMainEntry(() => { throw new Error('transient') })
    assert.doesNotThrow(() => scheduler.focusMainFromNotification('t1'))
    assert.equal(win.calls.show, 0, 'red before the fix: the bare fallback revealed the (possibly locked) main window')
    assert.equal(win.calls.focus, 0)
  } finally {
    scheduler.setShowMainEntry(null)
    windowRef.setMainWindow(null)
  }
})

test('w7 scheduler: unwired entry also fails closed; the task-locate push still travels', () => {
  const win = fakeMainWin()
  windowRef.setMainWindow(win)
  try {
    scheduler.setShowMainEntry(null)
    assert.doesNotThrow(() => scheduler.focusMainFromNotification('t2'))
    assert.equal(win.calls.show, 0, 'red before the fix: unwired fallback bare-showed the window')
    const push = win.calls.send.find(([ch]) => ch === 'reminder-open-task')
    assert.ok(push, 'the renderer task-locate push is unaffected')
    assert.deepEqual(push[1], { taskId: 't2' })
  } finally {
    windowRef.setMainWindow(null)
  }
})

test('w7 scheduler: fire() skips the chime when delivery already failed synchronously', () => {
  // Fresh scheduler under its own stubs (same pattern as c-wave-main-20261013 fix 1); the local
  // interception takes priority over the file-global one, then falls through to it.
  let failOnShow = true
  const played = []
  class FakeNotification {
    constructor () { this.h = {} }
    on (ev, h) { this.h[ev] = h }
    show () { if (failOnShow && this.h.failed) this.h.failed(new Error('toast refused')) }
  }
  const ROOT = path.resolve(import.meta.dirname, '../../..')
  const resolved = require_.resolve(path.join(ROOT, 'src/main/scheduler.js'))
  delete require_.cache[resolved]
  const Module2 = require_('module')
  const origLoad2 = Module2._load
  Module2._load = function (request, parent, isMain) {
    if (request === 'electron') return { Notification: FakeNotification }
    if (request === './notify-sound') return { sound: f => played.push(f) }
    if (request === './db.js') return { call: () => null }
    if (request === 'electron-log') return { info () {}, warn () {}, error () {} }
    if (request === './log-isolation') return {}
    return origLoad2.call(this, request, parent, isMain)
  }
  try {
    const sched = require_(resolved)
    sched.setSoundFile('ding.ogg')
    const todo = { taskId: 'w7a', taskContent: 't', taskDescribe: 'd', reminderTime: Date.now() + 1000, reminderOffsets: [], reminderExtra: [] }
    failOnShow = false
    assert.equal(sched.fire(todo, 0), true)
    assert.equal(played.length, 1, 'healthy delivery still plays the chime')
    failOnShow = true
    assert.equal(sched.fire(todo, 0), false, 'synchronous failure still reports false (D22 watermark contract)')
    assert.equal(played.length, 1, 'red before the fix: the chime played on a failed delivery')
  } finally { Module2._load = origLoad2 }
})

// ===================== 3. backup: first-run empty guard + chunked newest read =====================
const backup = require_('../../../src/main/handlers/backup.js')

const realDump = (n) => JSON.stringify({
  backup: { schemaV: 1, todoState: JSON.stringify({ schemaV: 1, todoList: Array.from({ length: n }, (_, i) => ({ taskId: 't' + i })), recycleList: [] }) }
})

function makeBackupCtx () {
  const sender = { id: 1 }
  return {
    ctx: { isLocked: () => false, app: { getPath: () => os.tmpdir() }, getMainWindow: () => ({ webContents: sender }) },
    event: { sender }
  }
}

function withBackupDir (fn) {
  const saved = process.env.TODO_BACKUP_DIR
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w7-bak-'))
  process.env.TODO_BACKUP_DIR = dir
  try { return fn(dir) } finally {
    if (saved === undefined) delete process.env.TODO_BACKUP_DIR
    else process.env.TODO_BACKUP_DIR = saved
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3 })
  }
}

test('w7 backup: FIRST run with an empty snapshot quarantines instead of seeding the restore namespace', () => {
  withBackupDir((dir) => {
    const { ctx, event } = makeBackupCtx()
    const handlers = backup(ctx)
    const r = handlers['run-auto-backup'](event, realDump(0), { recent: 4, dailyDays: 0, weeklyWeeks: 0, eventKeep: 0 })
    assert.equal(r.ok, true)
    assert.equal(r.emptyQuarantined, true, 'red before the fix: empty dir + empty dump landed as a normal auto-*.json point')
    assert.ok(/^empty-quarantine-/.test(r.file))
    const autoFiles = fs.readdirSync(dir).filter(f => /^(auto|evt)-/.test(f))
    assert.equal(autoFiles.length, 0, 'no empty snapshot entered the ^(auto|evt)- restore namespace')
    assert.ok(fs.existsSync(path.join(dir, r.file)), 'the quarantined dump is kept for forensics')
  })
})

test('w7 backup: the guard still quarantines over an existing GOOD point (chunked newest read)', () => {
  withBackupDir((dir) => {
    const { ctx, event } = makeBackupCtx()
    const handlers = backup(ctx)
    const good = realDump(3)
    assert.equal(handlers['run-auto-backup'](event, good, { recent: 4, dailyDays: 0, weeklyWeeks: 0, eventKeep: 0 }).ok, true)
    const r = handlers['run-auto-backup'](event, realDump(0), { recent: 4, dailyDays: 0, weeklyWeeks: 0, eventKeep: 0 })
    assert.equal(r.emptyQuarantined, true, 'newestRowCountChunked answered 3 for the existing good point')
    const autoFiles = fs.readdirSync(dir).filter(f => /^(auto|evt)-/.test(f))
    assert.equal(autoFiles.length, 1)
    assert.equal(fs.readFileSync(path.join(dir, autoFiles[0]), 'utf8'), good, 'the good point is preserved untouched')
  })
})

test('w7 backup: content dedup unchanged — identical snapshot still dedups onto the twin', () => {
  withBackupDir((dir) => {
    const { ctx, event } = makeBackupCtx()
    const handlers = backup(ctx)
    const dump = realDump(2)
    assert.equal(handlers['run-auto-backup'](event, dump, { recent: 4, dailyDays: 0, weeklyWeeks: 0, eventKeep: 0 }).ok, true)
    const r2 = handlers['run-auto-backup'](event, dump, { recent: 4, dailyDays: 0, weeklyWeeks: 0, eventKeep: 0 })
    assert.equal(r2.ok, true)
    assert.equal(r2.dedup, true, 'dedup twin compare path is intact after the catch gained the warn')
    const autoFiles = fs.readdirSync(dir).filter(f => /^(auto|evt)-/.test(f))
    assert.equal(autoFiles.length, 1, 'no second snapshot written on a dedup hit')
  })
})

// ==================== 4. settings: destroyed main window reads as forbidden ====================
const settingsHandlers = require_('../../../src/main/handlers/settings.js')
const settingsCtx = {
  isLocked: () => false,
  app: { getPath: () => TMP, setLoginItemSettings () {} },
  getMainWindow: () => null,
  rebuildTrayMenu: () => {},
  getTray: () => null,
  readConfig: () => ({}),
  writeConfig: p => p,
  applyShortcuts: () => {}
}

test('w7 settings: getMainWindow()=null → forbidden Error, not TypeError on .webContents', () => {
  const api = settingsHandlers(settingsCtx)
  let err = null
  try { api['notify-settings-updated']({ sender: { id: 7 } }, { theme: 'dark' }) } catch (e) { err = e }
  assert.ok(err, 'non-float sender with no main window is rejected')
  assert.match(err.message, /forbidden/, 'classified as forbidden')
  assert.equal(err instanceof TypeError, false, 'red before the fix: TypeError on null .webContents')
})

test('w7 settings: a DESTROYED main window degrades to forbidden without throwing', () => {
  const destroyed = { isDestroyed: () => true, webContents: { id: 'dying' } }
  const api = settingsHandlers({ ...settingsCtx, getMainWindow: () => destroyed })
  let err = null
  try { api['notify-settings-updated']({ sender: { id: 8 } }, { theme: 'dark' }) } catch (e) { err = e }
  assert.ok(err, 'destroyed main window must not authorize the write')
  assert.match(err.message, /forbidden/)
  assert.equal(err instanceof TypeError, false, 'red before the fix: TypeError reading webContents of a destroyed window')
})

test('w7 settings: live main-window and float senders keep their legitimate write access', () => {
  const MAIN = { isDestroyed: () => false, webContents: { id: 'main' } }
  let written = null
  const api = settingsHandlers({ ...settingsCtx, getMainWindow: () => MAIN, writeConfig: p => { written = p; return p } })
  api['notify-settings-updated']({ sender: MAIN.webContents }, { theme: 'light' })
  assert.deepEqual(written, { theme: 'light' }, 'main-window sender still passes the gate')
  floatSelfSender = true
  try {
    written = null
    api['notify-settings-updated']({ sender: { id: 99 } }, { whiteNoiseVolume: 0.4 })
    assert.ok(written && 'whiteNoiseVolume' in written, 'float white-noise write still passes')
  } finally { floatSelfSender = false }
})
