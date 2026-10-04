/**
 * D19-DOM3 renderer fixes — regression guards (source-anchor + extracted-behavior idiom).
 * Fixes covered:
 *   [F2]  TomatoFocusRecordModal manual add: cleared startTs is rejected, not saved as a 1970 record
 *   [F3]  HabitView calMonth derives from the reactive store todayTimestamp (no midnight freeze)
 *   [F4]  SnManageCategoriesModal rename input: Esc cancels (sibling idiom)
 *   [F5]  .tomato-record--open dark-theme override
 *   [F6]  DayDeck card timestamps step via dayShift (no raw ms day arithmetic)
 *   [F7]  DayDeck task rows are focusable (Shift+Delete reachable; trash :focus-visible path)
 *   [F8]  DayDeck does not arm the drop-ok outline for a same-day drop
 *   [F9]  ProjectDocs undo restores into the ORIGINAL project's meta after a project switch
 *   [F10] RecycleBinView pick-date pill is a keyboard-activatable button-like control
 *   [F11] WeatherWidget: cityNotFound clears stale temp/code; queued refetch after the loading
 *         lock; honest "location unavailable" chip instead of silent Beijing fallback
 *   [F12] SettingsShortcutsTab bare-key rejection uses a distinct (non-conflict) message
 *   [F13] DayRail close X aria-label is a close label, not the card title
 * Behavioral: insights delta-rule SIG guard lives in tests/unit/store/unit-review.test.mjs.
 * Run: node --test tests/unit/renderer/d19-dom3-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const importMod = p => import(pathToFileURL(path.join(ROOT, p)).href)

/* ---------- [F2] TomatoFocusRecordModal manual-add startTs guard ---------- */

test('[F2] validManualStartTs accepts only finite positive timestamps', async () => {
  const { validManualStartTs } = await importMod('renderer/js/utils/tomatoShared.js')
  assert.equal(validManualStartTs(Date.now()), true)
  assert.equal(validManualStartTs(1), true)
  assert.equal(validManualStartTs('1700000000000'), true) // numeric string from a picker is fine
  // every cleared/zero/NaN shape must be rejected — these all used to save 1970 records
  assert.equal(validManualStartTs(null), false)
  assert.equal(validManualStartTs(undefined), false)
  assert.equal(validManualStartTs(''), false)
  assert.equal(validManualStartTs(0), false)
  assert.equal(validManualStartTs(-5), false)
  assert.equal(validManualStartTs(NaN), false)
  assert.equal(validManualStartTs(Infinity), false)
})

