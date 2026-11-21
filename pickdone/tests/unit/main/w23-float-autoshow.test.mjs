/* W23 (2026-10-31): float auto-show chain hardening — "小窗没弹出来" fixes.
 *   P1-1  renderer main.js: the float auto-show registration moved out of bootstrap()'s serial tail
 *         into registerFloatAutoShow(), armed as bootstrap()'s FIRST statement in its own
 *         try/catch — no earlier failure can silently skip it anymore.
 *   P1-2  the enableTomatoFloating===false gate now logs WHY it skipped (console.info), and
 *         handlers/settings.js get-settings type-cleanses the config.json value (non-boolean →
 *         schema default true), closing the beta.15-residue / cross-machine-blob-flip hole.
 *   P1-3  the cross-machine restore channel logs when it flips enableTomatoFloating.
 *   P2    aux-load-guard retries-exhausted emits ONE structured recovery report over the existing
 *         'float-recovery-exhausted' syncEvent type (code 'load-guard-retries-exhausted') —
 *         reusing the W16 handshake-timeout channel, no new enum entry (r4 set-equality intact).
 *   P3    handlers/tomato.js --no-focus suppression logs; the showTomatoFloat invoke rejection is
 *         console.warn-ed instead of `.catch(() => {})`.
 * Run: node --test tests/unit/main/w23-float-autoshow.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const Module = require('module')
const ROOT = path.resolve(import.meta.dirname, '../../..')
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const mainSrc = read('renderer/js/main.js')
const guardSrc = read('src/main/aux-load-guard.js')
const tomatoHandlerSrc = read('src/main/handlers/tomato.js')
const settingsHandlerSrc = read('src/main/handlers/settings.js')

/* ---------- P1-1: auto-show registration is failure-proof ---------- */

test('W23 P1-1: bootstrap arms the float auto-show before its first await', () => {
  const iBoot = mainSrc.indexOf('async function bootstrap ()')
  const iCall = mainSrc.indexOf('registerFloatAutoShow({', iBoot)
  const iFirstAwait = mainSrc.indexOf('await', iBoot)
  assert.ok(iCall > 0, 'bootstrap registers the float auto-show')
  assert.ok(iCall < iFirstAwait, 'registration precedes the first await — earlier failures cannot skip it')
  assert.ok(mainSrc.indexOf('function registerFloatAutoShow') === -1, 'the chain itself now lives in utils/floatAutoShow.js')
})

/* The chain is exercised as behaviour (it used to be regex-matched inside main.js's source text).
   Every case drives the real registerFloatAutoShow with an injected timer/api/store. */
// STATIC import, not `await import(...)`: with run-all's `--test-force-exit` a top-level await
// leaves the runner thinking the file is done after the first (sync) case, and every async case
// after it is reported cancelledByParent — green standalone, red in the pool.
import { registerFloatAutoShow, FLOAT_AUTO_SHOW_DELAY_MS } from '../../../renderer/js/utils/floatAutoShow.js'

function armFloatAutoShow ({ marker, enabled = true, hasApi = true, mainShell = true, dbCallThrows = false } = {}) {
  const actions = []
  const timers = []
  const record = kind => (...a) => actions.push(kind + ': ' + a.map(String).join(' '))
  registerFloatAutoShow({
    isMainShell: mainShell,
    store: { state: { settings: { enableTomatoFloating: enabled } } },
    api: () => hasApi
      ? {
          dbCall: () => {
            if (dbCallThrows) throw new Error('bridge gone')
            return typeof marker === 'function' ? marker() : marker
          },
          showTomatoFloat: () => { actions.push('show'); return Promise.resolve() }
        }
      : null,
    timer: (fn, ms) => timers.push({ fn, ms }),
    log: { info: record('info'), warn: record('warn'), error: record('error') }
  })
  return {
    actions,
    timers,
    async fire () {
      for (const t of timers) t.fn()
      for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve))
      return actions
    }
  }
}

