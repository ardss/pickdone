/**
 * c-wave main-process fixes (2026-10-13) — 7 regression tests, one per fix:
 *   1. scheduler.fire: Notification 'failed' events are guarded (no unhandled-event crash) and a
 *      synchronously observed delivery failure returns false (watermark not consumed).
 *   2. settings: a float-window config write no longer re-registers the whole shortcut set.
 *   3. autoBackup.selectPrunes: dup-suffix snapshots can never occupy day/week GFS anchor slots.
 *   4. quick-add: the ignoreBlur latch-expiry timer is tracked + cleared, so a fast second summon
 *      keeps its full latch window (typed input is no longer lost to a self-hide).
 *   5. security-lock.lockAppNow: a throw between the intent latch and a usable lockWin takes the
 *      availability fallback instead of wedging the app (intent latched, no lock window).
 *   6. csv-import: a worker exiting 0 without a message rejects immediately (no 30s hang).
 *   7. db-plan-ops.planMoveTask: same-day move is a no-op (updatedAt untouched, no sync delta).
 * Run: node --test tests/unit/main/c-wave-main-20261013.test.mjs
 */
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const require_ = createRequire(import.meta.url)

/** dw-wave stub loader: require a main-process module with Module._load interception. */
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

/* ---------------- fix 1: scheduler.fire guards the Notification 'failed' event ---------------- */

test('c-wave 1: fire() attaches a failed listener before show(); a delivery failure returns false (and does not throw)', () => {
  let failOnShow = true
  const notifications = []
  class FakeNotification {
    constructor (opts) { this.opts = opts; this.h = {}; notifications.push(this) }
    on (ev, h) { this.h[ev] = h }
    show () { if (failOnShow && this.h.failed) this.h.failed(new Error('toast server refused')) }
  }
  const scheduler = loadWithStubs('src/main/scheduler.js', {
    electron: { Notification: FakeNotification },
    'electron-log': silentLog,
    './log-isolation': {},
    './db.js': { call: () => null },
    './notify-sound': {}
  })
  const todo = { taskId: 'cw1', taskContent: 't', taskDescribe: 'd', reminderTime: Date.now() + 1000, reminderOffsets: [], reminderExtra: [] }
  // healthy path unchanged
  failOnShow = false
  assert.equal(scheduler.fire(todo, 0), true, 'a fire with no failed event still returns true')
  // failure path: no throw, honest false (D22 watermark contract)
  failOnShow = true
  assert.doesNotThrow(() => scheduler.fire(todo, 0), 'the failed event must be handled, not crash the main process')
  assert.equal(scheduler.fire(todo, 0), false, 'a delivery failure must report false so the caller does not consume the catch-up watermark')
  assert.ok(notifications.length >= 3)
  assert.equal(typeof notifications[notifications.length - 1].h.failed, 'function', 'the failed listener is attached (before show)')
})

/* ---------------- fix 2: float-window settings write skips applyShortcuts ---------------- */

test('c-wave 2: a float-window write skips shortcut re-registration; a main-window write still re-applies', () => {
  const floatSender = { id: 7 }
  const mainSender = { id: 1 }
  const applied = []
  const writes = []
  const settings = loadWithStubs('src/main/handlers/settings.js', {
    'electron-log': silentLog,
    '../log-isolation': {},
    '../i18n': { mt: k => k, normalizeLocale: l => (l === 'zh-CN' ? l : null), setLocale () {} },
    '../tomato-float': { isSelfSender: s => s === floatSender },
    '../tomato-taskbar': { setBaseTitle () {} },
    './shared': {
      makeAssertMainWindow: () => () => {},
      stripForbiddenSettingsKeys: (p) => ({ ...(p && typeof p === 'object' ? p : {}) })
    }
  })
  const mainWin = { isDestroyed: () => false, webContents: mainSender, setTitle () {} }
  const ctx = {
    readConfig: () => ({}),
    writeConfig: (patch) => { writes.push(patch); return { shortcutKeySettings: { delay: 1 } } },
    app: { setLoginItemSettings () {} },
    getMainWindow: () => mainWin,
    applyShortcuts: (s) => applied.push(s),
    rebuildTrayMenu: () => {},
    getTray: () => null
  }
  const h = settings(ctx)
  // float sender: legal white-noise write — must NOT re-register shortcuts
  const out = h['notify-settings-updated']({ sender: floatSender }, { whiteNoiseVolume: 0.4 })
  assert.deepEqual(applied, [], 'red before the fix: the float white-noise write re-registered every global hotkey')
  assert.equal(writes.length, 1, 'the float write itself still persists')
  assert.equal(out.shortcutKeySettings.delay, 1)
  // main sender: unchanged behavior — shortcuts re-applied from the merged config
  h['notify-settings-updated']({ sender: mainSender }, { whiteNoiseVolume: 0.5 })
  assert.deepEqual(applied, [{ delay: 1 }], 'the main-window write path still re-applies shortcuts')
})

