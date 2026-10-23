/**
 * W7 ux fixes (2026-10-23) — cross-view UX batch regression tests
 * (source-contract style, same seam as the d-wave / f-series; plus pure-logic tests where the
 * module imports cleanly in plain node).
 *
 * Covered:
 *   W7-1  MatrixGrid: quadrant keyboard moves moved off Ctrl+1..4 (clashed with the global
 *         navigation shortcuts switchToDaytodo..switchToInbox) to Ctrl+Alt+1..4; aria-keyshortcuts synced.
 *   W7-2  StatisticsView CSV filename uses the localized period label (not the raw enum key)
 *         with filesystem-illegal chars sanitized.
 *   W7-3  StatisticsView cardError latch resets on period/view change (syncQuery) and keep-alive re-entry.
 *   W7-4  StatisticsView date labels go through the FMT table (no hardcoded MM.DD / YYYY.MM.DD).
 *   W7-5  StatisticsView best-item v-for key uses the raw i18n key, not translated text.
 *   W7-6  StatisticsView CSV export toast is honest (download-location copy, new i18n key).
 *   W7-7  TomatoBar float toggle failure surfaces reportDispatchFail instead of a silent catch.
 *   W7-8  HabitView freqLabel sorts weekday indices numerically (click order no longer leaks).
 *   W7-9  HabitView memorial moment rejects future dates (input :max + submit guard).
 *   W7-10 TaskAccountModal commitDraft/saveCreate reject same-day interval overlaps, editor stays open.
 *   W7-11 TaskAccountModal Esc/backdrop/X close guards a dirty draft with a confirm.
 *   W7-12 layout.vue edit-panel width restore tracks manual resizes while the panel is open (debounced), listener cleaned up.
 *   W7-13 SettingsShortcutsTab: Delete/Backspace during capture clears the binding; hint copy ships in both locales.
 *
 * Run: node --test tests/unit/renderer/w7-ux-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

const MATRIX = read('renderer/js/components/MatrixGrid.vue')
const STATS = read('renderer/js/views/StatisticsView.vue')
const TOMATO_BAR = read('renderer/js/components/TomatoBar.vue')
const HABIT = read('renderer/js/views/HabitView.vue')
const ACCOUNT = read('renderer/js/components/TaskAccountModal.vue')
const SHORTCUTS = read('renderer/js/components/settings/SettingsShortcutsTab.vue')
const LAYOUT = read('renderer/js/layout.vue')
const ZH_E = read('renderer/js/i18n/locales/zh-CN-E.js')
const EN_E = read('renderer/js/i18n/locales/en-US-E.js')

const W7_KEYS = ['csvExportedSaved', 'memorialFutureDate', 'accountTimeOverlap', 'accountDiscardConfirm', 'scClearHint']

/* W7-1: quadrant shortcuts move to Ctrl+Alt+N (Ctrl+N is the global nav row) */
test('W7-1: MatrixGrid quadrant shortcuts are ctrl.alt.1..4 with synced aria-keyshortcuts', () => {
  for (const n of [1, 2, 3, 4]) assert.match(MATRIX, new RegExp(`@keydown\\.ctrl\\.alt\\.${n}\\.prevent="kbdQuadrant\\(t, ${n - 1}\\)"`))
  assert.ok(!/@keydown\.ctrl\.[1-4]\b/.test(MATRIX), 'bare Ctrl+N quadrant handlers must be gone')
  assert.match(MATRIX, /aria-keyshortcuts="Control\+Alt\+1 Control\+Alt\+2 Control\+Alt\+3 Control\+Alt\+4"/)
})