test('W23 P1-1: only the main shell arms the timer, and the 6s delay is unchanged', () => {
  const aux = armFloatAutoShow({ mainShell: false, marker: Promise.resolve(null) })
  assert.equal(aux.timers.length, 0, 'quick-add/float windows never auto-show (would revive a closed float)')
  const main = armFloatAutoShow({ marker: Promise.resolve(null) })
  assert.equal(main.timers.length, 1, 'one timer in the main shell')
  assert.equal(main.timers[0].ms, FLOAT_AUTO_SHOW_DELAY_MS, 'delay constant is what the timer got')
  assert.equal(FLOAT_AUTO_SHOW_DELAY_MS, 6000, 'delay unchanged at 6s')
})

test('W23 P1-1: marker semantics — explicit close suppresses, everything else shows', async () => {
  assert.deepEqual(await armFloatAutoShow({ marker: Promise.resolve('1') }).fire(), [], "marker '1' means the user closed it: stay closed")
  assert.deepEqual(await armFloatAutoShow({ marker: Promise.resolve(null) }).fire(), ['show'], 'no marker: show')
  assert.deepEqual(await armFloatAutoShow({ marker: Promise.resolve('') }).fire(), ['show'], 'empty marker: show')
})

test('W23 P1-1: a failed marker read shows (it must not read as "user closed it")', async () => {
  const rejected = await armFloatAutoShow({ marker: Promise.reject(new Error('DB temporarily unavailable')) }).fire()
  assert.ok(rejected.includes('show'), 'rejected getMeta still opens the enabled float')
  assert.ok(rejected.some(a => a.startsWith('warn:')), 'the failure is logged, not swallowed')
  const thrown = await armFloatAutoShow({ marker: null, dbCallThrows: true }).fire()
  assert.ok(thrown.includes('show'), 'a synchronous bridge throw is treated the same way')
  assert.ok(thrown.some(a => a.startsWith('warn:')), 'and logged too')
})

test('W23 P1-1: the off switch and a missing bridge both suppress, the switch loudly', async () => {
  const off = await armFloatAutoShow({ marker: () => Promise.reject(new Error('x')), enabled: false }).fire()
  assert.deepEqual(off.filter(a => a === 'show'), [], 'enableTomatoFloating === false always wins')
  assert.ok(off.some(a => a.startsWith('info:') && a.includes('enableTomatoFloating')), 'the skip states its reason (W23 P2)')
  const noApi = await armFloatAutoShow({ marker: Promise.resolve(null), hasApi: false }).fire()
  assert.deepEqual(noApi, [], 'no todoAPI: nothing happens, nothing is logged as failure')
})

test('W23 P1-3: cross-machine restore of enableTomatoFloating is observable', () => {
  const i = mainSrc.indexOf('onExternalSettingsChanged(')
  assert.ok(i > 0, 'restore channel wired')
  const block = mainSrc.slice(i, i + 900)
  assert.match(block, /'enableTomatoFloating' in patch[\s\S]*console\.info\(/, 'flip of the float switch over the sync channel logs one line')
})

/* ---------- P1-2: settings handler type cleanse (dynamic) ---------- */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'w23-settings-'))
const electronStub = {
  app: { getPath: () => TMP, isPackaged: false, whenReady: async () => {} },
  BrowserWindow: class {},
  ipcMain: { handle: () => {}, on: () => {} },
  screen: { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }), getAllDisplays: () => [], getCursorScreenPoint: () => ({ x: 0, y: 0 }), on () {} },
}
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return electronStub
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })

const settingsHandlers = require('../../../src/main/handlers/settings.js')

function makeHandlers (config) {
  const noop = () => {}
  return settingsHandlers({
    readConfig: () => ({ ...config }),
    writeConfig: () => ({ ...config }),
    app: { setLoginItemSettings: noop },
    getMainWindow: () => null,
    applyShortcuts: noop,
    rebuildTrayMenu: noop,
    getTray: () => null,
    isLocked: () => false,
    isLockWindow: () => false,
  })
}

test('W23 P1-2: get-settings drops a non-boolean enableTomatoFloating (residue) in favor of default true', () => {
  for (const junk of ['0', 'false', 0, null, undefined]) {
    const c = makeHandlers({ enableTomatoFloating: junk })['get-settings']({ sender: {} })
    assert.equal(c.enableTomatoFloating, true, 'junk value ' + JSON.stringify(junk) + ' cleansed to schema default true')
  }
})

