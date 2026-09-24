/**
 * Domain-3 window lifecycle regressions (2026-09-24 wave).
 * Fixes covered:
 *   [F10] tomato-float 'closed' resets the module-level panelOpen — a destroyed/rebuilt float used to
 *         inherit panelOpen=true, so startHitPoll hit-tested the fresh 320px window as "panel open"
 *         = whole window (incl. ~234px transparent idle area) clickable, blocking the desktop.
 *   [F16] quick-add did-fail-load self-heal via the shared aux-load-guard: retry with linear backoff,
 *         destroy on exhaustion ('closed' resets win=null; toggle() lazily recreates).
 *   [refactor] aux-load-guard is the single source for both aux windows' load-failure policy.
 * Run: node --test tests/unit/main/dw3-aux-window-lifecycle.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const require_ = createRequire(import.meta.url)
const Module = require_('module')

// ---- stub electron before requiring tomato-float.js (no GUI in unit env) ----
const created = []
class FakeWebContents extends EventEmitter {
  constructor () { super(); this.loadRetriesLog = [] }
  setWindowOpenHandler () {}
  isLoadingMainFrame () { return false }
  async loadURL (u) { this.loadRetriesLog.push(u) }
  send () {}
}
class FakeBrowserWindow extends EventEmitter {
  constructor (opts) {
    super()
    this.opts = opts
    this.webContents = new FakeWebContents()
    this.destroyed = false
    this.bounds = { x: 100, y: 200, width: 240, height: 320 }
    this.ignored = null
    created.push(this)
  }
  isDestroyed () { return this.destroyed }
  isVisible () { return !this.hidden }
  getBounds () { return { ...this.bounds } }
  setBounds (b) { this.bounds = { ...this.bounds, ...b } }
  setIgnoreMouseEvents (v) { this.ignored = v }
  setAlwaysOnTop () {} setVisibleOnAllWorkspaces () {} setMenu () {} setTitle () {} getTitle () { return '' }
  showInactive () {} show () {} hide () { this.hidden = true } focus () {}
  async loadURL (u) { this.webContents.loadRetriesLog.push(u) } // guard reloads via win.loadURL (window-level API, like real BrowserWindow)
  destroy () { this.destroyed = true; this.emit('closed') }
}

const cursor = { x: 0, y: 0 }
const electronStub = {
  BrowserWindow: FakeBrowserWindow,
  screen: {
    getPrimaryDisplay: () => ({ bounds: { width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1048 } }),
    getAllDisplays: () => [],
    getCursorScreenPoint: () => cursor,
    on () {}
  },
  app: {}
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const tomatoFloat = require_('../../../src/main/tomato-float.js')
const db = require_('../../../src/main/db.js')
const { attachLoadGuard } = require_('../../../src/main/aux-load-guard.js')

// F12 round 2: the marker is persisted in the todo DB meta table — init a throwaway DB so the
// marker lifecycle below exercises the REAL persistence path (no mirrors/stubs).
db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'dw3-float-marker-')))

test.afterEach(() => {
  // stop the 40ms hit poll / timers leak: tear every living window down ('closed' stops poll+drag)
  for (const w of created.splice(0)) { try { if (!w.destroyed) w.destroy() } catch { /* gone */ } }
})

/* ---------- [F10] panelOpen reset on 'closed' ---------- */

test('[F10] panelOpen tracks setPanelOpen while the window lives', () => {
  tomatoFloat.show()
  const win = created[created.length - 1]
  assert.equal(tomatoFloat.isPanelOpen(), false, 'starts collapsed')
  assert.equal(tomatoFloat.setPanelOpen(win.webContents, true), true, 'own webContents accepted')
  assert.equal(tomatoFloat.isPanelOpen(), true, 'panel reported open')
  tomatoFloat.setPanelOpen(win.webContents, false)
  assert.equal(tomatoFloat.isPanelOpen(), false, 'panel reported closed again')
})

test('[F10] destroy → panelOpen must NOT leak into the next window instance', () => {
  tomatoFloat.show()
  const win1 = created[created.length - 1]
  tomatoFloat.setPanelOpen(win1.webContents, true)
  assert.equal(tomatoFloat.isPanelOpen(), true, 'precondition: panel open on window #1')
  // destroy path #1: did-fail-load retries exhausted / render-process-gone (win.destroy())
  win1.destroy()
  assert.equal(tomatoFloat.isPanelOpen(), false, "'closed' (via destroy) resets panelOpen — fresh window is not born click-blocking")
  // lazy rebuild path: next show() recreates after the window died behind our back
  tomatoFloat.show()
  const win2 = created[created.length - 1]
  assert.notEqual(win2, win1, 'a fresh instance was created')
  assert.equal(tomatoFloat.isPanelOpen(), false, 'fresh instance starts with hit test = card strip only (86px), not the 320px full window')
})

/* ---------- [F12 round 2] user-closed marker lifecycle (real DB persistence) ---------- */

