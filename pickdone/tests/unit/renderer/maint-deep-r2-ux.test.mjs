/**
 * [maint/deep-r2] renderer UX round 2 regression tests (A1/A3/A4/A5/A11/A12/A15/B13/B9).
 * Pure logic is extracted to utils (popPos.js, dayWindow.js, limits.js, expiryGroups.js) and
 * unit-tested below; the wiring is locked with source anchors, same convention as maint-0924-ux.
 * Run: node --test tests/unit/renderer/maint-deep-r2-ux.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { clampPopPosition } from '../../../renderer/js/utils/popPos.js'
import { clampToDayWindow } from '../../../renderer/js/utils/dayWindow.js'
import { hiddenCount } from '../../../renderer/js/utils/limits.js'
import { tagStaleDone } from '../../../renderer/js/utils/expiryGroups.js'
import { dayShift } from '../../../renderer/js/utils/todayBounds.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

/* ---------- A1: ViewMoreMenu pop clamps top too ---------- */

test('A1 clampPopPosition keeps the left formula and clamps top near the bottom edge', () => {
  // mid-window pointer: unchanged legacy behavior
  assert.deepEqual(clampPopPosition(600, 300, 200, 1280, 800), { left: 410, top: 308 })
  // pointer near the bottom: popHeight (200) + margin (8) pulls the top back inside the viewport
  assert.equal(clampPopPosition(600, 780, 200, 1280, 800).top, 800 - 200 - 8)
  // pointer near the left edge: left stays floored at 0
  assert.equal(clampPopPosition(5, 300, 200, 1280, 800).left, 0)
  // tiny pop, top pointer: top stays positive, not floored
  assert.equal(clampPopPosition(600, 10, 40, 1280, 800).top, 18)
})

test('A1 ViewMoreMenu measures offsetHeight in the same $nextTick and clamps via the shared util', () => {
  const src = read('renderer/js/components/ViewMoreMenu.vue')
  assert.match(src, /import \{ clampPopPosition \} from '\.\.\/utils\/popPos\.js'/)
  assert.match(src, /clampPopPosition\(e\.clientX, e\.clientY, el\.offsetHeight, window\.innerWidth, window\.innerHeight\)/)
  assert.ok(!/el\.style\.top = \(e\.clientY \+ 8\)/.test(src), 'the unclamped clientY+8 write must stay deleted')
})

/* ---------- A3: DayDeck clamps out-of-window daySelectedTs ---------- */

test('A3 clampToDayWindow clamps to the nearest window edge', () => {
  const days = [100, 200, 300]
  assert.equal(clampToDayWindow(days, 200), 200, 'exact member passes through')
  assert.equal(clampToDayWindow(days, 155), 200, 'in-span non-member snaps to the nearest member')
  assert.equal(clampToDayWindow(days, 145), 100, 'in-span non-member snaps to the nearest member')
  assert.equal(clampToDayWindow(days, 50), 100, 'before the window clamps to the first day')
  assert.equal(clampToDayWindow(days, 999), 300, 'after the window clamps to the last day')
  assert.equal(clampToDayWindow([], 50), 50, 'empty window is a no-op')
})

test('A3 DayDeck watcher and mounted alignment both route through clampToDayWindow', () => {
  const src = read('renderer/js/components/DayDeck.vue')
  assert.match(src, /import \{ clampToDayWindow \} from '\.\.\/utils\/dayWindow\.js'/)
  const watcher = src.slice(src.indexOf("'$store.state.ui.daySelectedTs' (ts)"), src.indexOf('mounted ()'))
  assert.match(watcher, /clampToDayWindow\(this\.days, \+ts\)/, 'store watcher clamps before findIndex')
  const mounted = src.slice(src.indexOf('mounted ()'), src.indexOf('beforeUnmount'))
  assert.match(mounted, /clampToDayWindow\(this\.days, \+sel\)/, 'mounted alignment clamps too')
})

/* ---------- A4: TagView/CategoryView recomplete guard + empty-state toast ---------- */