test('W23 P1-2: a legitimate boolean false survives the cleanse (user really turned it off)', () => {
  const c = makeHandlers({ enableTomatoFloating: false })['get-settings']({ sender: {} })
  assert.equal(c.enableTomatoFloating, false, 'real false is product intent, must NOT be flipped to true')
  const c2 = makeHandlers({ enableTomatoFloating: true })['get-settings']({ sender: {} })
  assert.equal(c2.enableTomatoFloating, true, 'true passes through')
})

test('W23 P1-2: get-settings carries the type-cleanse at the IPC boundary (source shape)', () => {
  assert.match(settingsHandlerSrc, /typeof c\.enableTomatoFloating !== 'boolean'/, 'cleanse present in get-settings')
  assert.match(settingsHandlerSrc, /c\.enableTomatoFloating = true/, 'junk dropped in favor of schema default true')
  assert.match(settingsHandlerSrc, /\[settings\] config\.json enableTomatoFloating is not boolean/, 'cleanse is observable via log.warn')
})

/* ---------- P2: aux-load-guard exhaustion recovery report (dynamic) ---------- */

test('W23 P2: retries exhausted emits ONE structured float-recovery-exhausted report with a cause code', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const emitted = []
  const bootstrapStub = { emitSyncEvent: (type, payload) => emitted.push([type, payload]) }
  const origLoad2 = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub
    if (request === './lan-sync-bootstrap') return bootstrapStub
    return origLoad2.call(this, request, parent, isMain)
  }
  let guard
  try {
    delete require.cache[require.resolve('../../../src/main/aux-load-guard.js')]
    guard = require('../../../src/main/aux-load-guard.js')
    class FakeWC extends require('node:events').EventEmitter {}
    class FakeWin extends require('node:events').EventEmitter {
      constructor () { super(); this.webContents = new FakeWC(); this._destroyed = false }
      isDestroyed () { return this._destroyed }
      loadURL () { return Promise.resolve() } // guard reloads the WINDOW (win.loadURL), not webContents
      destroy () { this._destroyed = true; this.emit('closed') }
    }
    const win = new FakeWin()
    let exhausted = 0
    guard.attachLoadGuard(win, { url: 'app://x#w23', routeMark: 'w23', tag: 'W23T', retries: 1, backoffMs: 1, onExhausted: () => { exhausted++ } })
    win.webContents.emit('did-fail-load', {}, -3, 'ERR', 'app://x#w23', true)
    t.mock.timers.tick(10)
    win.webContents.emit('did-fail-load', {}, -3, 'ERR', 'app://x#w23', true)
    assert.equal(exhausted, 1, 'onExhausted still fires (existing dw3 contract)')
    assert.equal(win._destroyed, true, 'window still destroyed')
    assert.equal(emitted.length, 1, 'exactly one recovery report (one-shot per guard)')
    assert.deepEqual(emitted[0], ['float-recovery-exhausted', { code: 'load-guard-retries-exhausted' }])
  } finally {
    Module._load = origLoad2
    delete require.cache[require.resolve('../../../src/main/aux-load-guard.js')]
  }
})

test('W23 P2: the guard report reuses the EXISTING syncEvent type (r4 set-equality stays intact)', () => {
  // the new emit must use a literal type already in the r4 emit set — no new enum entry
  const m = guardSrc.match(/emitSyncEvent\('([a-z-]+)'/)
  assert.ok(m, 'guard emits via a literal emitSyncEvent type')
  assert.equal(m[1], 'float-recovery-exhausted', 'type equals the W16 handshake-timeout channel type')
  assert.match(guardSrc, /load-guard-retries-exhausted/, 'code names the cause')
  assert.match(guardSrc, /exhaustionReported/, 'one-shot guard flag present')
})

/* ---------- P3: --no-focus suppression observability ---------- */

test('W23 P3: --no-focus suppression logs instead of silently skipping show', () => {
  const i = tomatoHandlerSrc.indexOf("'show-tomato-float'")
  const block = tomatoHandlerSrc.slice(i, tomatoHandlerSrc.indexOf("'hide-tomato-float'"))
  assert.match(block, /process\.argv\.includes\('--no-focus'\)/, 'argv gate kept')
  assert.match(block, /log\.info\(/, 'suppression is observable')
  assert.match(block, /--no-focus/, 'the log names the flag as the cause')
  assert.match(block, /tomatoFloat\.show\(\)/, 'non-suppressed path still shows')
})

