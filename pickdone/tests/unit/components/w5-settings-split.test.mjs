/**
 * W5 wave 1: SettingsModal.vue split by tab — Shortcuts + Data tabs extracted into
 * components/settings/SettingsShortcutsTab.vue + SettingsDataTab.vue, with the pure
 * cross-tab search core in components/settings/settingsSearch.js.
 * Source-level assertions (same paradigm as w1/w2 tests):
 *   - parent imports/registers both children and keeps the v-show visibility contract
 *   - shortcut capture suite + fc970da loading placeholder moved verbatim into the child
 *   - data-management suite (backup/restore/purge) moved verbatim into the data child
 *   - side-effect lifecycles stay in the parent (updater subscription, mask timer, cleanup)
 *   - search pure function is exported and consumed by the parent
 *
 * Run: node --test tests/unit/components/w5-settings-split.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

const parent = read('renderer/js/components/SettingsModal.vue')
const shortcutsTab = read('renderer/js/components/settings/SettingsShortcutsTab.vue')
const dataTab = read('renderer/js/components/settings/SettingsDataTab.vue')
const searchJs = read('renderer/js/components/settings/settingsSearch.js')

test('w5 SettingsModal split: parent imports and registers both tab children', () => {
  assert.match(parent, /import SettingsShortcutsTab from '\.\/settings\/SettingsShortcutsTab\.vue'/)
  assert.match(parent, /import SettingsDataTab from '\.\/settings\/SettingsDataTab\.vue'/)
  assert.match(parent, /components: \{ SettingsShortcutsTab, SettingsDataTab \}/)
  assert.match(parent, /<settings-shortcuts-tab v-show="searching \|\| tab==='shortcuts'" ref="shortcutsTab"\/>/)
  assert.match(parent, /<settings-data-tab v-show="searching \|\| tab==='data'"\/>/)
})

test('w5 SettingsModal split: shortcuts capture suite lives in the child, not the parent', () => {
  for (const fn of ['startCapture', 'stopCapture', 'handleCaptureKey', 'hasConflict', 'formatShortcut', 'resetShortcuts', 'saveShortcuts']) {
    assert.match(shortcutsTab, new RegExp('\\b' + fn + ' \\('), `child missing ${fn}`)
    assert.ok(!new RegExp('\\b' + fn + ' \\(').test(parent), `parent still carries ${fn}`)
  }
  // conflict detection preserved verbatim; save ledger goes through the settings/update action
  // (H7: a bare todoAPI.updateSettings left the store stale and dbMirror wrote old shortcuts back)
  assert.match(shortcutsTab, /shortcutDefs\.some\(d => d\.key !== key && this\.shortcutForm\[d\.key\] === combo\)/)
  assert.match(shortcutsTab, /this\.\$store\.dispatch\('settings\/update', \{ shortcutKeySettings: snap \}\)/)
  assert.ok(!/window\.todoAPI\.updateSettings\(\{ shortcutKeySettings/.test(shortcutsTab), 'child must not bypass the store action')
})

test('w5 SettingsModal split: fc970da loading-placeholder logic preserved in the shortcuts child', () => {
  assert.match(shortcutsTab, /shortcutsLoaded \? formatShortcut\(shortcutForm\[sc\.key\]\) : \$t\('statsE\.SettingsModal\.loadingPlaceholder'\)/)
  assert.match(shortcutsTab, /window\.todoAPI\.getSettings\(\)\.then\(c =>/)
  assert.match(shortcutsTab, /beforeUnmount[\s\S]*?this\.stopCapture\(\)/)
})

test('w5 SettingsModal split: data-management suite lives in the data child, not the parent', () => {
  for (const fn of ['writeBackupNow', 'restoreFromBackup', 'restoreFromAutoBackup', 'parseTodoState', 'restoreTomatoLedger', 'purgeRecycle', 'purgeSeed', 'exportXlsx', 'importFromCsv', 'loadBackupDirDisplay']) {
    assert.match(dataTab, new RegExp('\\b' + fn + ' \\('), `data child missing ${fn}`)
    assert.ok(!new RegExp('\\b' + fn + ' \\(').test(parent), `parent still carries ${fn}`)
  }
  // schemaV guard + write-through set() preserved
  assert.match(dataTab, /schemaV ' \+ td\.schemaV \+ ' > 1/)
  assert.match(dataTab, /this\.\$store\.dispatch\('settings\/update', patch\)/)
})

test('w5 SettingsModal split: close() dirty contract delegated to the shortcuts child via ref', () => {
  assert.match(parent, /const sc = this\.\$refs\.shortcutsTab/)
  assert.match(parent, /if \(sc && sc\.isDirty\(\)\)/)
  assert.match(parent, /sc\.discard\(\)/)
  assert.match(parent, /this\.\$store\.commit\('ui\/toggleSettings', false\)/)
  assert.match(shortcutsTab, /isDirty \(\) \{ return this\.shortcutDirty \}/)
  assert.match(shortcutsTab, /discard \(\) \{[\s\S]*?if \(this\._shortcutSnapshot === undefined\) return[\s\S]*?JSON\.parse\(this\._shortcutSnapshot\)/)
})

test('w5 SettingsModal split: side-effect lifecycles stay in the parent', () => {
  // updater subscription + teardown, delayed mask binding, beforeUnmount cleanup
  assert.match(parent, /this\._updUn = window\.todoAPI\.onUpdaterEvent/)
  assert.match(parent, /if \(this\._updUn\) \{ this\._updUn\(\); this\._updUn = null \}/)
  assert.match(parent, /bindMaskOnce \(\) \{ this\._maskTimer = setTimeout/)
  assert.match(parent, /beforeUnmount[\s\S]*?if \(this\._maskTimer\) clearTimeout\(this\._maskTimer\)/)
  // store write ledger stays unified on the parent's set(patch)
  assert.match(parent, /set \(patch\) \{\s*\n\s*this\.\$store\.dispatch\('settings\/update', patch\)/)
})

test('w5 SettingsModal split: cross-tab search core is a pure exported function consumed by the parent', () => {
  assert.match(searchJs, /export function filterSettingsPanels \(panels, q\)/)
  assert.match(searchJs, /return totalHits/)
  assert.match(parent, /import \{ filterSettingsPanels \} from '\.\/settings\/settingsSearch\.js'/)
  assert.match(parent, /const totalHits = filterSettingsPanels\(panels, q\)/)
  // no DOM mutation inside the module beyond the panel elements passed in (no document/window access)
  assert.ok(!/document\.|window\./.test(searchJs), 'settingsSearch.js must stay pure (no document/window)')
})

test('w5 SettingsModal split: parent slimmed and styles retained in the parent', () => {
  const parentLines = parent.split('\n').length
  assert.ok(parentLines < 800, `SettingsModal.vue should be ~750 lines after wave 1, got ${parentLines}`)
  // generic form-control + sc-capture styles stay global in the parent (shared across tabs, non-scoped)
  assert.match(parent, /\.sc-capture \{/)
  assert.match(parent, /\.form-item \{/)
  assert.ok(!shortcutsTab.includes('<style'), 'shortcuts child must not carry styles')
  assert.ok(!dataTab.includes('<style'), 'data child must not carry styles')
})
