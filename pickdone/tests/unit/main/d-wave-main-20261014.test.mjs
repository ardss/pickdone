/**
 * d-wave main-process fixes (2026-10-14) — 6 regression tests, one per fix:
 *   1. scheduler.reloadAll: a failed catch-up fire no longer advances lastRebuildFingerprint —
 *      the next reloadAll retries the catch-up (exactly once; no double-fire via markFired).
 *   2. quarantine-notice + lan-sync-bootstrap: bare Notification.show() calls now attach a
 *      'failed' listener before show() (D22: an unhandled failed event can crash the main process).
 *   3. attachments.saveAttachment: an oversized base64 payload is rejected by a length precheck
 *      BEFORE the strictBase64 decode (no 4-5GB memory peak for a 1GB payload).
 *   4. updater: once status==='ready', later update-available / download-progress events no
 *      longer reset the state (quitAndInstall stays functional).
 *   5. security-lock.lockAppNow: the quick-add window is hidden together with the main window.
 *   6. second-instance-gate: during quitting (flush window), second-instance no longer
 *      resurrects the main window against the closed DB.
 * Run: node --test tests/unit/main/d-wave-main-20261014.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const require_ = createRequire(import.meta.url)

/** require a main-process module with Module._load interception (c-wave stub-loader idiom). */
function loadWithStubs (relPath, stubs) {
  const resolved = require_.resolve(path.join(ROOT, relPath))
  delete require_.cache[resolved]
  const Module = require_('module')
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (stubs[request]) return stubs[request]
    return origLoad.call(this, request, parent, isMain)
  }
  try { return require_(resolved) } finally { Module._load = origLoad }
}
const silentLog = { info () {}, warn () {}, error () {} }

/* -------- fix 1: a failed catch-up fire must not strand the reminder via the fingerprint -------- */

test('d-wave 1: failed catch-up fire keeps the rebuild retriable; success fires exactly once', () => {
  let fail = true
  const fired = []
  const metas = []
  const past = Date.now() - 2000
  const db = {
    getMeta: (k) => (k === 'reminderLastSeenAt' ? '0' : null),
    setMeta: (pair) => { metas.push(pair) },
    queryTodos: () => [{ taskId: 'r1', taskContent: 't', taskDescribe: 'd', reminderTime: past, reminderOffsets: [], reminderExtra: [] }]
  }
  const scheduler = loadWithStubs('src/main/scheduler.js', {
    electron: { Notification: class { constructor () {} on () {} show () {} } },
    'electron-log': silentLog,
    './log-isolation': {},
    './i18n': { mt: k => k },
    './db.js': { call: () => null },
    './command-bus': { commit () {} },
    './window-ref': { getMainWindow: () => null },
    './sanitize': { stripDangerous: v => v },
    './notify-sound': { sound: null }
  })
  scheduler._clearStateForTest()
  scheduler.setFireForTest((todo, offset) => { fired.push(todo.taskId + ':' + (offset || 0)); return !fail })
  // Round 1: fire FAILS — watermark rolls back below the reminder (D22) and the fingerprint
  // must NOT advance, or the next reloadAll early-returns and the reminder strands forever.
  scheduler.reloadAll(db)
  assert.equal(fired.length, 1, 'round 1 attempted the catch-up fire once')
  assert.ok(scheduler._fired.size === 0, 'a failed fire is not marked as fired')
  assert.ok(metas.some(([k, v]) => k === 'reminderLastSeenAt' && Number(v) <= past - 1),
    'the watermark rolled back below the failed reminder time')
  // Round 2: same inputs, fire now SUCCEEDS — the retry must happen (red pre-fix: fingerprint
  // had already advanced, reloadAll early-returned) and fire exactly once.
  fail = false
  scheduler.reloadAll(db)
  assert.equal(fired.length, 2, 'the failed reminder is retried on the next rebuild')
  assert.equal(scheduler._fired.size, 1, 'the successful fire is marked fired (no double-fire)')
  // Round 3: deduped by firedReminders — still exactly one fire.
  scheduler.reloadAll(db)
  assert.equal(fired.length, 2, 'already-fired instances are not re-fired on later rebuilds')
  scheduler._clearStateForTest()
})

/* -------- fix 2: every bare Notification.show() attaches a 'failed' listener (D22) -------- */

