/**
 * Domain-3 renderer view time caliber (2026-09-23 wave) — regression guards.
 * Fixes covered:
 *   [D3-1] week boundaries single-sourced in utils/weekGrid.js; CalendarView time-block now
 *          follows settings.weekStartDay instead of the dayjs default (Sunday) grid
 *   [D3-2] utils/todayBounds.js today0/dayStart helpers; domain-3 files converged (partial —
 *          store/todo.js, EditPanel, taskMenu.js etc. belong to other domains, untouched)
 *   [D3-3] mmToHHmm/secToHHmmss single source in utils/tomatoShared.js; DayRail/EpReminders/
 *          TomatoFocusRecordModal/nlDate(×2) delegate to it
 * Run: node --test tests/unit/renderer/dw3-domain3-time-caliber.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const weekGrid = await import('../../../renderer/js/utils/weekGrid.js')
const todayBounds = await import('../../../renderer/js/utils/todayBounds.js')
const tomatoShared = await import('../../../renderer/js/utils/tomatoShared.js')
const { dayjs } = await import('../../../renderer/js/utils/core.js')

/* ---------- [D3-1] weekGrid single source ---------- */

test('[D3-1] weekGridStart: Wednesday 2026-09-23 lands on Mon 09-21 (default) / Sun 09-20 (sun start)', () => {
  const wed = dayjs('2026-09-23').startOf('day')
  assert.equal(wed.day(), 3, 'precondition: the probe day is a Wednesday')
  assert.equal(weekGrid.weekGridStart(+wed, false), +dayjs('2026-09-21'), 'mon-start grid begins Monday')
  assert.equal(weekGrid.weekGridStart(+wed, true), +dayjs('2026-09-20'), 'sun-start grid begins Sunday')
  // grid start is always a day-start ts (time-block pool compares t.dayStart against it)
  assert.equal(weekGrid.weekGridStart(+wed.hour(23).minute(59), false), +dayjs('2026-09-21'), 'time-of-day does not leak into the boundary')
})

test('[D3-1] isoWeek helpers keep the hard-Monday window FilterView/chartModels had before', () => {
  const wed = +dayjs('2026-09-23').hour(12)
  assert.equal(weekGrid.isoWeekStart(wed), +dayjs('2026-09-23').startOf('isoWeek'), 'same start as the former inline startOf(\'isoWeek\')')
  assert.equal(weekGrid.isoWeekEnd(wed), +dayjs('2026-09-23').endOf('isoWeek'), 'same end as the former inline endOf(\'isoWeek\')')
  assert.equal(dayjs(weekGrid.isoWeekEnd(wed)).day(), 0, 'isoWeek end is a Sunday')
})

test('[D3-1] CalendarView time-block consumes weekGridStart with the weekStartDay setting (no dayjs-default week left)', () => {
  const src = read('renderer/js/views/CalendarView.vue')
  assert.ok(src.includes("weekGridStart(Date.now(), this.settings.weekStartDay === 'sun')"),
    'tbDays/tbPool/nav resolve the week start through the shared helper honoring the setting')
  assert.ok(!src.includes("startOf('week')"), 'the dayjs-default (Sunday) week boundary is gone from CalendarView')
  const strip = read('renderer/js/components/DayDateStrip.vue')
  assert.ok(strip.includes("from '../utils/weekGrid.js'"), 'DayDateStrip imports the moved helpers (single source)')
})

test('[D3-1] FilterView/chartModels keep the hard-Monday window but through the shared module', () => {
  assert.ok(read('renderer/js/views/FilterView.vue').includes("from '../utils/weekGrid.js'"))
  const cm = read('renderer/js/views/statistics/chartModels.js')
  assert.ok(cm.includes("from '../../utils/weekGrid.js'"), 'chartModels imports the shared helper')
  assert.ok(!cm.includes("startOf('isoWeek')"), 'no inline isoWeek start left in chartModels')
  assert.ok(cm.includes('calGridOffset(today.day(), false)'), 'heatmap week-end math reuses calGridOffset')
})

