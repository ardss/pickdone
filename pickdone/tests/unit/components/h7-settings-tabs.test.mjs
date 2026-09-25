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
  // F6 (2026-09-24): the poll moved into verifySnapshotWritten; writeBackupNow delegates to it
  assert.match(fn, /await this\.verifySnapshotWritten\(\)/)
  const helper = dataTab.match(/async verifySnapshotWritten \(\) \{([\s\S]*?)\n\s{4}\},/)[1]
  assert.match(helper, /readCriticalStateBackup/)
  assert.match(helper, /Date\.now\(\) \+ 7[0-9]00/, 'poll window covers the store-side 5s debounce')
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
  for (const seg of ["commit('settings/restore'", "commit('category/setListRestore'", "commit('habits/replaceAll'", 'restoreTomatoLedger(b)', 'parseTodoState(b.todoState)']) {
    assert.ok(dump.includes(seg), `shared restore pipeline missing ${seg}`)
  }
})

test('h7 data tab: both restore confirm copies state the merge semantics (bilingual)', () => {
  assert.match(enE, /"criticalRestoreConfirmMsg": "[^"]*merge-restored[^"]*"/)
  assert.match(enE, /"autoRestoreConfirm": "[^"]*Merge-restore[^"]*"/)
  assert.match(zhE, /"criticalRestoreConfirmMsg": "[^"]*合并恢复[^"]*"/)
  assert.match(zhE, /"autoRestoreConfirm": "[^"]*合并恢复[^"]*"/)
})

test('sync-hardening: restored todo rows are stamped dirty so LAN LWW / cloud filter cannot self-revert the restore', () => {
  // Backup rows carry backup-time updateTime + status:'sync': peers holding newer rows would
  // win LWW within one round, and the cloud dirty filter skips status:'sync' — the restore
  // silently reverted itself. Every restored row must be re-stamped status:'update' + fresh
  // updateTime (restore = the user wants the backup's data to win).
  assert.match(dataTab, /function restoreStampRow \(row, now = null\) \{[\s\S]*?status: 'update', updateTime: now \|\| Date\.now\(\)/)
  const dump = dataTab.match(/async applyRestoreDump \(dump\) \{([\s\S]*?)\n {4}\}/)[1]
  assert.ok(dump.includes('rows.push(restoreStampRow(r))'),
    'both todoList and recycleList rows must go through restoreStampRow before upsertMany')
  assert.ok(!dump.includes('rows.push(r))\n'), 'no unstamped row may reach upsertMany')
  // behavioral check on the extracted helper
  const fn = new Function(dataTab.match(/function restoreStampRow[\s\S]*?\n\}/)[0] + '\nreturn restoreStampRow')()
  const now = 1700000000000
  const stamped = fn({ taskId: 't1', status: 'sync', updateTime: 123 }, now)
  assert.equal(stamped.status, 'update')
  assert.equal(stamped.updateTime, now)
  assert.equal(stamped.taskId, 't1') // rest of the row carried over
  assert.equal(fn(null, now), null) // defensive
})

// ---------------- 2026-09-26 wave: B13 SCHEMA_V guard + B2 filter/plan LWW restamp + metaState restore ----------------

test('B13: parseTodoState guards against the shared SCHEMA_V constant, not a hardcoded literal', () => {
  // The literal '> 1' duplicated SCHEMA_V as a second source of truth (parseStampedSeg already
  // uses the constant); it must read '> SCHEMA_V' so a future SCHEMA_V bump keeps both guards in lockstep.
  assert.match(dataTab, /Number\(td\.schemaV\) > SCHEMA_V/, 'parseTodoState must compare against SCHEMA_V')
  assert.ok(!/> 1 \(backup from a newer app version\)/.test(dataTab), 'the hardcoded "> 1" literal error copy must be gone')
  // the error message interpolates the constant, mirroring parseStampedSeg
  const fn = dataTab.match(/parseTodoState \(raw\) \{[\s\S]*?\n {4}\},/)[0]
  assert.match(fn, /\+ SCHEMA_V \+/)
})

test('B2: restored saved-filter rows are re-stamped fresh (LAN LWW cannot self-revert the restore)', () => {
  assert.match(dataTab, /function restoreStampLww \(row, now\) \{[\s\S]*?updatedAt: now \}/)
  const fn = dataTab.match(/async restoreSavedFilters \(b\) \{[\s\S]*?\n {4}\},/)[0]
  assert.match(fn, /restoreStampLww\(f, now\)/, 'filter rows must go through restoreStampLww before filter.putMany')
  assert.match(fn, /const now = Date\.now\(\)/, 'the stamp is batched once per restore')
  assert.ok(!/putMany', list\)/.test(fn), 'the raw backup list must NOT reach filter.putMany un-stamped')
})

test('B2: restored plan-chip rows are re-stamped fresh (same LWW rule as filters)', () => {
  const fn = dataTab.match(/async restorePlanChips \(b\) \{[\s\S]*?\n {4}\},/)[0]
  assert.match(fn, /restoreStampLww\(c, now\)/, 'chips must go through restoreStampLww before plan.putMany')
  assert.match(fn, /const now = Date\.now\(\)/)
  assert.ok(!/putMany', chips\)/.test(fn), 'the raw backup chips must NOT reach plan.putMany un-stamped')
})

test('metaState: applyRestoreDump restores the meta segment through the whitelisted meta.put door', () => {
  const dump = dataTab.match(/async applyRestoreDump \(dump\) \{([\s\S]*?)\n {4}\}/)[1]
  assert.ok(dump.includes('restoreMetaState(b)'), 'the metaState segment must be restored in the shared pipeline')
  const fn = dataTab.match(/async restoreMetaState \(b\) \{[\s\S]*?\n {4}\},/)[0]
  const wl = dataTab.match(/const META_RESTORE_PREFIXES = \[[\s\S]*?\]/)[0]
  for (const prefix of ['repeatRule:', 'tomatoEstimateState:', 'projectDeadline:', 'projectStatus:', 'projectCategoryFlag:', 'projectMilestones:', 'projectCategoryIds']) {
    assert.ok(wl.includes("'" + prefix + "'"), `restore whitelist must cover ${prefix}`)
  }
  assert.match(fn, /META_RESTORE_PREFIXES/, 'restore filters entries through META_RESTORE_PREFIXES')
  assert.match(fn, /commitCommand\('meta', 'put'/, 'meta entries go through the same command door as the habits blob')
  assert.match(fn, /parseStampedSeg\(b\.metaState\)/, 'the segment is schemaV-guarded like every other stamped segment')
  assert.match(fn, /invalidateEstimateCache/, 'the memoized tomato-estimate cache is invalidated after a restore')
})
