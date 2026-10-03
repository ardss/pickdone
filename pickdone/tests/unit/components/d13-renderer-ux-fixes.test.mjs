/**
 * D13 renderer UX fixes — regression tests (node:test, source-anchor + extracted-function style,
 * same seam approach as d12-renderer-fixes.test.mjs: no Vue mount).
 *
 * Covered: A7 RepeatModal yearly-picker anchor (stale 2026 / Feb-29 -> Mar 1 clamp),
 *          A8 RepeatModal cancel-while-generating (disabled buttons + genCancelled loop break),
 *          A9 CalendarView tbCreate addTodo .catch,
 *          A10 StatsShareCard saveShareCard re-entrancy guard,
 *          A11 HabitView saveRename empty-name refocus,
 *          A14 TomatoPanel record count matches the rendered window.
 *
 * Run: node --test tests/unit/components/d13-renderer-ux-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')
const require_ = createRequire(import.meta.url)
const dayjs = require_('dayjs')

const REPEAT = read('renderer/js/components/RepeatModal.vue')
const CALENDAR = read('renderer/js/views/CalendarView.vue')
const SHARE = read('renderer/js/views/statistics/StatsShareCard.vue')
const HABIT = read('renderer/js/views/HabitView.vue')
const TOMATO = read('renderer/js/components/TomatoPanel.vue')

/* ---------------- A7: yearly repeat picker anchor ---------------- */

