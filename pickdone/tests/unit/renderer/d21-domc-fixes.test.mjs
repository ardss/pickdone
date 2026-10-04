/**
 * D21-DOM C renderer fixes — regression guards (source-anchor pins).
 * Fixes covered:
 *   [A1]  TodoBoxView._batchDeleteInner counts a failed deleteTodosMany and toasts the honest
 *         partial-failure key (the bare catch used to swallow a TOTAL batch-delete failure)
 *   [A2]  completeAction.js undo observes the toggleComplete dispatch — success feedback only on
 *         resolve, actionFailedMsg-style error on rejection (was fire-and-forget + unconditional toast)
 *   [A3]  ContextMenuHost watches the menu object by IDENTITY so reopen-while-open re-clamps,
 *         refocuses and refreshes _lastTrigger (ui/openMenu replaces the object wholesale)
 *   [A4]  TaskAccountModal.saveCreate derives dateKey from endTime (DB re-derives from endTime)
 *   [A5]  ContextMenuHost.exec closes the menu in finally even when a handler throws
 *   [A6]  SettingsSyncTab.respondPair requires truthy r && r.ok for the success toast (null = expired branch)
 *   [A7]  filters.save isolates the post-commit filterList refetch — its failure no longer rejects
 *         an already-successful write (retry used to hit the duplicate-name guard)
 *   [A8]  ui.js orphan-cleanup undo observes the restoreFromRecycle dispatch (restored toast on
 *         resolve, actionFailedMsg on reject)
 *   [A9]  SnManageTagsModal.removeTag undo reinstates a placeholder-only tag via ui/commitUserTags
 *   [A10] main.js reminder sound falls back to a WebAudio beep when Audio playback fails
 *   [A12] QuickAddPage stores the 250ms auto-hide handle, cancels on keydown/focus, hides only
 *         when the input is still empty
 *   [A13] SettingsDataTab.loadBackupDirDisplay falls back to the stored setting on lookup failure
 *         (no more silent blank display)
 *   [A14] HabitView.addHabit warns on an empty name instead of silently returning
 *   [A15] DayRail clears the 5s prune timer in beforeUnmount
 *   [A16] undoToast resume() schedules only the REMAINING time (500ms floor) — continuous typing
 *         no longer postpones the undo toast indefinitely
 *   [A17] tomato.loadState gates the todayTomatoCount day-rollover reset on voidExpired (startup
 *         only) so the cross-window re-read cannot zero the count
 * Residual (not fixed this round): [A11] TodoBoxView batch moves bypass repeat-scope questioning.
 * Run: node --test tests/unit/renderer/d21-domc-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

/** Extract a method/function body by name from source (CRLF-safe, brace-matched shallowly). */
const methodSrc = (src, name) => {
  const flat = src.replace(/\r/g, '')
  const m = flat.match(new RegExp(name + ' \\([^)]*\\) \\{'))
  assert.ok(m, name + ' exists')
  let i = flat.indexOf(m[0]) + m[0].length
  let depth = 1
  const start = i
  while (depth > 0 && i < flat.length) {
    if (flat[i] === '{') depth++
    else if (flat[i] === '}') depth--
    i++
  }
  return flat.slice(start, i)
}

/* ---------- [A1] TodoBoxView batch delete honest failure ---------- */

test('[A1] _batchDeleteInner counts a failed deleteTodosMany and toasts msgPartialFail', () => {
  const src = read('renderer/js/views/TodoBoxView.vue').replace(/\r/g, '')
  const fn = methodSrc(src, 'async _batchDeleteInner')
  assert.match(fn, /let failed = 0/, 'failure counter declared')
  assert.match(fn, /catch \{ failed\+\+ \}/, 'the deleteTodosMany catch must count, not vanish')
  assert.match(fn, /msgPartialFail/, 'honest partial-failure toast (reused sibling key)')
})

/* ---------- [A2] completeAction undo observes the dispatch ---------- */

