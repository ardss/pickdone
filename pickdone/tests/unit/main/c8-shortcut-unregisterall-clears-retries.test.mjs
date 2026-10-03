/** C8 (2026-10-02) — unregisterAll must also clear pending hotkey backoff retry timers.
 *
 * The returned unregisterAll (shutdown/relaunch path) used to call only
 * globalShortcut.unregisterAll(): pending 3s/12s/30s retry timers kept firing afterwards and
 * re-registered hotkeys into a tearing-down app. unregisterAll now disarms every pending
 * retry before dropping the registrations (same hygiene applyShortcuts applies on rebind).
 *
 * Run: node --test tests/unit/main/c8-shortcut-unregisterall-clears-retries.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(import.meta.dirname, '../../..')

/** Load shortcuts.js with an electron stub; returns { mod, registrations, timers }. */
function freshShortcuts () {
  const require_ = createRequire(import.meta.url)
  const registrations = []
  const electronStub = {
    globalShortcut: {
      register: (accel) => { registrations.push(accel); return false }, // always conflicted → retries arm
      unregisterAll: () => { registrations.length = 0 }
    },
    ipcMain: { on: () => {} }
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
  try { mod = require_(resolved) } finally { Module._load = origLoad }
  // Fake timer wheel: hand out plain marker objects; fired() runs a due callback.
  const timers = new Set()
  const api = mod.createShortcuts({
    getMainWindow: () => null,
    showMainOrLock: () => {},
    quickAdd: { toggle: () => {} },
    i18n: { mt: k => k },
    log: { warn: () => {} }
  }, {
    setTimeout: (fn, ms) => { const t = { fn, ms }; timers.add(t); return t },
    clearTimeout: t => timers.delete(t)
  })
  const fireDue = () => { for (const t of [...timers]) { timers.delete(t); t.fn() } }
  return { api, registrations, timers, fireDue }
}

const CONF = { toggleMainWindow: 'ctrl+shift+t' } // taken at first attempt → 3 backoff retries arm

test('C8: pending retry timers are disarmed by unregisterAll (no post-shutdown hotkey re-registration)', () => {
  const { api, registrations, timers, fireDue } = freshShortcuts()
  // Test-isolated instances (TODO_USER_DATA_DIR) never register — clear it for this scenario.
  const saved = process.env.TODO_USER_DATA_DIR
  delete process.env.TODO_USER_DATA_DIR
  try {
    assert.equal(api.applyShortcuts(CONF), undefined)
    assert.equal(registrations.length, 1, 'first attempt registered (and failed)')
    assert.equal(timers.size, 3, '3s/12s/30s backoff retry timers armed')
    api.unregisterAll()
    assert.equal(timers.size, 0, 'red before the fix: retry timers survived unregisterAll')
    fireDue()
    assert.equal(registrations.length, 0, 'no retry re-registered a hotkey after unregisterAll')
  } finally {
    if (saved !== undefined) process.env.TODO_USER_DATA_DIR = saved
  }
})

test('C8: without unregisterAll the retries still fire (behavior preserved on the live path)', () => {
  const { api, registrations, timers, fireDue } = freshShortcuts()
  const saved = process.env.TODO_USER_DATA_DIR
  delete process.env.TODO_USER_DATA_DIR
  try {
    api.applyShortcuts(CONF)
    fireDue()
    assert.ok(registrations.length > 1, 'retry attempts still happen when NOT unregistered')
    assert.equal(timers.size > 0 || registrations.length >= 4, true, 'backoff pipeline intact')
  } finally {
    if (saved !== undefined) process.env.TODO_USER_DATA_DIR = saved
  }
})
