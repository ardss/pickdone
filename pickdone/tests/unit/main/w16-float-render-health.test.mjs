/* W16 (2026-10-28): tomato float "window exists but content invisible" reliability round.
 * Four fixes, each pinned here:
 *   P0-1  layered diagnostics probe `diagnose()` (route / DOM sample / capturePage size),
 *         exposed as the read-only 'tomato-float-diagnose' IPC command (main window only).
 *   P0-2  render-health handshake: the float page reports "card DOM actually mounted" via the
 *         existing 'set-tomato-float-bounds' channel; aux-load-guard treats ready-to-show/
 *         did-finish-load as NOT proof of health and rebuilds when the handshake is missing
 *         within HANDSHAKE_TIMEOUT_MS.
 *   P0-3  bounded self-recovery: the crash/handshake rebuild budget is a rolling 5-minute
 *         window (max 3) instead of "consecutive reset on ready-to-show" (the fake-health
 *         reset); exhaustion emits ONE structured 'float-recovery-exhausted' syncEvent.
 *   P1    display-topology hardening: safeReclamp only repositions the float when its bounds
 *         are actually off-screen on every display (floatBoundsVisible), instead of yanking
 *         an on-screen float back to the primary display on any metrics change.
 * Run: node --test tests/unit/main/w16-float-render-health.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'

const require = createRequire(import.meta.url)
const Module = require('module')

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'w16-float-'))
const ipcHandlers = {} // captured 'tomato-float-diagnose' registration (P0-1)
const electronStub = {
  app: { getPath: () => TMP, isPackaged: false },
  BrowserWindow: class {},
  ipcMain: { handle: (ch, fn) => { ipcHandlers[ch] = fn }, on: () => {} },
  screen: {
    getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1048 } }),
    getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1048 } }],
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    on () {},
  },
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const tomatoFloat = require('../../../src/main/tomato-float.js')
const { attachLoadGuard } = require('../../../src/main/aux-load-guard.js')
const windowRef = require('../../../src/main/window-ref.js')

const ROOT = path.resolve(import.meta.dirname, '../../..')

/* ---------- P0-3: windowed recovery budget ---------- */

test('W16 P0-3: crashRebuild is a rolling 5min window — old slots expire, ready-to-show no longer refills', () => {
  const g = tomatoFloat.crashRebuild
  g.reset()
  const t0 = Date.now() // anchor on real time: the count getter filters against Date.now()
  assert.equal(g.allow(t0), true)
  assert.equal(g.allow(t0 + 1), true)
  assert.equal(g.allow(t0 + 2), true)
  assert.equal(g.allow(t0 + 3), false, '4th rebuild inside the window: refused')
  // A rebuilt window reaching ready-to-show is the FAKE health signal this round removes:
  // the budget must NOT reset there (that's why the guard now keys on the render handshake).
  assert.equal(g.count, 3, 'count still shows 3 consumed slots — nothing refilled them')
  // Slots expire after the 5-minute window: recovery becomes possible again.
  const t1 = t0 + 6 * 60 * 1000
  assert.equal(g.allow(t1), true, '6 minutes later the window is empty again — allow')
  assert.equal(g.count, 1, 'only the fresh stamp counts')
  g.reset()
  assert.equal(g.count, 0, 'explicit reset (user opened the float) clears the window')
})

/* ---------- P0-2: render-health handshake seam ---------- */

test('W16 P0-2: handshake seam — fresh handshake counts as health, stale/missing does not', () => {
  const h = tomatoFloat.__renderHealth
  assert.ok(h && typeof h.note === 'function', '__renderHealth seam exported')
  assert.equal(h.timeoutMs > 0, true, 'a positive handshake timeout constant exists')
  const armedAt = 50_000
  assert.equal(h.healthySince(armedAt), false, 'no handshake yet → not healthy (the blank-window case)')
  h.note(armedAt + 10)
  assert.equal(h.healthySince(armedAt), true, 'handshake after arm → healthy')
  assert.equal(h.healthySince(armedAt + 100), false, 'handshake BEFORE this arm → stale, not healthy')
  h.note(Date.now()) // leave the module in a harmless state
})

/* ---------- P0-2: aux-load-guard handshake watch ---------- */