test('[A2] completeAction undo only toasts success after the dispatch resolves; rejection surfaces actionFailedMsg', () => {
  const src = read('renderer/js/utils/completeAction.js').replace(/\r/g, '')
  assert.match(src, /Promise\.resolve\(store\.dispatch\('todo\/toggleComplete', cur\)\)\.then\(/,
    'undo dispatch must be observed, not fire-and-forget')
  // success branch is inside the .then() — closeAll + success toast must appear AFTER it
  const thenIdx = src.indexOf("Promise.resolve(store.dispatch('todo/toggleComplete', cur)).then(")
  const tail = src.slice(thenIdx)
  const closeAllIdx = tail.indexOf('message.closeAll()')
  assert.ok(closeAllIdx > -1 && closeAllIdx < tail.indexOf('}, (e)'), 'success feedback moved into the resolved branch')
  assert.match(tail, /statsH\.main\.actionFailedMsg/, 'rejection surfaces the shared failure message pattern')
})

/* ---------- [A3] ContextMenuHost identity watcher ---------- */

test('[A3] ContextMenuHost watches the menu object by identity and routes open through a shared handler', () => {
  const src = read('renderer/js/components/ContextMenuHost.vue').replace(/\r/g, '')
  assert.match(src, /m \(v\) \{ if \(v && v\.visible\) this\.onMenuOpen\(\) \}/,
    'identity watcher fires on object replacement (reopen-while-open)')
  assert.match(src, /onMenuOpen \(\)/, 'shared open path exists')
  const openFn = methodSrc(src, 'onMenuOpen')
  assert.match(openFn, /_lastTrigger/, 'trigger refresh lives in the shared path')
  assert.match(openFn, /window\.innerWidth - w - 8/, 'viewport clamp lives in the shared path')
  // close path still restores focus via the visible watcher
  assert.match(src, /'m\.visible' \(v\)/)
  assert.match(src, /this\.restoreFocus\(\)/)
})

/* ---------- [A4] TaskAccountModal dateKey from endTime ---------- */

test('[A4] saveCreate derives dateKey from endTime like the DB layer / taskMenu backfill does', () => {
  const src = read('renderer/js/components/TaskAccountModal.vue').replace(/\r/g, '')
  const fn = methodSrc(src, 'saveCreate')
  assert.match(fn, /const endTime = startTs \+ d\.dur \* 60000/, 'endTime computed once up front')
  assert.match(fn, /endTime,\n/, 'record carries the shared endTime')
  assert.match(fn, /dateKey: dayjs\(endTime\)\.format\(FMT\.date\)/, 'dateKey derives from endTime, not startTs')
})

/* ---------- [A5] exec closes the menu in finally ---------- */

test('[A5] ContextMenuHost.exec wraps the handler in try/finally so a throw still closes the menu', () => {
  const src = read('renderer/js/components/ContextMenuHost.vue').replace(/\r/g, '')
  const fn = methodSrc(src, 'exec')
  assert.match(fn, /try \{ it\.fn && it\.fn\(\) \} finally \{ this\.\$store\.commit\('ui\/closeMenu'\) \}/)
})

/* ---------- [A6] respondPair requires truthy r && r.ok ---------- */

test('[A6] respondPair success toast requires truthy r.ok; null falls to the expired branch', () => {
  const src = read('renderer/js/components/settings/SettingsSyncTab.vue').replace(/\r/g, '')
  const fn = methodSrc(src, 'async respondPair')
  assert.match(fn, /\(r && r\.ok\) \? this\.\$message\.success\(this\.\$t\('sync\.pairOkMsg'\)\) : this\.\$message\.warning\(this\.\$t\('sync\.pairExpiredMsg'\)\)/,
    'only a confirmed ok response may toast success')
  assert.ok(!/r\.ok === false \?/.test(fn), 'the old ok===false-only ternary is gone')
})

/* ---------- [A7] filters.save isolates the refetch ---------- */

test('[A7] filters.save keeps a successful write when the filterList refetch throws', () => {
  const src = read('renderer/js/store/filters.js').replace(/\r/g, '')
  const fn = methodSrc(src, 'async save')
  assert.match(fn, /try \{\s*const list = await window\.todoAPI\.dbCall\('filterList'\)/,
    'refetch runs in its own try, separate from the commitCommand await')
  assert.match(fn, /return id/, 'the id is still resolved after a refetch failure')
  assert.ok(fn.indexOf('commitCommand') < fn.indexOf("dbCall('filterList')"), 'commit still happens before the guarded refetch')
})

/* ---------- [A8] ui.js orphan-cleanup undo is observed ---------- */

test('[A8] orphan-cleanup undo observes restoreFromRecycle: restored toast on resolve, failure on reject', () => {
  const src = read('renderer/js/store/ui.js').replace(/\r/g, '')
  const fn = methodSrc(src, 'cleanupInlineCreated')
  assert.match(fn, /dispatch\('todo\/restoreFromRecycle', \{ taskId: createdId \}, \{ root: true \}\)\.then\(/,
    'undo dispatch is observed')
  assert.match(fn, /statsJ\.Confirm\.restored/, 'success confirmation on resolve')
  assert.match(fn, /statsH\.main\.actionFailedMsg/, 'honest failure on reject')
})

/* ---------- [A9] placeholder-tag delete undo reinstates the placeholder ---------- */

test('[A9] removeTag undo reinstates a placeholder-only tag via ui/commitUserTags', () => {
  const src = read('renderer/js/components/side-nav/SnManageTagsModal.vue').replace(/\r/g, '')
  const fn = methodSrc(src, 'async removeTag')
  assert.match(fn, /wasPlaceholderOnly = targets\.length === 0/, 'placeholder-only captured at delete time')
  assert.match(fn, /ui\/commitUserTags/, 'undo uses the single-writer meta commit path')
  assert.match(fn, /!cur\.includes\(t\.name\)/, 'no duplicate placeholder entries on repeated undo')
})

/* ---------- [A10] reminder-sound WebAudio fallback ---------- */

test('[A10] main.js falls back to a WebAudio beep when Audio playback fails', () => {
  const src = read('renderer/js/main.js').replace(/\r/g, '')
  assert.match(src, /\.play\(\)\.catch\(\(\) => playFallbackBeep\(\)\)/, 'play rejection triggers the fallback')
  assert.match(src, /catch \(e\) \{ playFallbackBeep\(\) \}/, 'sync Audio construction failure triggers the fallback too')
  const fn = methodSrc(src, 'function playFallbackBeep')
  assert.match(fn, /AudioContext/, 'self-contained oscillator fallback')
  assert.match(fn, /try \{/, 'AudioContext creation is guarded')
})

/* ---------- [A12] QuickAddPage auto-hide timer races ---------- */

test('[A12] QuickAddPage stores, cancels and re-checks the 250ms auto-hide timer', () => {
  const src = read('renderer/js/views/QuickAddPage.vue').replace(/\r/g, '')
  const onKey = methodSrc(src, 'onKey')
  assert.match(onKey, /clearTimeout\(this\._hideTimer\)/, 'keydown cancels the pending hide')
  const onCreated = methodSrc(src, 'onCreated')
  assert.match(onCreated, /this\._hideTimer = setTimeout\(/, 'handle is stored, not fire-and-forget')
  assert.match(onCreated, /String\(qa\.text\)\.trim\(\)\) return/, 'hides only when the input is still empty')
  assert.match(src, /if \(this\._hideTimer\) \{ clearTimeout\(this\._hideTimer\)/, 're-summon focus and unmount cancel the pending hide')
})

/* ---------- [A13] SettingsDataTab backup-dir fallback ---------- */

test('[A13] loadBackupDirDisplay falls back to the stored setting and surfaces the failure', () => {
  const src = read('renderer/js/components/settings/SettingsDataTab.vue').replace(/\r/g, '')
  const fn = methodSrc(src, 'async loadBackupDirDisplay')
  assert.match(fn, /backupDirShown = this\.st\.backupDir \|\| ''/, 'stored setting is the fallback display value')
  assert.match(fn, /statsH\.main\.actionFailedMsg/, 'failure is surfaced, not silent')
})

/* ---------- [A14] HabitView empty-name create warns ---------- */

test('[A14] addHabit warns on an empty name (same key addMoment uses)', () => {
  const src = read('renderer/js/views/HabitView.vue').replace(/\r/g, '')
  const fn = methodSrc(src, 'addHabit')
  assert.match(fn, /statsB\.HabitView\.nameAndDateRequired/, 'visible warning instead of a dead button')
})

/* ---------- [A15] DayRail prune timer cleanup ---------- */

test('[A15] DayRail stores and clears the 5s prune timer', () => {
  const src = read('renderer/js/components/DayRail.vue').replace(/\r/g, '')
  assert.match(src, /this\._pruneTimer = setTimeout\(/, 'handle stored')
  const un = methodSrc(src, 'beforeUnmount')
  assert.match(un, /clearTimeout\(this\._pruneTimer\)/, 'cleared with the other cleanups')
})

/* ---------- [A16] undoToast resume schedules only the remaining time ---------- */

test('[A16] undoToast tracks the arm deadline; resume/mouseleave schedule the remaining time with a 500ms floor', () => {
  const src = read('renderer/js/utils/undoToast.js').replace(/\r/g, '')
  assert.match(src, /let deadline = 0/, 'deadline tracked per toast')
  assert.match(src, /const arm = \(ms\) => \{/, 'arm accepts an explicit wait')
  assert.match(src, /deadline = Date\.now\(\) \+ wait/, 'deadline recorded on every arm')
  assert.match(src, /resume: \(\) => \{ if \(!timer\) arm\(Math\.max\(500, deadline - Date\.now\(\)\)\) \}/,
    'keyup resume schedules the REMAINING time, floored at 500ms')
  assert.match(src, /el\.addEventListener\('mouseleave', \(\) => \{ if \(!timer\) arm\(Math\.max\(500, deadline - Date\.now\(\)\)\) \}\)/,
    'hover resume uses the same remaining-time arithmetic')
})

/* ---------- [A17] tomato count reset is startup-only ---------- */

test('[A17] loadState gates the todayTomatoCount rollover reset on voidExpired', () => {
  const src = read('renderer/js/store/tomato.js').replace(/\r/g, '')
  assert.match(src, /if \(voidExpired && merged\._countDate !== today\)/,
    'cross-window re-read (voidExpired=false) must not zero the count; startup path unchanged')
})
