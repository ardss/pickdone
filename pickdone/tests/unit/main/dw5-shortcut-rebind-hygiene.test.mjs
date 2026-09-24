/**
 * dw wave5 P1 (2026-09-24) — shortcut rebind hygiene must not strip foreign webContents listeners.
 * Regression for: applyShortcuts used webContents.removeAllListeners() on
 * before-input-event / did-finish-load / render-process-gone, which also removed the main
 * window's crash self-heal + load-retry listeners wired in windows.js (they hang on the SAME
 * webContents). Effect at the user: a renderer crash after any cold start / shortcut re-bind
 * left a dead window with no auto reload → relaunch.
 * Run: node --test tests/unit/main/dw5-shortcut-rebind-hygiene.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'module'

const ROOT = path.resolve(import.meta.dirname, '../../..')

/** Load shortcuts.js with electron stubbed. */
function loadShortcuts () {
  const require_ = createRequire(import.meta.url)
  const ipcHandlers = {}
  const electronStub = {
    globalShortcut: { register: () => true, unregisterAll: () => {} },
    ipcMain: { on: (ch, h) => { ipcHandlers[ch] = h } }
  }
  const Module = require_('module')
  const resolved = require_.resolve(path.join(ROOT, 'src/main/shortcuts.js'))
  delete require_.cache[resolved]
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub
    return origLoad.call(this, request, parent, isMain)
  }
  let mod
  try {
    mod = require_(resolved)
  } finally { Module._load = origLoad }
  return { mod, ipcHandlers }
}

/** Fake webContents that records every attached listener per event, exactly like EventEmitter. */
function fakeWebContents () {
  const listeners = {}
  return {
    isDestroyed: () => false,
    on (ev, h) { (listeners[ev] = listeners[ev] || []).push(h) },
    removeListener (ev, h) {
      const arr = listeners[ev] || []
      const i = arr.indexOf(h)
      if (i >= 0) arr.splice(i, 1)
    },
    emit (ev, ...args) { for (const h of [...(listeners[ev] || [])]) h(...args) },
    count (ev) { return (listeners[ev] || []).length },
    send () {}, // shortcut-action sink; individual tests may override to capture
    listeners
  }
}

function setup () {
  const { mod } = loadShortcuts()
  const wc = fakeWebContents()
  const win = { isDestroyed: () => false, webContents: wc }
  const api = mod.createShortcuts({
    getMainWindow: () => win,
    showMainOrLock: () => {},
    quickAdd: { toggle: () => {} },
    i18n: { mt: k => k },
    log: { warn: () => {} }
  })
  return { api, wc, win }
}

test('P1: re-binding shortcuts preserves foreign did-finish-load / render-process-gone listeners (crash self-heal survives)', () => {
  const { api, wc } = setup()
  // Foreign listeners shaped like windows.js:135-159 (crash self-heal) and :96 (load-retry reset)
  let foreignLoadCalls = 0
  let foreignGoneCalls = 0
  wc.on('did-finish-load', () => { foreignLoadCalls++ })
  wc.on('render-process-gone', () => { foreignGoneCalls++ })
  api.applyShortcuts({ deleteEvent: 'ctrl+d' })
  // Settings re-bind #1 and #2 — the old code stripped ALL listeners on every call
  api.applyShortcuts({ deleteEvent: 'ctrl+e' })
  api.applyShortcuts({ deleteEvent: 'ctrl+f' })
  wc.emit('did-finish-load')
  wc.emit('render-process-gone', { reason: 'crashed', exitCode: -1 })
  assert.equal(foreignLoadCalls, 1, 'the windows.js load-retry reset listener must survive two rebinds')
  assert.equal(foreignGoneCalls, 1, 'the windows.js crash self-heal listener must survive two rebinds')
})

test('P1: re-binding shortcuts preserves foreign before-input-event listeners and does not stack duplicates', () => {
  const { api, wc } = setup()
  let foreignCalls = 0
  wc.on('before-input-event', () => { foreignCalls++ }) // e.g. a future main-process hook on the same wc
  api.applyShortcuts({ deleteEvent: 'ctrl+d' })
  assert.equal(wc.count('before-input-event'), 2, 'own dispatcher + the one foreign listener')
  api.applyShortcuts({ deleteEvent: 'ctrl+e' })
  api.applyShortcuts({ deleteEvent: 'ctrl+f' })
  assert.equal(wc.count('before-input-event'), 2, 'rebinds must remove the OWN previous dispatcher, not accumulate one per rebind')
  assert.equal(wc.count('did-finish-load'), 1, 'exactly one OWN suppression reset after rebinding (no foreign listener here)')
  assert.equal(wc.count('render-process-gone'), 1, 'exactly one OWN suppression reset after rebinding (no foreign listener here)')
  wc.emit('before-input-event', { preventDefault: () => {} }, { type: 'keyboard', control: true, key: 'f' })
  assert.equal(foreignCalls, 1, 'the foreign before-input-event listener still fires')
})

test('P1: shortcut dispatch still works after a rebind (no behavior change on the happy path)', () => {
  const { api, wc } = setup()
  const sent = []
  wc.send = (ch, p) => sent.push([ch, p])
  api.applyShortcuts({ deleteEvent: 'ctrl+d' })
  wc.emit('before-input-event', { preventDefault: () => {} }, { type: 'keyboard', control: true, key: 'd' })
  assert.deepEqual(sent, [['shortcut-action', 'deleteEvent']])
  // rebind to a new combo: old combo must stop dispatching, new combo must dispatch
  api.applyShortcuts({ deleteEvent: 'ctrl+e' })
  sent.length = 0
  wc.emit('before-input-event', { preventDefault: () => {} }, { type: 'keyboard', control: true, key: 'd' })
  assert.equal(sent.length, 0, 'the old combo is unbound after a rebind')
  wc.emit('before-input-event', { preventDefault: () => {} }, { type: 'keyboard', control: true, key: 'e' })
  assert.deepEqual(sent, [['shortcut-action', 'deleteEvent']])
})

test('P1: source shape — no removeAllListeners call remains in shortcuts.js', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(path.join(ROOT, 'src/main/shortcuts.js'), 'utf8')
    .split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n') // code only, comments stripped
  assert.doesNotMatch(src, /removeAllListeners\(/, 'webContents.removeAllListeners must never come back in the rebind path')
  assert.match(src, /removeListener\(/, 'own handlers are removed by exact reference')
})