/* ---------------- fix 3: dup snapshots can never take day/week GFS anchors ---------------- */

test('c-wave 3: selectPrunes prunes a dup name instead of letting it occupy a day/week anchor', () => {
  const autoBackup = require_('../../../src/main/autoBackup.js')
  // recent=1: only the newest REAL snapshot is kept outright. Its same-stamp dup falls out of
  // tier 1 into the anchor tiers — where (pre-fix) nameToTs's base-stamp parse let it take the
  // day/week anchor slot for 2026-10-01 and evict the real snapshot of that day.
  const names = [
    'auto-20261003-120000.json',        // newest real snapshot (recent tier)
    'auto-20261001-120000.json',        // real snapshot, day D1
    'auto-20261001-120000-dup1.json',   // same-second collision of D1
    'evt-rescue-20261001-130000.json'   // event tier must stay unaffected
  ]
  const prunes = autoBackup.selectPrunes(names, { recent: 1, dailyDays: 14, weeklyWeeks: 8, eventKeep: 10 })
  assert.ok(prunes.includes('auto-20261001-120000-dup1.json'),
    'red before the fix: the dup name was KEPT as a day/week anchor (bookkeeping ranked as a real snapshot)')
  assert.ok(!prunes.includes('auto-20261001-120000.json'), 'the real snapshot of the same stamp survives')
  assert.ok(!prunes.includes('auto-20261003-120000.json'), 'the recent-tier snapshot survives')
  assert.ok(!prunes.includes('evt-rescue-20261001-130000.json'), 'the event tier is untouched')
})

/* ---------------- fix 4: quick-add ignoreBlur latch timer is tracked and cleared ---------------- */

test('c-wave 4: a fast second summon keeps its full ignoreBlur latch (the stale expiry timer is cleared)', () => {
  const wins = []
  class FakeWebContents extends EventEmitter {
    constructor () { super(); this.send = () => {}; this.setWindowOpenHandler = () => ({ action: 'deny' }) }
  }
  class FakeWindow extends EventEmitter {
    constructor () {
      super()
      wins.push(this)
      this.webContents = new FakeWebContents()
      this._destroyed = false
      this._visible = false
    }
    setAlwaysOnTop () {}
    setMenu () {}
    setBounds () {}
    loadURL () { return Promise.resolve() }
    isDestroyed () { return this._destroyed }
    isVisible () { return this._visible }
    show () { this._visible = true }
    focus () {}
    hide () { this._visible = false }
    destroy () { this._destroyed = true; this.emit('closed') }
  }
  const qa = loadWithStubs('src/main/quick-add.js', {
    electron: {
      BrowserWindow: FakeWindow,
      screen: {
        getDisplayNearestPoint () { throw new Error('no screen') },
        getCursorScreenPoint () { throw new Error('no screen') },
        getPrimaryDisplay () { throw new Error('no screen') }
      }
    },
    'electron-log': silentLog,
    './log-isolation': {},
    './aux-load-guard': { attachLoadGuard () {} }
  })
  const blur = () => wins[wins.length - 1].emit('blur')
  const t = mock.timers
  t.enable({ apis: ['setTimeout'] })
  try {
    qa.toggle() // t=0: summon #1 → latch #1 armed (T1 due at t=1000)
    assert.equal(qa.isVisible(), true)
    t.tick(100)
    blur() // in-flight show/focus blur → swallowed by latch #1 (window stays visible)
    assert.equal(qa.isVisible(), true, 'latch #1 swallows the summon blur without hiding')
    qa.toggle() // t=100: visible → collapse (normal shortcut path)
    assert.equal(qa.isVisible(), false)
    qa.toggle() // t=100: summon #2 → latch #2 armed (T2 due at t=1100); with the fix, T1 is CLEARED
    assert.equal(qa.isVisible(), true)
    // t=1050: pre-fix the stale T1 fired at t=1000, dropped the latch early → this in-flight
    // blur self-hid the window and the user's typed input was lost. Post-fix the latch holds
    // (latch #2 runs to t=1100).
    t.tick(950)
    blur()
    assert.equal(qa.isVisible(), true, 'red before the fix: the stale T1 killed latch #2 early and the blur self-hid the window')
    // latch #2 expires on schedule (t=1100) → the NEXT blur is a real one and must hide
    t.tick(300)
    blur()
    assert.equal(qa.isVisible(), false, 'after the latch window expires a real blur still hides the window')
  } finally {
    t.reset()
    if (wins[wins.length - 1]) { wins[wins.length - 1]._destroyed = true }
  }
})

/* ---------------- fix 5: lockAppNow survives a throw between intent latch and lock window ---------------- */