test('d-wave 2a: quarantine notice fires a failed event without crashing and still counts as shown', () => {
  const notifications = []
  class FakeNotification {
    static isSupported () { return true }
    constructor (opts) { this.opts = opts; this.h = {}; notifications.push(this) }
    on (ev, h) { this.h[ev] = h }
    show () { if (this.h.failed) this.h.failed(new Error('toast refused')) }
  }
  const warns = []
  // showQuarantineNotice lazy-requires './config-store' after the stub loader restored
  // Module._load — pre-seed require.cache so the quarantine flag is test-owned.
  const csPath = require_.resolve(path.join(ROOT, 'src/main/config-store.js'))
  const ModuleCtor = require_('module')
  const csMod = new ModuleCtor(csPath, null)
  csMod.exports = { consumeQuarantineNotice: () => true }
  csMod.loaded = true
  require_.cache[csPath] = csMod
  const qn = loadWithStubs('src/main/quarantine-notice.js', {
    electron: {
      Notification: FakeNotification,
      dialog: { showMessageBox: async () => {} }
    },
    './i18n': { mt: k => k, mtIn: (_l, k) => k },
    './config-store': { consumeQuarantineNotice: () => true }
  })
  assert.doesNotThrow(() => qn.showQuarantineNotice(
    {}, { warn: (...a) => warns.push(a), error () {} }
  ), 'the failed event must be handled, not crash the main process')
  assert.equal(notifications.length, 1)
  assert.equal(typeof notifications[0].h.failed, 'function', "the 'failed' listener is attached before show()")
  // warn #1: the corruption notice itself; warn #2: the failed delivery
  assert.equal(warns.length, 2, 'the failed delivery is logged as a warn')
})

test('d-wave 2b: the lan-sync pair-request notification attaches its failed listener before show()', () => {
  // The startSync wiring graph is too heavy to stub wholesale; the guard is a local ordering
  // property of the pair-request notification block — assert it at source level.
  const src = fs.readFileSync(path.join(ROOT, 'src/main/lan-sync-bootstrap.js'), 'utf8')
  const start = src.indexOf("const { Notification } = require('electron')", src.indexOf('pair-request'))
  assert.ok(start > 0, 'the pair-request notification block exists')
  const block = src.slice(start, start + 2000)
  const onFailed = block.indexOf("n.on('failed'")
  const show = block.indexOf('n.show()')
  assert.ok(onFailed !== -1, "the pair-request notification attaches a 'failed' listener")
  assert.ok(show !== -1, 'the block calls n.show()')
  assert.ok(onFailed < show, "the 'failed' listener is attached BEFORE show() (D22)")
})

/* -------- fix 3: oversized base64 is rejected before the strictBase64 decode -------- */

test('d-wave 3: an oversized upload is rejected by the length precheck without decoding', async () => {
  const decoded = []
  let decodeCalls = 0
  // saveAttachment lazy-requires './fix-util' AFTER the stub loader restored Module._load —
  // pre-seed require.cache so the strictBase64 sentinel is the one actually consulted.
  const fuPath = require_.resolve(path.join(ROOT, 'src/main/fix-util.js'))
  const ModuleCtor = require_('module')
  const fuMod = new ModuleCtor(fuPath, null)
  fuMod.exports = { strictBase64: (s) => { decodeCalls++; decoded.push(s.length); return s } }
  fuMod.loaded = true
  require_.cache[fuPath] = fuMod
  const attachments = loadWithStubs('src/main/attachments.js', {
    electron: { app: { getPath: () => '/tmp/x' } }
  })
  // 70,000,000 chars -> len*3/4 = 52.5MB > MAX_BYTES(52,428,800): must be rejected at the
  // entry precheck, BEFORE strictBase64 (pre-fix the full string was decoded + re-encoded first).
  const huge = 'A'.repeat(70_000_000)
  await assert.rejects(() => attachments.saveAttachment({ taskId: 't1', name: 'a.png', dataBase64: huge }),
    /too large/, 'the oversized payload is rejected by the size gate')
  assert.equal(decodeCalls, 0, 'no decode work happened for the oversized payload')
  // ordering proof: a payload UNDER the cap reaches strictBase64 (sentinel fires); any later
  // error is fine (no real filesystem in this test) — only the decode count matters.
  let smallErr = null
  try { await attachments.saveAttachment({ taskId: 't1', name: 'a.png', dataBase64: 'QUJD' }) } catch (e) { smallErr = e }
  assert.equal(decodeCalls, 1, 'a payload under the cap proceeds past the precheck to the strict decode')
  assert.ok(smallErr === null || !/too large/.test(smallErr.message), 'the under-cap payload is not rejected by the size gate')
})

/* -------- fix 4: updater 'ready' state survives later update-available / progress events -------- */

