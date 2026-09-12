/**
 * H7 round: Settings/SnManage seam fixes on the S2/S3 split pipeline — settings tabs.
 *   1. SettingsShortcutsTab: isDirty/discard safe before the getSettings snapshot resolves
 *      (previously confirm-discard JSON.parsed undefined and the modal could never close)
 *   2. saveShortcuts goes through the settings/update action (store + config.json in one hop,
 *      no dbMirror write-back of stale shortcuts)
 *   7. SettingsModal DOM panel order matches the visual tab order (tomato → data → about)
 *   8. conflict toast colon lives in the i18n value (per-locale punctuation)
 *   9. writeBackupNow polls for the new snapshot (busy flag, no blind 1200ms race)
 *  10. exportXlsx catches dirty subtasks JSON
 *  11. restoreFromAutoBackup field set matches restoreFromBackup (settings + habits + category)
 *  12. restore confirm copy states the merge-restore semantics honestly (bilingual)
 *
 * Run: node --test tests/unit/components/h7-settings-tabs.test.mjs
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
const enE = read('renderer/js/i18n/locales/en-US-E.js')
const zhE = read('renderer/js/i18n/locales/zh-CN-E.js')

test('h7 shortcuts: isDirty is false until the getSettings snapshot resolves', () => {
  assert.match(shortcutsTab, /if \(this\._shortcutSnapshot === undefined\) return false/)
})

test('h7 shortcuts: discard() is a no-op when the snapshot never loaded', () => {
  const discard = shortcutsTab.match(/discard \(\) \{([\s\S]*?)\n\s{4}\}/)[1]
  assert.match(discard, /if \(this\._shortcutSnapshot === undefined\) return/)
  assert.match(discard, /JSON\.parse\(this\._shortcutSnapshot\)/)
  // the guard must precede the parse
  assert.ok(discard.indexOf('undefined') < discard.indexOf('JSON.parse'))
})

test('h7 shortcuts: saveShortcuts commits through settings/update (no bare IPC bypass)', () => {
  assert.match(shortcutsTab, /const snap = JSON\.parse\(JSON\.stringify\(this\.shortcutForm\)\)/)
  assert.match(shortcutsTab, /this\.\$store\.dispatch\('settings\/update', \{ shortcutKeySettings: snap \}\)/)
  assert.ok(!/window\.todoAPI\.updateSettings/.test(shortcutsTab), 'bare todoAPI.updateSettings lets dbMirror write stale shortcuts back')
  // snapshot updated after save so isDirty returns false immediately
  const save = shortcutsTab.match(/saveShortcuts \(\) \{([\s\S]*?)\n\s{4}\}/)[1]
  assert.match(save, /this\._shortcutSnapshot = JSON\.stringify\(this\.shortcutForm\)/)
})

test('h7 shortcuts: conflict toast takes the colon from the i18n value', () => {
  assert.match(shortcutsTab, /\$t\('statsE\.SettingsModal\.shortcutConflictMsg', \{ combo \}\)/)
  assert.ok(!/shortcutConflictTitle[\s\S]{0,80}'：'/.test(shortcutsTab), 'hardcoded full-width colon must be gone')
  assert.match(enE, /"shortcutConflictMsg": "Shortcut conflict: \{combo\}"/)
  assert.match(zhE, /"shortcutConflictMsg": "快捷键冲突：\{combo\}"/)
})

test('h7 settings modal: DOM panel order matches tab order (tomato → data → about)', () => {
  const tomato = parent.indexOf("tab==='tomato'")
  const data = parent.indexOf("<settings-data-tab")
  const about = parent.indexOf("tab==='about'")
  assert.ok(tomato > -1 && data > -1 && about > -1)
  assert.ok(tomato < data, 'data tab must come after tomato in the DOM')
  assert.ok(data < about, 'data tab must come before about in the DOM (was trailing the file)')
  // the about panel no longer carries the stale "Data management" comment
  const aboutBlock = parent.slice(about, parent.indexOf('</template>'))
  assert.ok(!aboutBlock.includes('<!-- Data management -->'))
})

test('h7 data tab: writeBackupNow polls instead of a blind 1200ms timeout', () => {
  const fn = dataTab.match(/async writeBackupNow \(\) \{([\s\S]*?)\n\s{4}\},/)[1]
  assert.ok(!/setTimeout\(\(\) =>/.test(fn), 'blind setTimeout race must be gone')
  assert.match(fn, /readCriticalStateBackup/)
  assert.match(fn, /Date\.now\(\) \+ 5000/)
  assert.match(fn, /this\.backingUp = true/)
  // busy flag wired to the button to block double-click re-entry
  assert.match(dataTab, /:disabled="backingUp" @click="writeBackupNow"/)
})

test('h7 data tab: exportXlsx catches failures and tolerates dirty subtasks JSON', () => {
  assert.match(dataTab, /catch \(e\) \{\s*\n\s*\/\/ Dirty subtask JSON[\s\S]*?exportFailedMsg/)
  assert.match(dataTab, /subtaskLines \(raw\) \{[\s\S]*?try \{ return \(JSON\.parse\(raw \|\| '\[\]'\)\)[\s\S]*?\} catch \{ return '' \}/)
  assert.match(enE, /"exportFailedMsg": "Export failed: "/)
  assert.match(zhE, /"exportFailedMsg": "导出失败："/)
  assert.ok(!/\(JSON\.parse\(t\.subtasks/.test(dataTab), 'raw subtask parse must go through the guarded helper')
})

test('h7 data tab: restore field set (settings + habits + category) — deduped into the shared applyRestoreDump', () => {
  // P3 (2026-09-12): both restore paths funnel through one shared applyRestoreDump; the segment
  // set is asserted there once instead of in two hand-copied method bodies
  for (const caller of ['restoreFromAutoBackup', 'restoreFromBackup']) {
    const m = dataTab.match(new RegExp('(async )?' + caller + ' \\(\\) \\{[\\s\\S]*?\\n {4}\\}'))
    assert.ok(m && m[0].includes('applyRestoreDump'), caller + ' must funnel through applyRestoreDump')
  }
  const dump = dataTab.match(/async applyRestoreDump \(dump\) \{([\s\S]*?)\n {4}\}/)[1]
  for (const seg of ["commit('settings/restore'", "commit('category/setList'", "commit('habits/replaceAll'", 'restoreTomatoLedger(b)', 'parseTodoState(b.todoState)']) {
    assert.ok(dump.includes(seg), `shared restore pipeline missing ${seg}`)
  }
})

test('h7 data tab: both restore confirm copies state the merge semantics (bilingual)', () => {
  assert.match(enE, /"criticalRestoreConfirmMsg": "[^"]*merge-restored[^"]*"/)
  assert.match(enE, /"autoRestoreConfirm": "[^"]*Merge-restore[^"]*"/)
  assert.match(zhE, /"criticalRestoreConfirmMsg": "[^"]*合并恢复[^"]*"/)
  assert.match(zhE, /"autoRestoreConfirm": "[^"]*合并恢复[^"]*"/)
})
