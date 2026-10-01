/* D14 C11 regression — in-app shortcut matching canonicalizes modifiers. The before-input-event
 * combo builder used to drop the meta/cmd modifier entirely and compare the saved accelerator as
 * a raw string, so a saved cmd+… entry never matched its keystroke. Saved combos may use any
 * modifier synonym (cmd/command/super/meta, control, option) in any order; canonCombo normalizes
 * both sides of the match. Run:
 * node --test tests/unit/main/d14-c11-shortcut-meta-combo.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const Module = require_('module')
const ROOT = path.resolve(import.meta.dirname, '../../..')

/** Minimal dw4-style harness: stub electron, capture the before-input-event handler. */
function setupShortcuts (savedTable) {
  const sent = []
  const electronStub = {
    globalShortcut: { register: () => true, unregisterAll: () => {} },
    ipcMain: { on: () => {} },
  }
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub
    return origLoad.call(this, request, parent, isMain)
  }
  const resolved = require_.resolve(path.join(ROOT, 'src/main/shortcuts.js'))
  delete require_.cache[resolved]
  let mod
  try { mod = require_(resolved) } finally { Module._load = origLoad }
  let beforeInput = null
  const webContents = {
    isDestroyed: () => false,
    on (ev, h) { if (ev === 'before-input-event') beforeInput = h },
    removeListener () {},
    send: (ch, payload) => sent.push([ch, payload]),
  }
  const win = { isDestroyed: () => false, webContents }
  const api = mod.createShortcuts({
    getMainWindow: () => win,
    showMainOrLock: () => {},
    quickAdd: { toggle: () => {} },
    i18n: { mt: k => k },
    log: { warn: () => {} },
  })
  api.applyShortcuts(savedTable)
  return { mod, sent, fire: input => beforeInput({ preventDefault: () => {} }, input) }
}

test('C11: a saved cmd/meta combo fires from a real meta-key keystroke', () => {
  const h = setupShortcuts({ sync: 'ctrl+s', deleteEvent: 'cmd+d', addEvent: 'ctrl+n', toggleMainWindow: '', quickAddGlobal: '' })
  // red before the fix: the builder dropped input.meta, so the combo was 'd' ≠ 'cmd+d'
  h.fire({ type: 'keyDown', meta: true, key: 'd', code: 'KeyD' })
  assert.deepEqual(h.sent, [['shortcut-action', 'deleteEvent']], 'meta keystroke matches the saved cmd+ combo')
  // modifier synonyms and order canonicalize on BOTH sides
  const h2 = setupShortcuts({ sync: 'ctrl+s', deleteEvent: 'meta+shift+d', addEvent: 'ctrl+n', toggleMainWindow: '', quickAddGlobal: '' })
  h2.fire({ type: 'keyDown', shift: true, meta: true, key: 'd', code: 'KeyD' })
  assert.deepEqual(h2.sent, [['shortcut-action', 'deleteEvent']], 'synonym+order-insensitive match')
  // ctrl combos keep working (no regression on the exact-match path)
  const h3 = setupShortcuts({ sync: 'ctrl+s', deleteEvent: 'ctrl+d', addEvent: 'ctrl+n', toggleMainWindow: '', quickAddGlobal: '' })
  h3.fire({ type: 'keyDown', control: true, key: 'd', code: 'KeyD' })
  assert.deepEqual(h3.sent, [['shortcut-action', 'deleteEvent']])
})

test('C11: canonCombo normalizes synonyms and orders modifiers deterministically', () => {
  const h = setupShortcuts({ sync: 'ctrl+s', deleteEvent: '', addEvent: '', toggleMainWindow: '', quickAddGlobal: '' })
  const { canonCombo } = h.mod
  assert.equal(canonCombo('cmd+k'), canonCombo('meta+k'))
  assert.equal(canonCombo('command+k'), canonCombo('meta+k'))
  assert.equal(canonCombo('super+k'), canonCombo('meta+k'))
  assert.equal(canonCombo('shift+ctrl+k'), canonCombo('ctrl+shift+k'))
  assert.equal(canonCombo('control+alt+del'), canonCombo('ctrl+alt+del'))
})