test('d-wave 4: after update-downloaded, later update-available/download-progress keep status ready', () => {
  class FakeAutoUpdater extends EventEmitter {
    constructor () { super(); this.isUpdaterActive = () => true; this.autoDownload = false }
  }
  const autoUpdater = new FakeAutoUpdater()
  const updater = loadWithStubs('src/main/updater.js', {
    'electron-updater': { autoUpdater },
    'electron-log': silentLog,
    './log-isolation': {},
    './config-store': { readConfig: () => ({}), isReadFailed: () => false },
    electron: { BrowserWindow: { getAllWindows: () => [] }, app: { getVersion: () => '1.0.0' } },
    './quit-ack': { createQuitAckTracker: () => ({}), runFlushRound: () => {} }
  })
  const sends = []
  const win = { isDestroyed: () => false, webContents: { send: (ch, payload) => sends.push(payload) } }
  updater.init(win)
  const downloaded = { version: '2.0.0' }
  autoUpdater.emit('update-downloaded', downloaded)
  assert.equal(sends.at(-1).status, 'ready')
  // a later periodic check reports a NEWER available version: must NOT clobber 'ready'
  autoUpdater.emit('update-available', { version: '3.0.0' })
  assert.equal(sends.at(-1).status, 'ready', 'update-available no longer resets a ready state')
  assert.deepEqual(sends.at(-1).info, downloaded, 'the downloaded info is preserved for quitAndInstall')
  // stray progress after completion: still no reset
  autoUpdater.emit('download-progress', { percent: 99 })
  assert.equal(sends.at(-1).status, 'ready', 'download-progress no longer resets a ready state')
})

/* -------- fix 5: lockAppNow hides the quick-add window too -------- */

test('d-wave 5: lockAppNow hides both the main window and the quick-add window', () => {
  const quickAddHides = []
  const mainHidden = { v: false }
  // lockAppNow lazy-requires './quick-add' AFTER the stub loader restored Module._load —
  // pre-seed require.cache so the lazy require resolves to the test double.
  const qaPath = require_.resolve(path.join(ROOT, 'src/main/quick-add.js'))
  const ModuleCtor = require_('module')
  const qaMod = new ModuleCtor(qaPath, null)
  qaMod.exports = { hide: () => quickAddHides.push(1) }
  qaMod.loaded = true
  require_.cache[qaPath] = qaMod
  class FakeLockWin {
    constructor () {
      this._destroyed = false
      this.wc = new EventEmitter()
      this.wc.send = () => {}
      this.wc.setWindowOpenHandler = () => {}
    }
    get webContents () { return this.wc }
    isDestroyed () { return this._destroyed }
    focus () {}
    hide () {}
    loadURL () { return Promise.resolve() }
    on () {}
  }
  const createSecurityLock = loadWithStubs('src/main/security-lock.js', {
    electron: { BrowserWindow: FakeLockWin },
    './quick-add': { hide: () => quickAddHides.push(1) }
  }).createSecurityLock
  const mainWin = {
    isDestroyed: () => false,
    hide () { mainHidden.v = true },
    webContents: { send () {} }
  }
  const lock = createSecurityLock({
    getMainWindow: () => mainWin,
    showMainOrLock () {},
    readConfig: () => ({ enableSecurityLock: true }),
    writeConfig () {},
    i18n: { mt: k => k },
    log: silentLog
  })
  assert.doesNotThrow(() => lock.lockAppNow())
  assert.equal(mainHidden.v, true, 'the main window is hidden')
  assert.equal(quickAddHides.length, 1, 'the quick-add window is hidden with it (red pre-fix: quick-add stayed visible)')
  assert.equal(lock.isLocked(), true, 'the lock intent is latched')
})

/* -------- fix 6: second-instance during the quit-flush window must not resurrect the main window -------- */

test('d-wave 6: wireSecondInstance short-circuits show() while quitting', () => {
  const { wireSecondInstance } = require_('../../../src/main/second-instance-gate.js')
  const shown = []
  const app = new EventEmitter()
  app.isReady = () => true
  // quitting=true (flush window / DB closed): no show, no window creation
  wireSecondInstance(app, () => shown.push(1), () => true)
  app.emit('second-instance')
  assert.deepEqual(shown, [], 'a second-instance nudge during quitting must be ignored')
  // normal operation: unchanged behavior
  const shown2 = []
  const app2 = new EventEmitter()
  app2.isReady = () => true
  wireSecondInstance(app2, () => shown2.push(1), () => false)
  app2.emit('second-instance')
  assert.deepEqual(shown2, [1], 'the non-quitting path still shows the window')
})
