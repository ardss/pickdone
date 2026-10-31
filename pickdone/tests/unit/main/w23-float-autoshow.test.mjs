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

test('W23 P1-1: registerFloatAutoShow is a named function armed as bootstrap() first statement', () => {
  assert.match(mainSrc, /function registerFloatAutoShow \(\)/, 'named registration function exists')
  // armed BEFORE the first await of the serial chain (any statement may throw; the timer must not)
  const iBoot = mainSrc.indexOf('async function bootstrap ()')
  const iCall = mainSrc.indexOf('registerFloatAutoShow()', iBoot)
  const iFirstAwait = mainSrc.indexOf('await', iBoot)
  assert.ok(iCall > 0, 'bootstrap calls registerFloatAutoShow()')
  assert.ok(iCall < iFirstAwait, 'registration precedes the first await — earlier failures cannot skip it')
  // the call is wrapped so even the registration itself cannot break the boot chain silently
  const registerBody = mainSrc.slice(mainSrc.indexOf('function registerFloatAutoShow'), iBoot)
  assert.match(registerBody, /try \{[\s\S]*setTimeout\(/, 'timer registration inside try')
  assert.match(registerBody, /console\.error\('/, 'registration failure is loud, not silent')
})

test('W23 P1-1: gate semantics preserved (isMainShell / 6s / todoAPI / enableTomatoFloating / marker)', () => {
  const body = mainSrc.slice(mainSrc.indexOf('function registerFloatAutoShow'), mainSrc.indexOf('async function bootstrap'))
  assert.match(body, /if \(!isMainShell\) return/, 'aux shells never register')
  assert.match(body, /setTimeout\(/, 'timer present')
  assert.match(body, /, 6000\)/, '6s delay unchanged')
  assert.match(body, /if \(!window\.todoAPI\) return/, 'todoAPI presence gate kept')
  assert.match(body, /enableTomatoFloating === false/, 'settings gate kept (strict boolean false)')
  assert.match(body, /getMeta', 'tomatoFloatClosedByUser'/, 'user-closed marker gate kept (F12)')
  assert.match(body, /v === '1'\) return/, 'marker value check kept')
})

test('W23 P1-1/P3: gate skip logs its reason; show invoke rejection is warned, not swallowed', () => {
  const body = mainSrc.slice(mainSrc.indexOf('function registerFloatAutoShow'), mainSrc.indexOf('async function bootstrap'))
  assert.match(body, /console\.info\('\[float-auto-show\] skipped/, 'enableTomatoFloating=false skip is observable (W23 P2)')
  assert.match(body, /showTomatoFloat\(\)\)\.catch\(e => console\.warn\(/, 'invoke rejection recorded (W23 P3)')
  const bodyCode = body.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')
  assert.doesNotMatch(bodyCode, /\.catch\(\(\) => \{\}\)/, 'no silent catch remains in the registration block')
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