test('A7: the yearly date picker no longer anchors on a hardcoded 2026', () => {
  assert.doesNotMatch(REPEAT, /new Date\(2026,/, 'hardcoded anchor year goes stale from 2027')
  // the picker binds the dedicated anchor computed instead
  assert.match(REPEAT, /:model-value="yearAnchorTs"/)
  assert.match(REPEAT, /yearAnchorTs \(\) \{/)
})

test('A7: yearAnchorTs anchors on the base task year (fallback: current year) and clamps Feb-29 out of a non-leap anchor back into February', () => {
  // extract the computed source and evaluate it against real dayjs — fails without the fix
  // because the old template inlined `new Date(2026, ...)` and there was no computed at all
  const start = REPEAT.indexOf('yearAnchorTs () {')
  assert.ok(start >= 0, 'yearAnchorTs computed missing')
  let depth = 0
  let end = start
  for (let i = REPEAT.indexOf('{', start); i < REPEAT.length; i++) {
    if (REPEAT[i] === '{') depth++
    else if (REPEAT[i] === '}') { depth--; if (depth === 0) { end = i + 1; break } }
  }
  const src = REPEAT.slice(start, end)
  const fn = new Function('dayjs', `return (${src.replace('yearAnchorTs () {', 'function () {')})`)(dayjs)

  // base task in 2024 (leap): Feb-29 stays Feb-29
  const self2024 = { form: { repeatYearMonth: 2, repeatYearMonthDay: 29 }, templateTodo: { todoTime: new Date(2024, 5, 15).getTime() } }
  const d24 = dayjs(fn.call(self2024))
  assert.equal(d24.year(), 2024)
  assert.equal(d24.month(), 1, 'anchor month must be the stored month (Feb)')
  assert.equal(d24.date(), 29)

  // base task in 2025 (non-leap): Feb-29 clamps to Feb-28, NOT Mar 1
  const self2025 = { form: { repeatYearMonth: 2, repeatYearMonthDay: 29 }, templateTodo: { todoTime: new Date(2025, 5, 15).getTime() } }
  const d25 = dayjs(fn.call(self2025))
  assert.equal(d25.year(), 2025)
  assert.equal(d25.month(), 1, 'Feb-29 rule must render as Feb, not clamp to Mar 1')
  assert.equal(d25.date(), 28)

  // no base task: falls back to the current year
  const selfNoBase = { form: { repeatYearMonth: 7, repeatYearMonthDay: 4 }, templateTodo: null }
  assert.equal(dayjs(fn.call(selfNoBase)).year(), dayjs().year())
})

/* ---------------- A8: cancel during generation ---------------- */

test('A8: cancel and close controls are disabled while generating', () => {
  const cancelBtn = REPEAT.match(/<el-button size="small"[^>]*@click="close"/)
  assert.ok(cancelBtn, 'cancel button binding found')
  assert.match(cancelBtn[0], /:disabled="generating"/, 'cancel must be disabled while generating')
  const closeX = REPEAT.match(/class="modal__close close-x"[^>]*>/)
  assert.ok(closeX, 'header close-x found')
  assert.match(closeX[0], /:disabled="generating"/)
})

test('A8: close() during generation sets a cancelled flag and the addTodo loop checks it per instance', () => {
  // without the fix close() unconditionally closed and the awaited loop kept creating the series
  const close = REPEAT.slice(REPEAT.indexOf('close () {'))
  assert.match(close, /if \(this\.generating\) \{ this\.genCancelled = true; return \}/, 'close during generation must cancel, not dismiss')
  const loop = REPEAT.slice(REPEAT.indexOf('for (let i = 0; i < dates.length; i++)'), REPEAT.indexOf("this.$store.commit('ui/askRepeatEdit', null)"))
  assert.match(loop, /if \(this\.genCancelled\) break/, 'the instance loop must stop on cancellation')
})

/* ---------------- A9: CalendarView tbCreate error handling ---------------- */

test('A9: tbCreate addTodo dispatch has a .catch reporting failure instead of an unhandled rejection', () => {
  const fn = CALENDAR.slice(CALENDAR.indexOf('tbCreate (dayTs, hour)'), CALENDAR.indexOf('nav (dir)'))
  assert.ok(fn.includes('todo/addTodo'), 'tbCreate dispatches addTodo')
  assert.match(fn, /\.catch\(e =>/, 'the time-block create must guard its dispatch (sibling createAt-style guards exist elsewhere)')
  assert.match(fn, /createFailed/, 'the catch surfaces an existing failure toast key')
})

/* ---------------- A10: StatsShareCard export re-entrancy ---------------- */

test('A10: saveShareCard has a busy guard released in finally and the save button is disabled while exporting', () => {
  const fn = SHARE.slice(SHARE.indexOf('async saveShareCard ()'))
  assert.match(fn, /if \(this\.exporting\) return/, 'second click during an export must be a no-op')
  assert.match(fn, /this\.exporting = true/)
  assert.match(fn, /finally \{ this\.exporting = false \}/, 'the flag must clear even on failure')
  const btn = SHARE.match(/share-save"[^>]*>/)
  assert.ok(btn, 'save button found')
  assert.match(btn[0], /:disabled="exporting"/)
})

/* ---------------- A11: HabitView empty-rename refocus ---------------- */

test('A11: empty-name rename warning re-focuses the inline editor after nextTick', () => {
  const fn = HABIT.slice(HABIT.indexOf('saveRename (h) {'), HABIT.indexOf('check (h) {'))
  assert.match(fn, /if \(!n\) \{/, 'empty-name branch')
  assert.match(fn, /\$nextTick/, 'refocus must wait for the blur to settle')
  assert.match(fn, /renameInput/, 'refocus targets the inline rename input')
  // the input carries the matching ref
  assert.match(HABIT, /ref="renameInput"[^>]*class="habit-rename"/)
})

/* ---------------- A14: TomatoPanel count vs rendered rows ---------------- */
/* [A15 supersedes the count rule] the rendered window stays the single 6-row slice, but the
   header count is now the TRUE total and the overflow gets an explicit "+N more" row — the
   old "count must not exceed the visible rows" rule was the interim fix that hid 9 records
   behind "今日记录 6". */

test('A14/A15: the rendered rows share one shownRecords window; the count is the true total with a +N row', () => {
  assert.match(TOMATO, /shownRecords \(\) \{\s*\n\s*return this\.todayRecords\.slice\(0, 6\)/, 'single shared window computed')
  // header count is the true total (A15) and the overflow row covers the hidden records
  assert.match(TOMATO, /countN', \{ n: todayRecords\.length \}/)
  assert.match(TOMATO, /hiddenRecords \(\) \{ return hiddenCount\(this\.todayRecords\.length, 6\) \}/)
  assert.match(TOMATO, /v-if="hiddenRecords"[\s\S]*moreRecords/, '"+N more" overflow row')
  // the v-for renders that same window (no independent slice)
  assert.match(TOMATO, /v-for="r in shownRecords"/)
  assert.doesNotMatch(TOMATO, /todayRecords\.slice\(0,6\)/)
})