/* W7-2: CSV filename uses the localized period label + sanitization */
test('W7-2: export filename embeds the localized period label, sanitized, not the raw enum', () => {
  assert.ok(!/a\.download = .*this\.period}_/.test(STATS), 'raw this.period must leave the filename')
  assert.match(STATS, /periodOptions\.find\(p => p\.key === this\.period\)/, 'label resolves from the same source the pills render')
  assert.match(STATS, /\.replace\(\/\[/, 'illegal-char cleanup present')
})

test('W7-2b: the sanitization regex strips filesystem-illegal characters (logic mirror)', () => {
  const clean = s => String(s).replace(/[\\/:*?"<>|]/g, '-').trim()
  assert.equal(clean('thisWeek'), 'thisWeek')
  assert.equal(clean('10.12 - 10.19'), '10.12 - 10.19') // dots are legal
  assert.equal(clean('a/b\\c:d*e?f"g<h>i|j'), 'a-b-c-d-e-f-g-h-i-j')
})

/* W7-3: cardError latch resets */
test('W7-3: cardError resets on period/view change (syncQuery) and keep-alive re-entry (activated)', () => {
  assert.match(STATS, /syncQuery \(\) \{[\s\S]{0,300}this\.cardError = false/, 'syncQuery clears the latch')
  assert.match(STATS, /activated \(\) \{[\s\S]{0,120}this\.cardError = false[\s\S]{0,20}\}/, 'activated clears the latch')
})

/* W7-4: FMT-table date labels */
test('W7-4: period range label and shareDate go through FMT, no hardcoded MM.DD/YYYY.MM.DD', () => {
  assert.match(STATS, /import \{ dayjs, DAY_MS, FMT \} from '\.\.\/utils\/core\.js'/)
  assert.ok(!/format\('MM\.DD'\)/.test(STATS), 'MM.DD literal must be gone')
  assert.ok(!/format\('YYYY\.MM\.DD'\)/.test(STATS), 'YYYY.MM.DD literal must be gone')
  assert.match(STATS, /periodRangeLabel[\s\S]{0,900}format\(FMT\.cnDate\)/)
  assert.match(STATS, /shareDate \(\) \{ return dayjs\(\)\.format\(FMT\.cnFull\) \}/)
})

/* W7-5: stable v-for key for best items */
test('W7-5: best-item key is the raw key, not $t() output', () => {
  assert.match(STATS, /:key="String\(b\.titleKey \|\| b\.title\)"/)
  assert.ok(!/:key="\$t\(b\.titleKey/.test(STATS))
})

/* W7-6: honest CSV export copy (new paired i18n key) */
test('W7-6: export success toast uses the download-location key in both locales', () => {
  assert.match(STATS, /\$t\('statsE\.w7\.csvExportedSaved'\)/)
  assert.ok(!/msgTableExported/.test(STATS))
  for (const loc of [ZH_E, EN_E]) assert.match(loc, /csvExportedSaved/)
})

/* W7-7: float toggle failure is surfaced */
test('W7-7: TomatoBar toggleFloat catch reports through reportDispatchFail', () => {
  assert.match(TOMATO_BAR, /\} catch \(e\) \{ this\.reportDispatchFail\(e\)/)
  assert.match(TOMATO_BAR, /reportDispatchFail \(e\) \{/)
})

/* W7-8: weekday labels sorted numerically */
test('W7-8: freqLabel sorts weekday indices before mapping to labels', () => {
  assert.match(HABIT, /freqLabel[\s\S]{0,400}\(f\.weekdays \|\| \[\]\)\.slice\(\)\.sort\(\(a, b\) => a - b\)\.map/)
  // logic mirror: click order [3,0] must display as Mon(0) before Thu(3)
  const sorted = [3, 0].slice().sort((a, b) => a - b)
  assert.deepEqual(sorted, [0, 3])
})

/* W7-9: memorial future-date guard */
test('W7-9: memorial date input caps at today and submit validates', () => {
  assert.match(HABIT, /:max="newMomentKind === 'memorial' \? todayKey : null"/)
  assert.match(HABIT, /addMoment[\s\S]{0,600}newMomentKind === 'memorial' && this\.newMomentDate > this\.todayKey[\s\S]{0,120}statsE\.w7\.memorialFutureDate/)
})

/* W7-10: ledger overlap guard */
test('W7-10: commitDraft and saveCreate both run the same-day overlap guard', () => {
  assert.match(ACCOUNT, /overlapsExisting \(d, day0, selfId\) \{[\s\S]{0,400}start < r\.startMin \+ r\.dur && r\.startMin < end/)
  assert.match(ACCOUNT, /commitDraft[\s\S]{0,700}overlapsExisting\(d, d\.day0, d\.tomatoId\)[\s\S]{0,200}statsE\.w7\.accountTimeOverlap/)
  assert.match(ACCOUNT, /saveCreate \(\) \{[\s\S]{0,2000}overlapsExisting\(d, today0, null\)[\s\S]{0,200}statsE\.w7\.accountTimeOverlap/)
})

test('W7-10b: interval intersection predicate (logic mirror of overlapsExisting)', () => {
  const overlaps = (aStart, aDur, bStart, bDur) => aStart < bStart + bDur && bStart < aStart + aDur
  assert.ok(overlaps(600, 25, 610, 25)) // nested
  assert.ok(overlaps(600, 25, 620, 10)) // tail overlap
  assert.ok(!overlaps(600, 25, 625, 25)) // touching ends (25 -> 650 vs 625) overlap actually: 600+25=625, 625<625 false -> no overlap
  assert.ok(!overlaps(600, 25, 700, 25))
})

/* W7-11: dirty-guarded close */
test('W7-11: all close paths go through requestClose which confirms dirty drafts', () => {
  assert.match(ACCOUNT, /@keydown\.esc="requestClose"/)
  assert.match(ACCOUNT, /modal-container[\s\S]{0,200}requestClose\(\) \}/)
  assert.match(ACCOUNT, /close-x--sm ta-x[\s\S]{0,100}@click="requestClose"/)
  assert.match(ACCOUNT, /requestClose \(\) \{[\s\S]{0,400}draftDirty\(\)[\s\S]{0,400}statsE\.w7\.accountDiscardConfirm/)
  assert.match(ACCOUNT, /draftDirty \(\) \{[\s\S]{0,400}if \(d\.create\) return true/)
})

/* W7-12: edit-panel pre-width tracks resizes */
test('W7-12: layout attaches a debounced resize tracker while the panel is open and cleans it up', () => {
  assert.match(LAYOUT, /if \(v\) \{[\s\S]{0,200}_attachPreWidthResize\(\)[\s\S]{0,200}ensureWindowWidth\(1225\)/)
  assert.match(LAYOUT, /\} else \{[\s\S]{0,120}_detachPreWidthResize\(\)/)
  assert.match(LAYOUT, /_attachPreWidthResize \(\) \{[\s\S]{0,400}addEventListener\('resize', this\._onPreWidthResize\)/)
  assert.match(LAYOUT, /_detachPreWidthResize \(\) \{[\s\S]{0,300}removeEventListener\('resize', this\._onPreWidthResize\)/)
  assert.match(LAYOUT, /beforeUnmount \(\) \{[\s\S]{0,200}_detachPreWidthResize\(\)/)
  assert.match(LAYOUT, /_preWidthTimer = setTimeout\(/, 'refresh is debounced')
})

/* W7-13: Delete/Backspace clears a binding during capture */
test('W7-13: capture clears the binding on Delete/Backspace; hint copy ships in both locales', () => {
  assert.match(SHORTCUTS, /if \(k === 'delete' \|\| k === 'backspace'\) \{[\s\S]{0,200}this\.shortcutForm\[key\] = ''/)
  assert.match(SHORTCUTS, /statsE\.w7\.scClearHint/)
  // the empty value stays a first-class state end to end
  assert.match(SHORTCUTS, /formatShortcut \(v\) \{ return formatShortcutText\(v\) \|\| this\.\$t\('statsE\.SettingsModal\.scEmpty'\) \}/, 'empty renders the scEmpty placeholder')
  assert.match(SHORTCUTS, /if \(!val\) return false/, 'hasConflict ignores empty bindings')
  for (const loc of [ZH_E, EN_E]) assert.match(loc, /scClearHint/)
})

/* i18n pairing gate: every w7 key exists with identical structure in zh-CN and en-US */
test('W7-i18n: all new w7 keys are paired across zh-CN-E and en-US-E', () => {
  const zh = JSON.parse(ZH_E.slice(ZH_E.indexOf('{'), ZH_E.lastIndexOf('}') + 1).replace(/\/\*[\s\S]*?\*\//g, ''))
  const en = JSON.parse(EN_E.slice(EN_E.indexOf('{'), EN_E.lastIndexOf('}') + 1).replace(/\/\*[\s\S]*?\*\//g, ''))
  for (const k of W7_KEYS) {
    assert.ok(zh.statsE.w7[k] && en.statsE.w7[k], 'missing key: ' + k)
    assert.equal(typeof zh.statsE.w7[k], 'string')
    assert.equal(typeof en.statsE.w7[k], 'string')
  }
})
