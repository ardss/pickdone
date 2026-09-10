import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { crashSelfHealAction } = require('../src/main/security-lock.js')

/* ---- crashSelfHealAction (P1-1: lock window render-process-gone self-heal) ----
 * Before this fix the lock window was the ONLY window without a crash self-heal: a renderer crash left
 * a white-screen lockWin with isLocked() stuck true and the main window hidden forever. */
test('crashSelfHealAction: real crash reasons rebuild while under the cap', () => {
  for (const reason of ['crashed', 'oom', 'launch-failed', 'integrity-failure']) {
    assert.equal(crashSelfHealAction({ reason, rebuilds: 0 }), 'rebuild')
    assert.equal(crashSelfHealAction({ reason, rebuilds: 2 }), 'rebuild')
  }
})
test('crashSelfHealAction: clean-exit/unknown reason is ignored (quit tears renderers down)', () => {
  assert.equal(crashSelfHealAction({ reason: 'clean-exit', rebuilds: 0 }), 'ignore')
  assert.equal(crashSelfHealAction({ rebuilds: 0 }), 'ignore')
  assert.equal(crashSelfHealAction(), 'ignore')
})
test('crashSelfHealAction: beyond the cap falls back to disable-lock (availability beats lock)', () => {
  assert.equal(crashSelfHealAction({ reason: 'crashed', rebuilds: 3 }), 'fallback')
  assert.equal(crashSelfHealAction({ reason: 'crashed', rebuilds: 9 }), 'fallback')
})
test('crashSelfHealAction: custom cap respected', () => {
  assert.equal(crashSelfHealAction({ reason: 'crashed', rebuilds: 1, maxRebuilds: 1 }), 'fallback')
})

/* ---- wiring: a crashed lock renderer must trigger the rebuild path, not stay locked forever ---- */
test('createSecurityLock: render-process-gone on the lock window rebuilds it (isLocked recovers)', async () => {
  const calls = { sent: [], configWrites: [], shownMain: 0 }
  let lockWinInstance = null
  // Minimal BrowserWindow/webContents stand-in: captures the event wiring lockAppNow installs
  const fakeWC = () => {
    const handlers = {}
    return {
      on: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn) },
      once: (ev, fn) => { (handlers[ev] = handlers[ev] || []).push(fn) },
      send: (ch) => calls.sent.push(ch),
      emit: (ev, ...a) => { for (const fn of handlers[ev] || []) fn(...a) }
    }
  }
  const electron = {
    BrowserWindow: class {
      constructor () {
        this.webContents = fakeWC()
        this.destroyed = false
        lockWinInstance = this
      }

      isDestroyed () { return this.destroyed }
      focus () {}
      loadURL () { return Promise.resolve() }
      on () {}
      destroy () { this.destroyed = true }
    }
  }
  // Inject the electron stub before requiring the module fresh (bust the require cache first:
  // the top-level import already loaded it with the real electron stub-string)
  const require2 = createRequire(import.meta.url)
  const Module = require2('module')
  const resolved = require2.resolve('../src/main/security-lock.js')
  delete require2.cache[resolved]
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electron
    return origLoad.call(this, request, parent, isMain)
  }
  const { createSecurityLock: createFresh } = require2('../src/main/security-lock.js')
  Module._load = origLoad
  const lock = createFresh({
    getMainWindow: () => null,
    showMainOrLock: () => { calls.shownMain++ },
    readConfig: () => ({ enableSecurityLock: true, securityLockPassword: '' }),
    writeConfig: p => calls.configWrites.push(p),
    i18n: { mt: k => k },
    log: { info () {}, warn () {}, error () {} }
  })
  lock.lockAppNow()
  assert.ok(lockWinInstance, 'lock window created')
  assert.equal(lock.isLocked(), true)
  // Simulate a renderer crash: self-heal must destroy the dead window and rebuild a fresh one
  lockWinInstance.webContents.emit('render-process-gone', null, { reason: 'crashed', exitCode: 1 })
  await new Promise(r => setTimeout(r, 400))
  assert.equal(lock.isLocked(), true, 'rebuilt lock window keeps the app locked')
  assert.ok(lockWinInstance.destroyed === false, 'a new lock window instance is live')
  assert.equal(calls.configWrites.length, 0, 'no disable-lock fallback while under the rebuild cap')
})