test('A4 TagView and CategoryView recomplete catch failures and toast the empty case', () => {
  for (const [file, shard] of [
    ['renderer/js/views/TagView.vue', 'statsC.Tag'],
    ['renderer/js/views/CategoryView.vue', 'statsE.CategoryView']
  ]) {
    const src = read(file)
    const fn = src.slice(src.indexOf('async recomplete ()'))
    assert.match(fn, /try \{[\s\S]*await rescheduleExpired\(/, file + ': dispatch is awaited inside try')
    assert.match(fn, /} catch \(e\) \{[\s\S]*\$message\.error/, file + ': failure toasts like FilterView')
    assert.match(fn, /\$message\.info\(this\.\$t\('/)
    assert.ok(fn.includes(shard + '.nothingToReschedule'), file + ': n===0 surfaces an info toast')
  }
})

test('A4 the new reschedule toast keys exist in both locales', () => {
  for (const loc of ['zh-CN-C.js', 'en-US-C.js', 'zh-CN-E.js', 'en-US-E.js']) {
    const s = read('renderer/js/i18n/locales/' + loc)
    assert.match(s, /"?rescheduleFailed"?: /, loc)
    assert.match(s, /"?nothingToReschedule"?: /, loc)
  }
})

/* ---------- A5: TodoItem toggleSub reverts on failed write ---------- */

test('A5 toggleSub awaits the dispatch, reverts s.checked and toasts on failure', () => {
  const src = read('renderer/js/components/TodoItem.vue')
  const fn = src.slice(src.indexOf('async toggleSub (s)'))
  assert.match(fn, /await this\.\$store\.dispatch\('todo\/updateTodoFields'/)
  assert.match(fn, /} catch \(e\) \{[\s\S]*s\.checked = !s\.checked/, 'failed write reverts the optimistic flip')
  assert.match(fn, /catch[\s\S]*\$message\.error\(this\.\$t\('statsE\.TodoItem\.subSaveFailed'\)/)
  assert.ok(fn.indexOf('s.checked = !s.checked') < fn.indexOf('await'), 'optimistic flip still happens first')
  for (const loc of ['zh-CN-E.js', 'en-US-E.js']) assert.match(read('renderer/js/i18n/locales/' + loc), /subSaveFailed/)
})

/* ---------- A11: TodayXView +N done chip ---------- */

test('A11 hiddenCount floors at zero and TodayXView renders an overflow chip', () => {
  assert.equal(hiddenCount(9, 5), 4)
  assert.equal(hiddenCount(5, 5), 0)
  assert.equal(hiddenCount(2, 5), 0)
  assert.equal(hiddenCount(undefined, 5), 0)
  const src = read('renderer/js/views/TodayXView.vue')
  assert.match(src, /doneHidden \(\) \{ return hiddenCount\(\(this\.v\.todayDoneList \|\| \[\]\)\.length, 5\) \}/)
  assert.match(src, /v-if="doneHidden"[\s\S]*\+\{\{ doneHidden \}\}/, '+N chip rendered after the capped chips')
  assert.match(src, /import \{ hiddenCount \} from '\.\.\/utils\/limits\.js'/)
})

/* ---------- A12: RecycleBinView alert date uses the danger token ---------- */

test('A12 .datetime--alert uses var(--danger-strong) with a dark override like the sibling', () => {
  const src = read('renderer/js/views/RecycleBinView.vue')
  assert.match(src, /\.datetime--alert\{color:var\(--danger-strong, #bd401e\)\}/)
  assert.ok(!/\{color:#bd401e\}/.test(src), 'hardcoded hex must stay deleted')
  assert.match(src, /html\[data-theme="dark"\] \.datetime--alert\{color:var\(--danger/)
})

/* ---------- A15: TomatoPanel true count + "+N more" row ---------- */

test('A15 TomatoPanel header shows the TRUE record count and appends a "+N more" row', () => {
  const src = read('renderer/js/components/TomatoPanel.vue')
  assert.match(src, /countN', \{ n: todayRecords\.length \}/, 'header count is the true total')
  assert.match(src, /v-if="hiddenRecords"[\s\S]*moreRecords/, '"+N more" row after the 6 shown rows')
  assert.match(src, /hiddenRecords \(\) \{ return hiddenCount\(this\.todayRecords\.length, 6\) \}/)
  assert.match(src, /import \{ hiddenCount \} from '\.\.\/utils\/limits\.js'/)
  for (const loc of ['zh-CN-D.js', 'en-US-D.js']) assert.match(read('renderer/js/i18n/locales/' + loc), /moreRecords/)
})

/* ---------- B13/B4: EditPanel applyDate clears offsets with the reminder ---------- */

test('B13 applyDate(0) clears reminderOffsets/reminderExtra and persists the cleared arrays', () => {
  const src = read('renderer/js/components/EditPanel.vue')
  const fn = src.slice(src.indexOf('applyDate (ts) {'), src.indexOf('onPickDate (ts)'))
  assert.match(fn, /offsetsCleared = true/, 'zeroing the reminder flags the clear')
  assert.match(fn, /this\.e\.reminderOffsets = \[\]/, 'component state honors the offsets-die invariant')
  assert.match(fn, /next = \[\]/, 'extra reminders die with the main reminder (sibling contract)')
  assert.match(fn, /reminderOffsets: offsetsCleared \? \[\] : this\.e\.reminderOffsets/, 'queueSave patch carries the cleared offsets (ternary keeps non-clear cases intact)')
})

/* ---------- B9: TagView gets the projDone completed fallback ---------- */

test('B9 tagStaleDone matches only completions outside every other tag bucket', () => {
  const today = Date.now()
  const day = 86400000
  const row = (dayStart, complete = true) => ({ dayStart, complete })
  assert.equal(tagStaleDone(row(today), today, 7), false, 'today completion belongs to tagTodayDone')
  assert.equal(tagStaleDone(row(today - day), today, 7), false, 'within the R1 window belongs to tagExpDone')
  assert.equal(tagStaleDone(row(today - 7 * day), today, 7), false, 'R1 window edge (inclusive) belongs to tagExpDone')
  assert.equal(tagStaleDone(row(dayShift(today, 1)), today, 7), false, 'tomorrow belongs to tagTomorrow')
  assert.equal(tagStaleDone(row(dayShift(today, 2)), today, 7), false, 'day+2 belongs to tagDat')
  assert.equal(tagStaleDone(row(dayShift(today, 3)), today, 7), true, 'day+3 completion previously vanished — now caught')
  assert.equal(tagStaleDone(row(today - 8 * day), today, 7), true, 'older than the R1 window previously vanished — now caught')
  assert.equal(tagStaleDone({ dayStart: dayShift(today, 3), complete: false }, today, 7), false, 'uncompleted rows stay in their own buckets')
  assert.equal(tagStaleDone({ dayStart: 0, complete: true }, today, 7), false, 'no-date completions are out of scope here')
})

test('B9 TagView pushes the projDone fallback group like CategoryView/ProjectView', () => {
  const src = read('renderer/js/views/TagView.vue')
  assert.match(src, /import \{ tagStaleDone \} from '\.\.\/utils\/expiryGroups\.js'/)
  assert.match(src, /const staleDone = bucket\(t => tagStaleDone\(t, today, R1\)\)/)
  assert.match(src, /key: 'projDone', title: this\.\$t\('statsB\.ProjectView\.done'\)/)
  assert.match(src, /tagStaleDone\(t, today, R1\)/, 'same R1 completed range as the expDone window')
})