function makeGuardableWin () {
  const wc = new EventEmitter()
  const win = new EventEmitter()
  win.isDestroyed = () => false
  win.webContents = wc
  win.loadURL = async () => {}
  return { win, wc }
}

const sleep = ms => new Promise(ok => setTimeout(ok, ms))

test('W16 P0-2: guard fires onHandshakeTimeout when the handshake never arrives after did-finish-load', async () => {
  const { win, wc } = makeGuardableWin()
  let timeouts = 0
  const healthy = false
  attachLoadGuard(win, {
    url: 'app://app/x#/r', routeMark: 'r', tag: 'W16T',
    handshakeTimeoutMs: 40,
    isHandshakeHealthy: () => healthy,
    onHandshakeTimeout: () => { timeouts++ },
  })
  wc.emit('did-finish-load') // load "succeeded" — the old guard stopped here (fake health)
  await sleep(120)
  assert.equal(timeouts, 1, 'RED before the fix: did-finish-load alone was treated as success; now a missing handshake trips the rebuild path')
  win.emit('closed')
})

test('W16 P0-2: guard stays quiet when the handshake arrives within the window; timer dies with the window', async () => {
  const { win, wc } = makeGuardableWin()
  let timeouts = 0
  attachLoadGuard(win, {
    url: 'app://app/x#/r', routeMark: 'r', tag: 'W16T',
    handshakeTimeoutMs: 40,
    isHandshakeHealthy: () => true,
    onHandshakeTimeout: () => { timeouts++ },
  })
  wc.emit('did-finish-load')
  await sleep(120)
  assert.equal(timeouts, 0, 'healthy handshake → no rebuild')

  // window closed before the timer fires → no late timeout against a dead window
  const win2 = makeGuardableWin()
  let timeouts2 = 0
  attachLoadGuard(win2.win, {
    url: 'app://app/x#/r', routeMark: 'r', tag: 'W16T',
    handshakeTimeoutMs: 30,
    isHandshakeHealthy: () => false,
    onHandshakeTimeout: () => { timeouts2++ },
  })
  win2.wc.emit('did-finish-load')
  win2.win.emit('closed')
  await sleep(100)
  assert.equal(timeouts2, 0, "'closed' clears the armed handshake timer (D21 timer-lifecycle parity)")
})

/* ---------- P0-1: layered diagnostics probe ---------- */

test('W16 P0-1: diagnose() returns layered route/DOM/capture data for a live window', async () => {
  const wc = {
    getURL: () => 'app://app/renderer-dist/index.html#/__tomato-float',
    executeJavaScript: async () => ({ present: true, width: 220, height: 70, visibility: 'visible', opacity: '1' }),
    capturePage: async () => ({ isEmpty: () => false, getSize: () => ({ width: 240, height: 320 }), toPNG: () => Buffer.alloc(2048) }),
  }
  const win = {
    isDestroyed: () => false,
    isVisible: () => true,
    getBounds: () => ({ x: 100, y: 100, width: 240, height: 320 }),
    webContents: wc,
  }
  tomatoFloat.__forceWin(win)
  const d = await tomatoFloat.diagnose()
  assert.equal(d.hasWindow, true)
  assert.equal(d.urlOk, true, 'route layer: current URL is the float route')
  assert.deepEqual(d.dom, { present: true, width: 220, height: 70, visibility: 'visible', opacity: '1' }, 'DOM layer sampled')
  assert.equal(d.capture.pngBytes, 2048, 'capture layer: non-empty size info')
  assert.ok('renderHandshakeAgeMs' in d, 'handshake age exposed so the three failure layers stay distinguishable')
})

