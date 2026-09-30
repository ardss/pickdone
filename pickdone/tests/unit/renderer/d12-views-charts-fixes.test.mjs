/**
 * D12 renderer views/charts fix round — regression batch (one test per finding, all red on the
 * pre-fix code). Source anchors follow the SFC test paradigm of this area (w5-stats-split /
 * d11-renderer-domain-fixes): template contracts and method wiring that a mount-free unit run can
 * still pin, plus behavioral assertions on the shared pure module (crossDayMovePatch) the tbDrop
 * fix now rides.
 *  - R1  chartcard-upgrade-click       (ChartCard.vue chart-h button was a dead no-op)
 *  - R3  projectview-deadline-toast    (ProjectView.vue fire-and-forget meta write + unconditional success toast)
 *  - R4  calendar-tbdrop-reminder      (CalendarView.vue tbDrop orphaned reminderTime/reminderExtra on the old day)
 *  - R6  todobox-done-disabled         (TodoBoxView.vue Done button bypassed the batchBusy lock)
 *  - R9  filterview-row-a11y           (FilterView.vue rows had no role/tabindex/keyboard activation)
 *  - R11 todobox-listbox-aria          (TodoBoxView.vue listboxes were labelled with the tip copy; + en/zh keys)
 *  - R14 chartcard-load-fail-fallback  (ChartCard.vue swallowed loadScript rejection — blank canvas forever)
 * Run: node --test tests/unit/renderer/d12-views-charts-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const chartCard = read('renderer/js/views/statistics/ChartCard.vue')
const projectView = read('renderer/js/views/ProjectView.vue')
const calendarView = read('renderer/js/views/CalendarView.vue')
const todoBoxView = read('renderer/js/views/TodoBoxView.vue')
const filterView = read('renderer/js/views/FilterView.vue')
const enC = read('renderer/js/i18n/locales/en-US-C.js')
const zhC = read('renderer/js/i18n/locales/zh-CN-C.js')

/* ---------- R1 chartcard-upgrade-click ---------- */
test('R1: chart-h upgrade button is wired to an onUpgrade handler that hands off via openExternal', () => {
  // pre-fix: <button class="base-button"> with no @click — clicking did nothing
  assert.match(chartCard, /<button type="button" class="base-button" @click="onUpgrade">/)
  assert.match(chartCard, /onUpgrade \(\)/, 'onUpgrade method must exist')
  assert.match(chartCard, /window\.todoAPI\.openExternal\('https:\/\/pickdone\.app'\)/,
    'upgrade handoff uses the same official-site URL as SettingsModal.openOfficialSite')
  // guarded: hosts without the bridge must not throw
  assert.match(chartCard, /typeof window\.todoAPI\.openExternal === 'function'/)
})