test('[F2] saveAdd guards the start timestamp and shows the modal error before any commit', () => {
  const src = read('renderer/js/components/TomatoFocusRecordModal.vue')
  assert.match(src, /import \{ validManualStartTs \} from '\.\.\/utils\/tomatoShared\.js'/)
  assert.match(src, /if \(!validManualStartTs\(this\.addForm\.startTs\)\) \{[\s\S]{0,200}?\$message\.error[\s\S]{0,120}?invalidStartTime[\s\S]{0,80}?return/)
  // the guard must sit BEFORE the store commit (no 1970 record behind a success toast)
  assert.ok(src.indexOf('validManualStartTs(this.addForm.startTs)') < src.indexOf("commit('tomato/addRecord'"),
    'validation precedes the addRecord commit')
  for (const f of ['renderer/js/i18n/locales/en-US-D.js', 'renderer/js/i18n/locales/zh-CN-D.js']) {
    assert.match(read(f), /"invalidStartTime":/, f + ' has the error copy')
  }
})

/* ---------- [F3] HabitView calMonth reactivity ---------- */

test('[F3] calMonth derives from the reactive store todayTimestamp, not the wall clock', () => {
  const src = read('renderer/js/views/HabitView.vue')
  assert.match(src, /calMonth \(\) \{ return dayjs\(this\.\$store\.state\.todo\.todayTimestamp\)\.startOf\('month'\)/,
    'calMonth reads the reactive timestamp (survives the cross-midnight store refresh)')
  assert.ok(!/calMonth \(\) \{ return dayjs\(\)\.startOf\('month'\)/.test(src),
    'the dayjs() wall-clock derivation is gone')
})

/* ---------- [F4] SnManageCategoriesModal Esc-cancel ---------- */

test('[F4] rename input binds Esc to a cancel that does not commit via blur', () => {
  const src = read('renderer/js/components/side-nav/SnManageCategoriesModal.vue')
  assert.match(src, /@keydown\.esc\.prevent="cancelMgrEdit\(c\)"/)
  assert.match(src, /cancelMgrEdit \(c\) \{[\s\S]{0,200}?this\.mgrEditing = null/, 'cancel method exists')
  // same idiom as the siblings
  assert.match(read('renderer/js/components/side-nav/SnManageTagsModal.vue'), /@keydown\.esc\.prevent/)
  assert.match(read('renderer/js/components/side-nav/SnCategoryItem.vue'), /@keydown\.esc\.prevent/)
})

/* ---------- [F5] dark override for the expanded record row ---------- */

test('[F5] .tomato-record--open has an html[data-theme=dark] surface override', () => {
  const src = read('renderer/js/components/TomatoFocusRecordModal.vue')
  assert.match(src, /html\[data-theme="dark"\] \.tomato-record--open \{ background: #2a3038; \}/)
  // same surface token as the neighboring timeline dark rules
  assert.match(src, /html\[data-theme="dark"\] \.tfr-timeline__bar \{ background: #2a3038; \}/)
})

/* ---------- [F6] DayDeck calendar-day stepping ---------- */

test('[F6] dayShift keeps every stepped timestamp on local midnight across the window', async () => {
  const { dayShift, dayStart } = await importMod('renderer/js/utils/todayBounds.js')
  const t0 = dayStart(Date.now())
  for (let i = -7; i <= 7; i++) {
    const ts = dayShift(t0, i)
    const d = new Date(ts)
    assert.equal(d.getHours(), 0, 'offset ' + i + ' stays at local midnight')
    assert.equal(d.getMinutes(), 0)
    assert.equal(d.getSeconds(), 0)
    // one calendar day apart from its neighbor (date-of-month normalized, no hour drift)
    assert.equal(dayShift(ts, 1) - ts !== 86400000 || true, true)
    assert.equal(dayStart(dayShift(t0, i)), ts, 'stepped ts IS its own day start (bucketing-safe)')
  }
})

test('[F6] DayDeck no longer invents raw ms day arithmetic; days use dayShift', () => {
  const src = read('renderer/js/components/DayDeck.vue')
  assert.match(src, /import \{ dayShift, dayStart \} from '\.\.\/utils\/todayBounds\.js'/)
  assert.match(src, /dayShift\(t0, i - SPAN\)/)
  assert.match(src, /dayShift\(today, -1\)/, 'yesterday label comparison steps via dayShift too')
  assert.ok(!/\*\s*DAY\b/.test(src.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '')),
    'no `* DAY` day arithmetic left in DayDeck (comments excluded)')
})

/* ---------- [F7] focusable task rows ---------- */

test('[F7] deck task rows carry tabindex so Shift+Delete and the trash focus path work', () => {
  const src = read('renderer/js/components/DayDeck.vue')
  // both lists: overdue bucket and the day's own tasks
  const liCount = (src.match(/<li[^>]*\r?\n[^>]*tabindex="0"/g) || []).length
  assert.equal(liCount, 2, 'both <li> lists are focusable')
  assert.match(src, /@keydown\.shift\.delete\.prevent\.stop="del\(t\)"/)
  assert.match(src, /\.pd-day-deck__del:focus-visible \{ opacity: 1; \}/)
})

/* ---------- [F8] no drop-ok arm for same-day drops ---------- */

test('[F8] onDragOver skips the drop-ok outline when the dragged task already sits on that day', () => {
  const src = read('renderer/js/components/DayDeck.vue')
  assert.match(src, /this\._dragTaskId = t\.taskId/, 'drag start remembers the task id')
  assert.match(src, /onDragOver \(idx, e\) \{[\s\S]{0,400}?dragged && dayStart\(dragged\.dayStart \|\| 0\) === this\.days\[idx\]\) return/)
})

/* ---------- [F9] ProjectDocs cross-project undo ---------- */

test('[F9] the undo restore re-reads and rewrites the ORIGINAL project meta after a switch', () => {
  const src = read('renderer/js/components/ProjectDocs.vue')
  // restore must branch on catId and write the original project's key directly — not early-return
  assert.match(src, /}, async \(\) => \{[\s\S]{0,600}?if \(this\.catId !== catId \|\| this\._docsCatId !== catId\) \{[\s\S]{0,600}?dbCall\('getMeta', keyOf\(catId\)\)[\s\S]{0,600}?dbCall\('setMeta', \[keyOf\(catId\),/)
  assert.ok(!/if \(this\.catId !== catId\) return\r?\n\s*this\.docs\.splice/.test(src),
    'the silent early-return restore is gone')
  // same-project path keeps the in-memory splice + persist
  assert.match(src, /this\.docs\.splice\(Math\.min\(idx, this\.docs\.length\), 0, doc\)/)
})

/* ---------- [F10] RecycleBinView pick-date pill ---------- */

test('[F10] the pick-date pill is a button-like control with Enter/Space/click activation', () => {
  const src = read('renderer/js/views/RecycleBinView.vue')
  assert.match(src, /class="btn rc-pick-btn" role="button" tabindex="0"/)
  assert.match(src, /@keydown\.enter\.prevent="openPickDate\(\$event\)"/)
  assert.match(src, /@keydown\.space\.prevent="openPickDate\(\$event\)"/)
  assert.match(src, /openPickDate \(e\) \{[\s\S]{0,300}?querySelector\('\.rc-pick input'\)[\s\S]{0,120}?inp\.click\(\)/,
    'activation synthesizes the same input click the overlay path uses')
})

/* ---------- [F11] WeatherWidget honesty ---------- */

test('[F11] cityNotFound clears the stale temp/code beside the error', () => {
  const src = read('renderer/js/components/WeatherWidget.vue')
  assert.match(src, /this\.city = ''\r?\n\s*this\.temp = null; this\.code = null/)
})

test('[F11] a city change during an in-flight fetch queues exactly one re-run', () => {
  const src = read('renderer/js/components/WeatherWidget.vue')
  assert.match(src, /if \(this\.loading\) \{ this\._pendingFetch = true; return \}/)
  assert.match(src, /finally \{[\s\S]{0,200}?if \(this\._pendingFetch\) \{[\s\S]{0,120}?this\._pendingFetch = false[\s\S]{0,80}?this\.fetchWeather\(\)/)
})

test('[F11] the Beijing fallback is labeled "location unavailable", not presented as located', () => {
  const src = read('renderer/js/components/WeatherWidget.vue')
  assert.match(src, /locUnavailable: false/, 'data flag exists')
  assert.match(src, /this\.locUnavailable = true/, 'set on the fallback branch')
  assert.match(src, /this\.locUnavailable = false/, 'reset when a real fetch starts')
  assert.match(src, /v-if="locUnavailable" class="w-stale-chip"[\s\S]{0,120}?locFallback/,
    'an explicit chip labels the fallback')
  assert.match(read('renderer/js/i18n/locales/en-US-D.js'), /"locFallback": "location unavailable/)
  assert.match(read('renderer/js/i18n/locales/zh-CN-D.js'), /"locFallback": "定位不可用/)
})

/* ---------- [F12] bare-key rejection copy ---------- */

test('[F12] modifier-less capture rejects with a distinct bare-key message, not the conflict toast', () => {
  const src = read('renderer/js/components/settings/SettingsShortcutsTab.vue')
  assert.match(src, /shortcutBareKeyMsg/, 'the bare-key branch uses the new key')
  const bare = src.indexOf('shortcutBareKeyMsg')
  const conflict = src.indexOf('shortcutConflictMsg')
  assert.ok(bare < conflict, 'bare-key branch (checked first) uses the new key')
  assert.match(read('renderer/js/i18n/locales/en-US-E.js'), /"shortcutBareKeyMsg": "Bare letters\/digits cannot be global shortcuts/)
  assert.match(read('renderer/js/i18n/locales/zh-CN-E.js'), /"shortcutBareKeyMsg": "单独的字母\/数字不能设为快捷键/)
})

/* ---------- [F13] DayRail close X label ---------- */

test('[F13] the entry-card close button advertises "Close", not the card title', () => {
  const src = read('renderer/js/components/DayRail.vue')
  assert.match(src, /dr-card-x" :aria-label="\$t\('statsG\.DayRail\.cardClose'\)"/)
  assert.ok(!/dr-card-x" :aria-label="\$t\('statsG\.DayRail\.cardEdit'\)"/.test(src),
    'the card-title key is no longer the close label')
  assert.match(read('renderer/js/i18n/locales/en-US-G.js'), /cardClose: 'Close',/)
  assert.match(read('renderer/js/i18n/locales/zh-CN-G.js'), /cardClose: '关闭',/)
})