function makeLockHarness (getMainWindow) {
  const writes = []
  let shown = 0
  class FakeLockWindow extends EventEmitter {
    constructor () { super(); this.webContents = new FakeWeb() }
    loadURL () { return Promise.resolve() }
  }
  class FakeWeb extends EventEmitter {
    constructor () { super(); this.send = () => {}; this.setWindowOpenHandler = () => ({ action: 'deny' }) }
    loadURL () { return Promise.resolve() }
  }
  const securityLock = loadWithStubs('src/main/security-lock.js', {
    electron: { BrowserWindow: FakeLockWindow, safeStorage: {} }
  })
  const lock = securityLock.createSecurityLock({
    getMainWindow,
    showMainOrLock: () => { shown++ },
    readConfig: () => ({ enableSecurityLock: true, securityLockPassword: 'plain:secret' }),
    writeConfig: (patch) => { writes.push(patch); return patch },
    i18n: { mt: k => k },
    log: silentLog,
    configVersion: () => 1
  })
  return { lock, writes, shown: () => shown }
}

test('c-wave 5: a destroyed main window does not abort the lock build (hide/send are guarded)', () => {
  const destroyedWin = { isDestroyed: () => true, hide () { throw new Error('hide on destroyed') } }
  const { lock } = makeLockHarness(() => destroyedWin)
  assert.doesNotThrow(() => lock.lockAppNow())
  assert.equal(lock.isLocked(), true, 'the lock window is built even though the main window was already destroyed')
})

test('c-wave 5: a hide() throw rolls the locking intent back via the availability fallback (no wedge)', () => {
  const dyingWin = { isDestroyed: () => false, hide () { throw new Error('race: window destroyed mid-hide') }, webContents: { send () {} } }
  const { lock, writes } = makeLockHarness(() => dyingWin)
  assert.doesNotThrow(() => lock.lockAppNow(), 'a throw on the lock-build path must not escape lockAppNow')
  assert.equal(lock.isLocked(), false, 'red before the fix: the intent stayed latched with no lock window — the app was wedged')
  const w = writes.find(p => p && p.enableSecurityLock === false)
  assert.ok(w, 'the availability fallback ran (lock disabled, password wipe written)')
  assert.equal(w.securityLockPassword, '', 'the fallback wipes the password (forced re-set)')
})

/* ---------------- fix 6: worker exit 0 without a message rejects immediately ---------------- */

test('c-wave 6: a worker exiting 0 with no message rejects at once (coded WORKER_EXITED), not after the 30s timeout', async () => {
  let instance = null
  class FakeWorker {
    constructor () { instance = this; this.h = {} }
    on (ev, h) { this.h[ev] = h }
    terminate () { return Promise.resolve(0) }
  }
  const csv = loadWithStubs('src/main/handlers/csv-import.js', {
    worker_threads: { Worker: FakeWorker }
  })
  csv.__resetWorkerRegistry()
  const started = Date.now()
  const p = csv.runImportParse('Type,Content\ntask,x\n')
  // the FakeWorker never sends a message — schedule only its clean exit
  await new Promise(res => setImmediate(res))
  instance.h.exit && instance.h.exit(0)
  await assert.rejects(p, err => {
    assert.match(err.message, /exited without result/, 'the rejection names the empty-exit condition')
    assert.equal(err.code, 'WORKER_EXITED')
    return true
  })
  assert.ok(Date.now() - started < 5000, 'red before the fix: the promise hung until the 30s parse timeout')
  assert.equal(csv.__workerRegistry().outstanding, 0, 'the registry released the finished worker')
  csv.__resetWorkerRegistry()
})

/* ---------------- fix 7: planMoveTask same-day is a no-op ---------------- */

test('c-wave 7: planMoveTask with fromDay===toDay does not touch updatedAt (no sync delta minted)', () => {
  process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cw7-db-'))
  process.env.TODO_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cw7-ud-'))
  const db = require_('../../../src/main/db.js')
  db.init(process.env.TODO_DB_DIR)
  const [id] = db.call('planAddMany', [{ taskId: 'cw7', day: '2026-10-13', mm: '09:00' }])
  const before = db.call('planAll', {}).find(c => c.id === id).updatedAt
  assert.ok(before > 0)
  const changes = db.call('planMoveTask', { taskId: 'cw7', fromDay: '2026-10-13', toDay: '2026-10-13' })
  assert.equal(changes, 0, 'same-day move reports a no-op')
  const after = db.call('planAll', {}).find(c => c.id === id).updatedAt
  assert.equal(after, before, 'red before the fix: the unconditional UPDATE re-stamped updatedAt on every todoTime patch')
  // a real cross-day move still works
  const moved = db.call('planMoveTask', { taskId: 'cw7', fromDay: '2026-10-13', toDay: '2026-10-14' })
  assert.equal(moved, 1)
  assert.equal(db.call('planAll', {}).find(c => c.id === id).day, '2026-10-14')
})
