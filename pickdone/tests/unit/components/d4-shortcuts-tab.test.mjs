/**
 * D10 domain-B: shortcut input pipeline — renderer capture + main combos.
 * Regression guards for:
 *   #3  modifier-less single keys must not be captured/registered as global hotkeys
 *       (a bare letter saved for toggleMainWindow hijacked that key system-wide)
 *   shift-digit-shortcuts-dead: Shift+digit in-app shortcuts never matched because
 *       input.key carries the shifted character ('!' for Shift+1) while the saved
 *       accelerator is 'ctrl+shift+1'
 * Pure helpers are extracted from source the same way as d4-fixes.test.mjs /
 * w5-settings-split.test.mjs ([component-fixes] pure block + new Function).
 * Run: node --test tests/unit/components/d4-shortcuts-tab.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

function pureFns (file, names, marker) {
  const src = read(file)
  const re = new RegExp('\\[' + (marker || 'component-fixes') + '\\] pure-start[^\\n]*\\n([\\s\\S]*?)\\[' + (marker || 'component-fixes') + '\\] pure-end')
  const m = src.match(re)
  assert.ok(m, `${file}: pure block markers missing`)
  const fn = new Function(m[1] + `\nreturn { ${names.join(', ')} }`)
  return fn()
}

/** shortcuts.js requires 'electron' at the top — for the plain-node pure helpers, take
 *  everything before `function createShortcuts` and drop the require lines. */
function shortcutMainFns (names) {
  const src = read('src/main/shortcuts.js')
  const head = src.slice(0, src.indexOf('function createShortcuts'))
    .split('\n')
    .filter(l => !l.includes("require('") && !l.includes('require("'))
    .join('\n')
  const fn = new Function(head + `\nreturn { ${names.join(', ')} }`)
  return fn()
}

/* ---------- #3: renderer capture rejects modifier-less typing keys ---------- */

test('isCommittableCapture: bare letters/digits rejected, modifier combos and non-typing keys accepted', () => {
  const { isCommittableCapture } = pureFns('renderer/js/components/settings/SettingsShortcutsTab.vue', ['isCommittableCapture', 'captureCombo'])
  // bare letter/digit with no modifier must be rejected (used to be captured and registered system-wide)
  assert.equal(isCommittableCapture({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, 't'), false)
  assert.equal(isCommittableCapture({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, '1'), false)
  // any modifier present → committable
  assert.equal(isCommittableCapture({ ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }, 't'), true)
  assert.equal(isCommittableCapture({ ctrlKey: false, altKey: false, shiftKey: true, metaKey: false }, '1'), true)
  // non-typing keys without a modifier stay committable
  assert.equal(isCommittableCapture({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, 'f5'), true)
  assert.equal(isCommittableCapture({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, ' '), true)
  assert.equal(isCommittableCapture({ ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }, 'delete'), true)
})

test('captureCombo + guard: ctrl+t records ctrl+t, bare t records nothing', () => {
  const { isCommittableCapture, captureCombo } = pureFns('renderer/js/components/settings/SettingsShortcutsTab.vue', ['isCommittableCapture', 'captureCombo'])
  const ctrlT = { ctrlKey: true, altKey: false, shiftKey: false, metaKey: false }
  assert.equal(captureCombo(ctrlT, 't'), 'ctrl+t')
  assert.equal(isCommittableCapture(ctrlT, 't'), true)
  const bare = { ctrlKey: false, altKey: false, shiftKey: false, metaKey: false }
  assert.equal(isCommittableCapture(bare, 't'), false)
})

test('SettingsShortcutsTab wiring: handleCaptureKey rejects non-committable combos with a warning toast', () => {
  const src = read('renderer/js/components/settings/SettingsShortcutsTab.vue')
  assert.match(src, /const combo = captureCombo\(e, k\)[\s\S]*?if \(!isCommittableCapture\(e, k\)\) \{[\s\S]*?\$message\.warning[\s\S]*?this\.stopCapture\(\)[\s\S]*?return[\s\S]*?\}/)
})

/* ---------- #3: main-process clamp on global registration ---------- */

test('hasModifier: global accelerators need at least one modifier', () => {
  const { hasModifier } = shortcutMainFns(['hasModifier'])
  assert.equal(hasModifier('t'), false)
  assert.equal(hasModifier('1'), false)
  assert.equal(hasModifier('f5'), false)
  assert.equal(hasModifier('ctrl+t'), true)
  assert.equal(hasModifier('ctrl+shift+1'), true)
  assert.equal(hasModifier('alt+space'), true)
  assert.equal(hasModifier('cmd+x'), true)
  assert.equal(hasModifier(''), false)
})

test('applyShortcuts clamps modifier-less global combos: toggleMainWindow + quickAddGlobal guarded', () => {
  const src = read('src/main/shortcuts.js')
  assert.match(src, /if \(s\.toggleMainWindow\) \{\s*\n\s*if \(!hasModifier\(s\.toggleMainWindow\)\) \{[\s\S]*?warnUnregistrable[\s\S]*?\} else \{\s*\n\s*registerGlobal/)
  assert.match(src, /if \(s\.quickAddGlobal\) \{\s*\n\s*if \(!hasModifier\(s\.quickAddGlobal\)\) \{[\s\S]*?warnUnregistrable[\s\S]*?\} else \{\s*\n\s*registerGlobal/)
})

/* ---------- shift-digit-shortcuts-dead: normalizeInputKey maps shifted symbols to digits ---------- */

test('normalizeInputKey: Shift+digit before-input fixture builds ctrl+shift+1, not ctrl+shift+!', () => {
  const { normalizeInputKey } = shortcutMainFns(['normalizeInputKey'])
  // real before-input-event fixture: input.key carries the shifted character, input.code the physical digit
  assert.equal(normalizeInputKey({ control: true, shift: true, key: '!', code: 'Digit1' }), '1')
  assert.equal(normalizeInputKey({ shift: true, key: '@', code: 'Digit2' }), '2')
  // no input.code available (older webContents): fall back to the US shifted-symbol table
  assert.equal(normalizeInputKey({ shift: true, key: '!', code: '' }), '1')
  assert.equal(normalizeInputKey({ shift: true, key: ')', code: '' }), '0')
  // unshifted keys pass through unchanged; aliases still resolve
  assert.equal(normalizeInputKey({ shift: false, key: '1', code: 'Digit1' }), '1')
  assert.equal(normalizeInputKey({ key: 'a' }), 'a')
  assert.equal(normalizeInputKey({ key: 'Del' }), 'delete')
})

test('onBeforeInput builds the combo via normalizeInputKey (not raw normalizeKey(input.key))', () => {
  const src = read('src/main/shortcuts.js')
  assert.match(src, /const key = normalizeInputKey\(input\)/)
  assert.ok(!/const key = normalizeKey\(input\.key\)/.test(src), 'shifted-character key must not leak into the combo')
})