test('[F12] hide() persists the close marker; show()/undock() clear it — every bypass covered', () => {
  tomatoFloat.show()
  assert.equal(tomatoFloat.isUserClosed(), false, 'fresh state: not closed by user')
  // close path: TomatoBar toggle / float ✕ / settings switch off — all land on hide()
  tomatoFloat.hide()
  assert.equal(tomatoFloat.isUserClosed(), true, 'hide() marks "user closed" (persisted in meta table)')
  // open path #1: show() — the convergence of 'show-tomato-float' IPC (SettingsModal switch,
  // TomatoPanel button, TomatoBar toggle) AND the auto-show call itself
  tomatoFloat.show()
  assert.equal(tomatoFloat.isUserClosed(), false, 'show() clears the marker — renderer bypass paths covered by construction')
  // open path #2: tray undock of a docked (not destroyed) window — does NOT go through show()
  tomatoFloat.hide()
  assert.equal(tomatoFloat.isUserClosed(), true, 'precondition: closed again')
  tomatoFloat.dock()
  tomatoFloat.undock()
  assert.equal(tomatoFloat.isUserClosed(), false, 'undock() clears the marker (tray path, no renderer involved)')
  // marker must survive a process restart by construction: it lives in the DB meta table,
  // which is exactly what the renderer auto-show gate reads via todo-db:call getMeta.
  assert.equal(db.call('getMeta', 'tomatoFloatClosedByUser'), null, 'marker is stored under the meta key the gate reads')
  tomatoFloat.hide()
  assert.equal(db.call('getMeta', 'tomatoFloatClosedByUser'), '1', 'closed marker is a real DB row, not in-memory state')
  tomatoFloat.show()
})

/* ---------- [F16/refactor] aux-load-guard ---------- */

test('[F16] load failure retries with linear backoff, then reloads', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const win = new FakeBrowserWindow({})
  let retries = 0
  attachLoadGuard(win, { url: 'app://app/x#/r1', routeMark: 'r1', tag: 'T', retries: 3, backoffMs: 100, onRetry: () => { retries++ } })
  win.webContents.emit('did-fail-load', {}, -3, 'ERR', 'app://app/x#/r1', true)
  assert.equal(retries, 1, 'onRetry fired for attempt 1')
  t.mock.timers.tick(50)
  assert.equal(win.webContents.loadRetriesLog.length, 0, 'no reload before backoff elapses')
  t.mock.timers.tick(50)
  assert.equal(win.webContents.loadRetriesLog.length, 1, 'reload fires after 1×100ms')
  assert.ok(win.webContents.loadRetriesLog[0].endsWith('r1'))
  assert.equal(win.destroyed, false)
})

test('[F16] subframe failures and foreign-route URLs never trigger the guard', () => {
  const win = new FakeBrowserWindow({})
  let retries = 0
  attachLoadGuard(win, { url: 'app://x#/r2', routeMark: 'r2', tag: 'T', onRetry: () => { retries++ } })
  win.webContents.emit('did-fail-load', {}, -3, 'ERR', 'app://x#/r2', false)
  win.webContents.emit('did-fail-load', {}, -3, 'ERR', 'https://evil.com/#elsewhere', true)
  assert.equal(retries, 0, 'no retry for isMain=false or route mismatch')
  assert.equal(win.destroyed, false)
})

test('[F16] retries exhausted → onExhausted + destroy (window gives way to lazy rebuild)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const win = new FakeBrowserWindow({})
  let exhausted = 0
  attachLoadGuard(win, { url: 'app://x#/r3', routeMark: 'r3', tag: 'T', retries: 2, backoffMs: 1, onExhausted: () => { exhausted++ } })
  win.webContents.emit('did-fail-load', {}, -3, 'ERR', 'app://x#/r3', true)
  t.mock.timers.tick(10)
  win.webContents.emit('did-fail-load', {}, -3, 'ERR', 'app://x#/r3', true)
  t.mock.timers.tick(10)
  assert.equal(exhausted, 0, 'still within budget after 2 failures')
  win.webContents.emit('did-fail-load', {}, -3, 'ERR', 'app://x#/r3', true)
  assert.equal(exhausted, 1, 'onExhausted called exactly once')
  assert.equal(win.destroyed, true, 'dead error-page window destroyed; real code: closed → win=null → toggle() recreates')
})

test('[F16] did-finish-load resets the retry budget (flaky load recovers without destroy)', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const win = new FakeBrowserWindow({})
  attachLoadGuard(win, { url: 'app://x#/r4', routeMark: 'r4', tag: 'T', retries: 2, backoffMs: 1 })
  for (let i = 0; i < 2; i++) { win.webContents.emit('did-fail-load', {}, -3, 'ERR', 'app://x#/r4', true); t.mock.timers.tick(10) }
  win.webContents.emit('did-finish-load')
  win.webContents.emit('did-fail-load', {}, -3, 'ERR', 'app://x#/r4', true)
  t.mock.timers.tick(10)
  assert.equal(win.destroyed, false, 'budget reset by a successful load — no destroy')
})