test('W16 P0-1: diagnose() degrades per layer and reports no-window cleanly', async () => {
  const wc = {
    getURL: () => 'about:blank#nope',
    executeJavaScript: async () => { throw new Error('page not initialized') },
    capturePage: async () => ({ isEmpty: () => true }),
  }
  tomatoFloat.__forceWin({ isDestroyed: () => false, isVisible: () => false, getBounds: () => ({ x: 0, y: 0, width: 240, height: 320 }), webContents: wc })
  const d = await tomatoFloat.diagnose()
  assert.equal(d.urlOk, false, 'wrong route flagged')
  assert.equal(d.dom.error, 'page not initialized', 'DOM layer degrade: renderer unreachable (page not initialized)')
  assert.deepEqual(d.capture, { empty: true }, 'capture layer: blank paint')
  // card-present-but-empty DOM branch
  const wc2 = { getURL: () => 'about:blank#nope', executeJavaScript: async () => ({ present: false }), capturePage: async () => ({ isEmpty: () => true }) }
  tomatoFloat.__forceWin({ isDestroyed: () => false, isVisible: () => false, getBounds: () => ({ x: 0, y: 0, width: 240, height: 320 }), webContents: wc2 })
  const d1 = await tomatoFloat.diagnose()
  assert.equal(d1.dom.present, false, 'DOM layer: card absent (component render failure)')
  tomatoFloat.__clearWin()
  const d2 = await tomatoFloat.diagnose()
  assert.equal(d2.hasWindow, false, 'no-window case is explicit, not a throw')
})

test('W16 P0-1: tomato-float-diagnose IPC is registered and gated to the main window', async () => {
  const fn = ipcHandlers['tomato-float-diagnose']
  assert.equal(typeof fn, 'function', 'probe registered on the IPC surface (diagnostics command reuses the existing ipcMain.handle pattern)')
  // main window's own webContents passes
  const mainWc = new EventEmitter()
  windowRef.setMainWindow({ isDestroyed: () => false, webContents: mainWc })
  tomatoFloat.__clearWin()
  const d = await fn({ sender: mainWc })
  assert.equal(d.hasWindow, false, 'main-window sender allowed (returns the no-window report)')
  // a foreign/trapped renderer is refused
  await assert.rejects(() => fn({ sender: new EventEmitter() }), /forbidden/, 'non-main sender refused')
})

/* ---------- P1: off-screen-only re-clamp ---------- */

test('W16 P1: floatBoundsVisible — center-or-corner rule, off-screen bounds detected', () => {
  const { floatBoundsVisible } = tomatoFloat
  const displays = [{ workArea: { x: 0, y: 0, width: 1920, height: 1048 } }]
  assert.equal(floatBoundsVisible({ x: 1600, y: 600, width: 240, height: 320 }, displays), true, 'on-screen float (card visible)')
  assert.equal(floatBoundsVisible({ x: 5000, y: 600, width: 240, height: 320 }, displays), false, 'float parked entirely on an unplugged monitor → off-screen')
  assert.equal(floatBoundsVisible({ x: 100, y: -2000, width: 240, height: 320 }, displays), false, 'float above every display → off-screen')
  assert.equal(floatBoundsVisible({ x: 1900, y: 900, width: 240, height: 320 }, displays), true, 'corner still on a display counts as visible')
})

/* ---------- renderer-side wiring anchors (source level — no Vue boot needed) ---------- */

test('W16 P0-2 renderer: float page sends the handshake only after $nextTick confirms the card DOM', () => {
  const src = fs.readFileSync(path.join(ROOT, 'renderer/js/views/TomatoFloatPage.vue'), 'utf8')
  const mountedIdx = src.indexOf('mounted ()')
  const mounted = src.slice(mountedIdx, src.indexOf('beforeUnmount'))
  assert.ok(mounted.includes('$nextTick'), 'handshake deferred past DOM patch')
  assert.ok(mounted.includes("querySelector('.tomato')"), 'handshake gated on the card actually being mounted')
  assert.ok(mounted.includes('setTomatoFloatBounds'), 'handshake rides the existing set-tomato-float-bounds channel (no new channel needed)')
})

test('W16 P0-3 renderer: exhaustion report surfaces through the existing syncEvent toast wiring + i18n keys', () => {
  const toast = fs.readFileSync(path.join(ROOT, 'renderer/js/utils/syncDegradedToast.js'), 'utf8')
  assert.ok(toast.includes('float-recovery-exhausted'), 'toast wiring maps the new structured type')
  assert.ok(toast.includes('floatRecoveryExhausted'), 'toast maps to the i18n key')
  const en = fs.readFileSync(path.join(ROOT, 'renderer/js/i18n/en-US.js'), 'utf8')
  const zh = fs.readFileSync(path.join(ROOT, 'renderer/js/i18n/zh-CN.js'), 'utf8')
  assert.ok(/floatRecoveryExhausted/.test(en), 'en copy present')
  assert.ok(/floatRecoveryExhausted/.test(zh), 'zh copy present')
})