/* ---------- R3 projectview-deadline-toast ---------- */
test('R3: setDeadline/clearDeadline await the meta commit; a failed write must not toast success', () => {
  // pre-fix: commitCommand(...).catch(() => {}) fire-and-forget, success toast always fired
  assert.ok(!projectView.includes(".catch(() => {}) } catch { /* degraded"),
    'fire-and-forget meta write with unconditional success toast must be gone')
  const setFn = projectView.slice(projectView.indexOf('async setDeadline'), projectView.indexOf('async removeFromProject'))
  assert.match(setFn, /await commitCommand\('meta', 'put', \['projectDeadline:' \+ this\.catId, String\(date\)\]\)/,
    'setDeadline awaits the persistence round-trip')
  assert.match(setFn, /this\.deadlineTs = 0[\s\S]*?\$message\.error\(/,
    'on write failure the optimistic value is dropped and an error is surfaced')
  const clearFn = projectView.slice(projectView.indexOf('async clearDeadline'), projectView.indexOf('async removeFromProject'))
  assert.match(clearFn, /await commitCommand\('meta', 'put', \['projectDeadline:' \+ this\.catId, '0'\]\)/,
    'clear keeps CLI parity (put \'0\', same as cli setProjectDeadline(none)) and awaits it')
  assert.match(clearFn, /\$message\.error\(/, 'clearDeadline surfaces write failures too')
})

/* ---------- R4 calendar-tbdrop-reminder ---------- */
test('R4: time-block drop re-anchors reminders via the shared crossDayMovePatch invariant', async () => {
  assert.match(calendarView, /import \{ crossDayMovePatch, crossDayRevertPatch \} from '\.\.\/utils\/crossDayMove\.js'/)
  const tbDrop = calendarView.slice(calendarView.indexOf('async tbDrop'), calendarView.indexOf('tbCreate (dayTs'))
  assert.match(tbDrop, /crossDayMovePatch\(t, dayTs, startOf\)/, 'patch comes from the shared builder')
  assert.match(tbDrop, /patch\.todoTime = ts/, 'the drop cell hour still wins for todoTime')
  assert.match(tbDrop, /crossDayRevertPatch\(t, patch\)/, 'undo restores exactly the touched fields')
  assert.ok(!tbDrop.includes("patch: { dayStart: dayTs, todoTime: ts }"),
    'the hand-rolled two-field patch (which orphaned reminders) must be gone')
  // behavioral: the invariant the fix relies on (reminder anchored to the old day moves with it)
  const { crossDayMovePatch, crossDayRevertPatch } = await import('../../../renderer/js/utils/crossDayMove.js')
  const startOf = x => x - (x % 86400000)
  const yesterday = startOf(Date.UTC(2026, 8, 14))
  const today = yesterday + 86400000
  const dragged = {
    dayStart: yesterday,
    todoTime: yesterday + 14 * 3600000,
    reminderTime: yesterday + 9 * 3600000,
    reminderExtra: [yesterday + 8 * 3600000]
  }
  const patch = crossDayMovePatch(dragged, today, startOf)
  patch.todoTime = today + 10 * 3600000 // the tbDrop override: drop cell 10:00
  assert.equal(patch.reminderTime, today + 9 * 3600000, '9:00 reminder follows to the new day')
  assert.deepEqual(patch.reminderExtra, [today + 8 * 3600000], 'extra reminders follow too')
  const revert = crossDayRevertPatch(dragged, patch)
  assert.deepEqual(revert, { dayStart: yesterday, todoTime: yesterday + 14 * 3600000, reminderTime: yesterday + 9 * 3600000, reminderExtra: [yesterday + 8 * 3600000] })
})

/* ---------- R6 todobox-done-disabled ---------- */
test('R6: the batch Done (exit) button is disabled while a batch op is in flight', () => {
  // pre-fix: only Today/Move/Delete carried :disabled="batchBusy" — Done could exit mid-loop
  const bar = todoBoxView.slice(todoBoxView.indexOf('tb-batch-bar'), todoBoxView.indexOf('</transition>'))
  const doneBtn = bar.slice(Math.max(0, bar.indexOf('btnDone') - 200))
  assert.match(doneBtn, /:disabled="batchBusy"/, 'Done button must carry the batchBusy lock')
  for (const btn of ['btnToday', 'btnMoveToCat', 'btnDelete']) {
    assert.match(bar.slice(bar.indexOf(btn)), /:disabled="batchBusy"/, btn + ' keeps its lock')
  }
})

/* ---------- R9 filterview-row-a11y ---------- */
test('R9: FilterView rows are keyboard-operable with the same row contract as TodoBoxView', () => {
  // pre-fix: rows were mouse-only (click + contextmenu), invisible to keyboard/AT
  assert.match(filterView, /class="todo-box-list-item"[\s\S]*?role="button" tabindex="0" :aria-label="t\.taskContent"/)
  assert.match(filterView, /@keydown\.enter\.prevent="openEdit\(t\)"/)
})

/* ---------- R11 todobox-listbox-aria ---------- */
test('R11: the three dd-menu listboxes carry dedicated aria labels (present in en-US-C and zh-CN-C)', () => {
  // pre-fix: all three used the TodoBox tip sentence as the listbox label
  assert.ok(!todoBoxView.includes('role="listbox" :aria-label="$t(\'statsC.TodoBox.tip\')"'),
    'listboxes must not reuse the tip copy as their accessible name')
  assert.match(todoBoxView, /role="listbox" :aria-label="\$t\('statsC\.TodoBox\.ariaSortList'\)"/)
  assert.match(todoBoxView, /role="listbox" :aria-label="\$t\('statsC\.TodoBox\.ariaOrderList'\)"/)
  assert.match(todoBoxView, /role="listbox" :aria-label="\$t\('statsC\.TodoBox\.ariaCatList'\)"/)
  for (const key of ['ariaSortList', 'ariaOrderList', 'ariaCatList']) {
    assert.match(enC, new RegExp(key + ': '), `en-US-C must define statsC.TodoBox.${key}`)
    assert.match(zhC, new RegExp(key + ': '), `zh-CN-C must define statsC.TodoBox.${key}`)
  }
})

/* ---------- R14 chartcard-load-fail-fallback ---------- */
test('R14: a failed Chart.js injection falls back to the chart-empty state, not a blank canvas', () => {
  // pre-fix: .catch(() => {}) swallowed the rejection — the empty canvas stayed forever
  assert.ok(!chartCard.includes('.then(() => this.renderChart()).catch(() => {})'),
    'the silent catch must be gone')
  assert.match(chartCard, /chartFailed: false/, 'chartFailed state declared')
  const renderChart = chartCard.slice(chartCard.indexOf('renderChart ()'))
  assert.match(renderChart, /catch\(\(\) => \{\s*\n\s*\/\/ Vendor injection failed[\s\S]*?this\.chartFailed = true/)
  assert.match(chartCard, /listAllZero \|\| chartFailed/, 'template falls back to the chart-empty branch')
})