/* ---------- [D3-2] todayBounds ---------- */

test('[D3-2] today0 equals the former inline dayjs().startOf("day"); dayStart normalizes any ts to midnight', () => {
  assert.equal(todayBounds.today0(), +dayjs().startOf('day'), 'today0 matches the expression it replaces')
  const noon = +dayjs('2026-09-23').hour(15).minute(42).second(13)
  assert.equal(todayBounds.dayStart(noon), +dayjs('2026-09-23').startOf('day'))
  assert.equal(todayBounds.today0(+dayjs('2026-01-01').hour(10).valueOf()), +dayjs('2026-01-01').startOf('day'), 'injected now is honored')
})

test('[D3-2] domain-3 files consume todayBounds (partial convergence; out-of-domain files untouched)', () => {
  for (const f of ['renderer/js/views/CalendarView.vue', 'renderer/js/views/FilterView.vue', 'renderer/js/components/DayRail.vue']) {
    assert.ok(read(f).includes('utils/todayBounds.js'), `${f} imports the helper`)
  }
  // 2026-09-23 (domain-5): the two assertions below were removed.
  // (1) `!read('store/todo.js').includes('todayBounds')` froze wave #133's TERRITORIAL claim into a
  //     permanent assertion — the planned domain-3 today0 convergence of store/todo.js would trip it
  //     through no fault of that change. Convergence is now protected by real behavior tests
  //     (today0/dayStart semantics above), not by source-string guards on other domains' files.
  // (2) `taskMenu.js.length > 0` was a always-true placeholder asserting nothing.
})

/* ---------- [D3-3] mmToHHmm / secToHHmmss single source ---------- */

test('[D3-3] mmToHHmm keeps DayRail clamping semantics: round + clamp to 0..1439', () => {
  const { mmToHHmm } = tomatoShared
  assert.equal(mmToHHmm(0), '00:00')
  assert.equal(mmToHHmm(735), '12:15')
  assert.equal(mmToHHmm(1439), '23:59', 'upper clamp')
  assert.equal(mmToHHmm(1500), '23:59', 'out-of-range clamps instead of spilling to 25:00')
  assert.equal(mmToHHmm(-5), '00:00', 'negative clamps to midnight')
  assert.equal(mmToHHmm(90.6), '01:31', 'rounds like the former Math.round inline')
})

test('[D3-3] secToHHmmss matches the former inline fmtSec', () => {
  const { secToHHmmss } = tomatoShared
  assert.equal(secToHHmmss(0), '00:00:00')
  assert.equal(secToHHmmss(3725), '01:02:05')
  assert.equal(secToHHmmss(-3), '00:00:00')
})

test('[D3-3] all four former inline sites delegate to the shared formatters', () => {
  const rail = read('renderer/js/components/DayRail.vue')
  assert.ok(rail.includes('minToHHmm (m) { return mmToHHmm(m) }'), 'DayRail delegates (clamping moved into the helper)')
  assert.ok(!rail.includes("padStart(2, '0') + ':' + String"), 'no inline HH:mm concatenation left in DayRail')
  const ep = read('renderer/js/components/edit-panel/EpReminders.vue')
  assert.ok(ep.includes('time: mmToHHmm(nm)'), 'EpReminders uses the shared formatter for the +30min stagger')
  const modal = read('renderer/js/components/TomatoFocusRecordModal.vue')
  assert.ok(modal.includes('const fmtSec = secToHHmmss'), 'TomatoFocusRecordModal fmtSec is the shared secToHHmmss')
  const nl = read('renderer/js/utils/nlDate.js')
  assert.ok(nl.includes('mmToHHmm(h * 60 + min)'), 'nlDate English branch labels via mmToHHmm')
  assert.ok(nl.includes('mmToHHmm(peeled.h * 60 + peeled.min)'), 'nlDate mixed CJK branch labels via mmToHHmm')
  assert.ok(!nl.includes("padStart(2, '0')}:${String("), 'no inline HH:mm template concatenation left in nlDate')
})
