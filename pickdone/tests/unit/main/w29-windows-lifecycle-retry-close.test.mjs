/* W29 — windows.js main-window lifecycle real-behavior tests (fake BrowserWindow harness).
 *
 * Covers, against the REAL module (electron stubbed; config/locks/etc. injected as recorders):
 *   - createMainWindow wiring: W19 sanitizeRestoreBounds (invalid persisted bounds fall back to
 *     the 1000x560 defaults; valid bounds pass through; maximized restore calls maximize())
 *   - the W29 security-lock arming on EVERY did-finish-load (setting on + unlocked → lockAppNow;
 *     locked → no double-arm; setting off → no arm)
 *   - the did-fail-load retry machine: 3 backoff reloads captured to the LIVE webContents
 *     (stale-window guard), benign -3 abort ignored, quit-in-progress ignored, and the
 *     retry-exhaustion fallback that locks the app instead of coming up unlocked
 *   - the render-process-gone self-heal: 3 reloads → persisted relaunch marker (real file in the
 *     sandbox userData) → app.relaunch + full app.quit(); the cap-exhausted 'give-up' fatal dialog
 *     path; clean-exit and quit-in-progress no-ops; onRendererGone lease clearing
 *   - the F1 close-intent machine: 'hide' (preventDefault + hide + tray notice + durable
 *     closeTrayNotified write), 'quit' (preventDefault + deferred requestUserQuit), else persist
 *   - persistBoundsState: maximized windows persist NORMAL bounds; resize/move debounce persists
 *     once; 'closed' clears the pending debounce
 *   - the navigation guards: window.open handler (allow about:blank, openExternal+deny https,
 *     deny others), will-navigate app://-only
 *   - the D10 crash-counter seams (__crashCounter round-trip, corrupt marker → 0) and the pure
 *     geometry seams (__windowGeom)
 *
 * Run: node --test tests/unit/main/w29-windows-lifecycle-retry-close.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Module from 'node:module'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(import.meta.dirname, '../../..')
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'w29-wins-'))
const UD = path.join(TMP, 'ud')
fs.mkdirSync(UD, { recursive: true })
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ---- fake BrowserWindow/electron harness ----
const calls = {
  browserWindowOpts: [], relaunch: 0, quit: 0, errorBox: [], openExternal: [],
  lockAppNow: 0, showMainOrLock: 0, requestUserQuit: 0, onRendererGone: 0,
  unregisterAll: 0, schedulerFlush: 0, maximize: 0, writes: [], balloon: 0,
  loadURLs: [], reloads: 0, executes: [], setTitle: [], windowRef: 0,
  taskbarInit: 0, updaterInit: 0, shortcutsApply: 0,
}
let lastWin = null
function makeFakeWindow (opts) {
  calls.browserWindowOpts.push(opts)
  const wcHandlers = {}
  const winHandlers = {}
  const win = {
    destroyed: false,
    isDestroyed: () => win.destroyed,
    webContents: {
      on: (ev, cb) => { (wcHandlers[ev] = wcHandlers[ev] || []).push(cb) },
      once: (ev, cb) => { (wcHandlers[ev] = wcHandlers[ev] || []).push(cb) },
      setWindowOpenHandler: cb => { win._openHandler = cb },
      executeJavaScript: code => { calls.executes.push(code); return Promise.resolve() },
      isDestroyed: () => win.destroyed,
      loadURL: url => { calls.loadURLs.push(url); return Promise.resolve() },
      reload: () => { calls.reloads++ },
    },
    on: (ev, cb) => { (winHandlers[ev] = winHandlers[ev] || []).push(cb) },
    once: (ev, cb) => { (winHandlers[ev] = winHandlers[ev] || []).push(cb) },
    _emitWc (ev, ...a) { for (const cb of wcHandlers[ev] || []) cb({ sender: win.webContents, preventDefault: () => { a[0] && a[0].prevented && a[0].prevented() }, ...a }) },
    _emitWin (ev, ...a) { for (const cb of winHandlers[ev] || []) cb(...a) },
    loadURL: url => { calls.loadURLs.push(url); return Promise.resolve() },
    reload: () => { calls.reloads++ },
    hide: () => { calls.hidden = (calls.hidden || 0) + 1 },
    maximize: () => { calls.maximize++ },
    setTitle: t => { calls.setTitle.push(t) },
    isMaximized: () => !!win._maximized,
    getBounds: () => ({ x: 11, y: 22, width: 900, height: 640 }),
    getNormalBounds: () => ({ x: 1, y: 2, width: 880, height: 600 }),
  }
  lastWin = win
  return { win, wcHandlers, winHandlers }
}

const ELECTRON_STUB = {
  app: { getPath: () => UD, relaunch: () => { calls.relaunch++ }, quit: () => { calls.quit++ } },
  // object-shorthand exempted: shorthand methods are non-constructible and `new BrowserWindow(...)` needs [[Construct]]
  BrowserWindow: function (opts) { const m = makeFakeWindow(opts); Object.assign(this, m.win); this._m = m; lastWin = this }, // eslint-disable-line object-shorthand
  shell: { openExternal: async url => { calls.openExternal.push(url) } },
  dialog: { showErrorBox: (t, m) => { calls.errorBox.push([t, m]) } },
  screen: {
    getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }],
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }),
    on: () => {}, removeListener: () => {},
  },
}
const LOG_STUB = { info: () => {}, warn: () => {}, error: () => {}, hooks: [], transports: { file: {}, console: {} } }
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return ELECTRON_STUB
  if (request === 'electron-log') return LOG_STUB
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const windows = require(path.join(ROOT, 'src', 'main', 'windows.js'))

// ---- ctx fakes ----
let cfg = {}
let closeIntent = 'hide'
let locked = false
let quitting = false
let quitByUser = false
let trayNotice = true
const ctx = {
  readConfig: () => cfg,
  writeConfig: patch => { calls.writes.push(patch); Object.assign(cfg, patch) },
  i18n: { mt: k => k },
  log: LOG_STUB,
  windowRef: { setMainWindow: () => { calls.windowRef++ } },
  closeBehavior: {
    closeIntent: () => closeIntent,
    isCloseToTray: () => true,
    shouldShowTrayNotice: c => !!trayNotice && !c.closeTrayNotified,
  },
  tomatoTaskbar: { init: () => { calls.taskbarInit++ } },
  updater: { init: () => { calls.updaterInit++ } },
  applyShortcuts: () => { calls.shortcutsApply++ },
  shortcuts: { unregisterAll: () => { calls.unregisterAll++ } },
  scheduler: { flushFiredNow: () => { calls.schedulerFlush++ } },
  isLocked: () => locked,
  lockAppNow: () => { calls.lockAppNow++ },
  showMainOrLock: () => { calls.showMainOrLock++ },
  isQuitting: () => quitting,
  getState: () => ({ quitByUser }),
  getTray: () => ({ displayBalloon: () => { calls.balloon++ } }),
  requestUserQuit: () => { calls.requestUserQuit++ },
  onRendererGone: () => { calls.onRendererGone++ },
}
const mgr = windows.createWindowManager(ctx)
const CRASH_MARKER = path.join(UD, 'renderer-crash-relaunch-count.json')

test('createMainWindow: W19 sanitizeRestoreBounds — invalid persisted bounds fall back to defaults; valid pass through; maximized restore', () => {
  cfg = { winBounds: { x: 5, y: 6, width: 100, height: -30 } }
  mgr.createMainWindow()
  let opts = calls.browserWindowOpts.at(-1)
  assert.equal(opts.width, 1000, 'a corrupt (tiny width, negative height) entry falls back to the default width')
  assert.equal(opts.height, 560)
  assert.equal(opts.x, undefined)
  assert.equal(opts.y, undefined)
  assert.equal(opts.minWidth, 750)

  cfg = { winBounds: { x: 5, y: 6, width: 812, height: 450 }, winIsMaximized: true }
  const beforeMax = calls.maximize
  mgr.createMainWindow()
  opts = calls.browserWindowOpts.at(-1)
  assert.deepEqual({ x: opts.x, y: opts.y, width: opts.width, height: opts.height }, { x: 5, y: 6, width: 812, height: 450 }, 'a fully-valid persisted entry restores verbatim')
  assert.ok(calls.maximize > beforeMax, 'the persisted maximized state is restored')
  assert.equal(calls.windowRef >= 2, true, 'the live window is re-injected into windowRef on recreation')
  assert.ok(calls.taskbarInit >= 2 && calls.updaterInit >= 2 && calls.shortcutsApply >= 2, 'taskbar/updater/shortcuts re-init on every recreation')
})

test('W29 security-lock arming fires on EVERY did-finish-load, guarded by setting and lock state', () => {
  const before = calls.lockAppNow
  cfg = { enableSecurityLock: true }
  // the once-armed guard and the 'on' handlers share the webContents registry — emit did-finish-load
  const fire = () => { for (const cb of lastWin._m.wcHandlers['did-finish-load']) cb({ sender: lastWin.webContents }) }
  fire()
  assert.ok(calls.lockAppNow > before, 'an unlocked app with the setting on arms the lock on load')
  // locked → no double arm
  const mid = calls.lockAppNow
  locked = true
  fire()
  assert.equal(calls.lockAppNow, mid, 'an already-locked app does not re-arm')
  locked = false
  // setting off → no arm
  cfg = { enableSecurityLock: false }
  fire()
  assert.equal(calls.lockAppNow, mid, 'the setting off leaves the app unlocked')
})

test('did-fail-load: 3 backoff reloads captured to the live webContents; benign -3 and quitting are ignored; exhaustion locks the app', async () => {
  cfg = { enableSecurityLock: true }
  locked = false
  quitting = false
  const beforeLock = calls.lockAppNow
  const beforeLoads = calls.loadURLs.length
  // 1st failure → 400ms backoff reload
  lastWin._m.wcHandlers['did-fail-load'].forEach(cb => cb(undefined, -326, 'ERR', 'app://app/renderer-dist/index.html', true))
  await sleep(520)
  assert.equal(calls.loadURLs.length, beforeLoads + 1, 'main-frame failure schedules one backoff reload')
  // reset counter as did-finish-load would, then exhaust the remaining budget
  for (const cb of lastWin._m.wcHandlers['did-finish-load']) cb({ sender: lastWin.webContents })
  const beforeLoads2 = calls.loadURLs.length
  lastWin._m.wcHandlers['did-fail-load'].forEach(cb => cb(undefined, -326, 'ERR', 'x', true))
  await sleep(520)
  lastWin._m.wcHandlers['did-fail-load'].forEach(cb => cb(undefined, -326, 'ERR', 'x', true))
  await sleep(950)
  lastWin._m.wcHandlers['did-fail-load'].forEach(cb => cb(undefined, -326, 'ERR', 'x', true))
  await sleep(1400)
  assert.equal(calls.loadURLs.length, beforeLoads2 + 3, 'three backoff reloads total for the new streak')
  // 4th failure (budget exhausted) → the locked-white-screen fallback, no more reloads
  const midLoads = calls.loadURLs.length
  lastWin._m.wcHandlers['did-fail-load'].forEach(cb => cb(undefined, -326, 'ERR', 'x', true))
  await sleep(400)
  assert.equal(calls.loadURLs.length, midLoads, 'exhaustion schedules no further reload')
  assert.ok(calls.lockAppNow > beforeLock, 'retries exhausted → the app falls back to the LOCKED state (never silently unlocked)')

  // benign -3 (ERR_ABORTED) and in-flight quit: no retry scheduled
  const quiet = calls.loadURLs.length
  lastWin._m.wcHandlers['did-fail-load'].forEach(cb => cb(undefined, -3, 'ERR_ABORTED', 'x', true))
  quitting = true
  lastWin._m.wcHandlers['did-fail-load'].forEach(cb => cb(undefined, -326, 'ERR', 'x', true))
  await sleep(450)
  assert.equal(calls.loadURLs.length, quiet, 'benign abort and quit-in-progress schedule no retry')
  quitting = false
})

test('render-process-gone: reload self-heal ×3 → persisted relaunch marker + relaunch + full quit; clean-exit and quitting no-ops', async () => {
  fs.rmSync(CRASH_MARKER, { force: true })
  quitting = false
  const beforeReloads = calls.reloads
  for (let i = 0; i < 3; i++) {
    lastWin._m.wcHandlers['render-process-gone'].forEach(cb => cb(undefined, { reason: 'crashed', exitCode: 1 }))
    await sleep(400)
  }
  assert.equal(calls.reloads, beforeReloads + 3, 'three crash reloads before the relaunch cap')
  assert.equal(calls.onRendererGone, 3, 'the tomato lease hook fired for every crash')
  // clean-exit: no reload
  const midReloads = calls.reloads
  lastWin._m.wcHandlers['render-process-gone'].forEach(cb => cb(undefined, { reason: 'clean-exit', exitCode: 0 }))
  await sleep(400)
  assert.equal(calls.reloads, midReloads, 'a clean exit is not a crash')

  // 4th crash past the in-memory cap → D10 persisted counter → relaunch #1
  const beforeRelaunch = calls.relaunch
  const beforeQuit = calls.quit
  lastWin._m.wcHandlers['render-process-gone'].forEach(cb => cb(undefined, { reason: 'crashed', exitCode: 1 }))
  await sleep(400)
  assert.equal(calls.relaunch, beforeRelaunch + 1, 'past the reload cap the app relaunches')
  assert.equal(calls.quit, beforeQuit + 1, 'the relaunch goes through app.quit() (full flush chain), never exit(1)')
  assert.equal(JSON.parse(fs.readFileSync(CRASH_MARKER, 'utf8')).count, 1, 'the relaunch counter is persisted in userData')
  assert.equal(calls.unregisterAll >= 1, true, 'shortcuts are unregistered before the relaunch')
  assert.ok(calls.schedulerFlush >= 1, 'the dedup ledger is flushed before the relaunch')

  // quit-in-progress: renderer deaths from quitting are not fought
  quitting = true
  const q = calls.reloads
  lastWin._m.wcHandlers['render-process-gone'].forEach(cb => cb(undefined, { reason: 'crashed', exitCode: 1 }))
  await sleep(400)
  assert.equal(calls.reloads, q, 'no reload while quitting')
  quitting = false
})

test('relaunch cap exhausted → fatal-error dialog, NO further relaunch', () => {
  const beforeRelaunch = calls.relaunch
  fs.writeFileSync(CRASH_MARKER, JSON.stringify({ count: windows.CRASH_RELAUNCH_CAP, at: Date.now() }))
  lastWin._m.wcHandlers['render-process-gone'].forEach(cb => cb(undefined, { reason: 'crashed', exitCode: 1 }))
  assert.equal(calls.relaunch, beforeRelaunch, 'the cap is enforced from the PERSISTED counter — no relaunch #4')
  assert.equal(calls.errorBox.length, 1, 'the user gets a fatal-error dialog instead of a zombie loop')
  assert.match(calls.errorBox[0][1], /keeps crashing/)
})

test('close intents: hide (+tray notice + durable write), quit (deferred requestUserQuit), persist', async () => {
  const mkCloseEvent = () => { const e = { prevented: false }; e.preventDefault = () => { e.prevented = true }; return e }
  // hide intent with tray notice
  closeIntent = 'hide'; trayNotice = true; quitByUser = false
  let ev = mkCloseEvent()
  lastWin._m.winHandlers['close'].forEach(cb => cb(ev))
  assert.equal(ev.prevented, true, 'a hide close is prevented (window stays, tray mode)')
  assert.ok(calls.hidden >= 1, 'the window hides')
  assert.equal(calls.balloon, 1, 'the win32 tray balloon notice is shown once')
  assert.equal(cfg.closeTrayNotified, true, 'the notice flag is durably written')
  // hide intent, notice already shown → no second balloon
  calls.writes.length = 0
  ev = mkCloseEvent()
  lastWin._m.winHandlers['close'].forEach(cb => cb(ev))
  assert.equal(calls.balloon, 1, 'no repeated balloon after the first notify')

  // quit intent: preventDefault + DEFERRED requestUserQuit (sync hang avoidance)
  closeIntent = 'quit'
  const beforeQuitReq = calls.requestUserQuit
  ev = mkCloseEvent()
  lastWin._m.winHandlers['close'].forEach(cb => cb(ev))
  assert.equal(ev.prevented, true)
  assert.equal(calls.requestUserQuit, beforeQuitReq, 'the quit request is NOT issued synchronously (close-collision hang)')
  await sleep(20)
  assert.equal(calls.requestUserQuit, beforeQuitReq + 1, 'the quit chain is deferred past the current tick')

  // other (default) intent: persist bounds and allow the close
  closeIntent = 'persist'
  ev = mkCloseEvent()
  lastWin._m.winHandlers['close'].forEach(cb => cb(ev))
  assert.equal(ev.prevented, false, 'a plain close is not prevented')
  const lastWrite = calls.writes.at(-1)
  assert.deepEqual(lastWrite.winBounds, { x: 11, y: 22, width: 900, height: 640 }, 'the close path persists the CURRENT bounds')
  assert.equal(lastWrite.winIsMaximized, false)
})

test('persistBoundsState: maximized windows persist NORMAL bounds; destroyed windows are skipped', () => {
  calls.writes.length = 0
  lastWin._m.win._maximized = true
  mgr.persistBoundsState(lastWin)
  assert.deepEqual(calls.writes.at(-1), { winBounds: { x: 1, y: 2, width: 880, height: 600 }, winIsMaximized: true }, 'the maximized full-screen rect is NOT stamped as the restore size')
  lastWin._m.win._maximized = false
  mgr.persistBoundsState(lastWin)
  assert.deepEqual(calls.writes.at(-1).winBounds, { x: 11, y: 22, width: 900, height: 640 })
  assert.equal(calls.writes.at(-1).winIsMaximized, false)
  lastWin._m.win.destroyed = true
  calls.writes.length = 0
  mgr.persistBoundsState(lastWin)
  assert.equal(calls.writes.length, 0, 'a destroyed window is skipped without throwing')
})

test('resize/move debounce: one persist per burst; a closed window drops the pending timer', async () => {
  lastWin._m.win.destroyed = false
  calls.writes.length = 0
  lastWin._emitWin('resize'); lastWin._emitWin('move'); lastWin._emitWin('resize')
  await sleep(500)
  const persistWrites = calls.writes.filter(w => w.winBounds)
  assert.equal(persistWrites.length, 1, 'a high-frequency drag burst persists exactly once')
  // closed window: pending timer must not touch a destroyed window
  calls.writes.length = 0
  lastWin._emitWin('resize')
  lastWin._emitWin('closed')
  await sleep(500)
  assert.equal(calls.writes.filter(w => w.winBounds).length, 0, "the pending debounce died with the window ('closed' clears it)")
})

test('navigation guards: window.open (allow blank / external https / deny rest) and app://-only will-navigate', async () => {
  const h = lastWin._m.win._openHandler
  assert.deepEqual(h({ url: '' }), { action: 'allow' }, 'the blank print window is allowed')
  assert.deepEqual(h({ url: 'about:blank' }), { action: 'allow' })
  calls.openExternal.length = 0
  assert.deepEqual(h({ url: 'https://example.com' }), { action: 'deny' }, 'child windows are denied')
  assert.deepEqual(calls.openExternal, ['https://example.com'], 'the https target goes to the system browser instead')
  assert.deepEqual(h({ url: 'file:///C:/x' }), { action: 'deny' })

  let prevented = false
  const e = { preventDefault: () => { prevented = true } }
  calls.openExternal.length = 0
  lastWin._m.wcHandlers['will-navigate'].forEach(cb => cb(e, 'app://app/renderer-dist/index.html'))
  assert.equal(prevented, false, 'in-app navigation is untouched')
  lastWin._m.wcHandlers['will-navigate'].forEach(cb => cb(e, 'https://evil.example'))
  assert.equal(prevented, true, 'cross-origin navigation is blocked')
  assert.deepEqual(calls.openExternal, ['https://evil.example'])
})

test('D10 crash-counter seams: durable round-trip; corrupt/missing marker → 0', () => {
  windows.__crashCounter.write(2)
  assert.equal(windows.__crashCounter.read(), 2)
  fs.writeFileSync(CRASH_MARKER, '{corrupt')
  assert.equal(windows.__crashCounter.read(), 0, 'a torn marker degrades to 0 (in-memory-only budget)')
  fs.rmSync(CRASH_MARKER, { force: true })
  assert.equal(windows.__crashCounter.read(), 0)
})

test('pure geometry seams: windowBoundsVisible corner rule; sanitizeRestoreBounds four-field validation', () => {
  const g = windows.__windowGeom
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1040 } }]
  assert.equal(g.windowBoundsVisible({ x: 0, y: 0, width: 800, height: 600 }, displays), true)
  assert.equal(g.windowBoundsVisible({ x: 1500, y: 800, width: 800, height: 600 }, displays), true, 'a HALF-off-screen window still has a corner inside → visible')
  assert.equal(g.windowBoundsVisible({ x: 2000, y: 0, width: 800, height: 600 }, []), false, 'no displays → not visible')
  assert.equal(g.windowBoundsVisible(null, displays), false)
  assert.equal(g.windowBoundsVisible({ x: 2000, y: 1200, width: 800, height: 600 }, displays), false, 'fully off-screen → clamped back')

  assert.deepEqual(g.sanitizeRestoreBounds({ x: 1, y: 2, width: 800, height: 450 }), { x: 1, y: 2, width: 800, height: 450 })
  assert.equal(g.sanitizeRestoreBounds({ x: 1, y: 2, width: 749, height: 450 }), null, 'below minWidth → discarded')
  assert.equal(g.sanitizeRestoreBounds({ x: 1, y: 2, width: 800, height: 199 }), null, 'below minHeight → discarded')
  assert.equal(g.sanitizeRestoreBounds({ x: 1, y: 2, width: 800, height: NaN }), null, 'non-finite → discarded')
  assert.equal(g.sanitizeRestoreBounds('x'), null)
  assert.equal(g.sanitizeRestoreBounds(null), null)
})
