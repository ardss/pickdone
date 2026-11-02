/**
 * W28 maintenance wave (2026-11-01) — calendar / project-overview today-anchor fixes.
 *
 * Fix 2 (P3): CalendarView thisYear/thisMonth were zero-dependency wall-clock computeds
 * (dayjs().year()) — the month-panel "today" highlight froze across a month rollover while the
 * page stayed open. Now anchored to store.state.todo.todayTimestamp.
 *
 * Fix 3 (P3): CalendarView tbDays/tbPool fell back to weekGridStart(Date.now()) with NO reactive
 * dependency when tbWeekStart was 0 — the time-block grid froze on the week of first render
 * across a Sunday rollover. Now derived from a reactive tbWeekAnchor → todayTimestamp.
 *
 * Fix 5 (P3): ProjectOverviewView deadlineClass still used dueStateOf's wall-clock default while
 * deadlineText already used todayTimestamp — the overdue/soon class flipped on a different
 * schedule than the text. Now passes the same anchor.
 *
 * The computeds are extracted from the .vue source and evaluated against a fake `vm` with the
 * real utils (todayBounds/weekGrid/milestones) — behavioral, not string-matching.
 *
 * Run: node --test tests/unit/renderer/w28-calendar-today-anchor.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import '../../setup.mjs' // window.dayjs / pinyinPro shims for renderer-module imports (must precede core.js)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

globalThis.window = globalThis.window || { location: { hash: '' } }

const { dayjs } = await import(pathToFileURL(path.join(ROOT, 'renderer/js/utils/core.js')).href)
const { weekGridStart } = await import(pathToFileURL(path.join(ROOT, 'renderer/js/utils/weekGrid.js')).href)
const { today0, dayShift } = await import(pathToFileURL(path.join(ROOT, 'renderer/js/utils/todayBounds.js')).href)
const { dueStateOf } = await import(pathToFileURL(path.join(ROOT, 'renderer/js/utils/milestones.js')).href)

const read = p => readFileSync(path.join(ROOT, p), 'utf8').replace(/\r\n/g, '\n')

/** Extract a named computed/method member by brace counting (immune to one-liner vs multi-line formatting). */
function extractMember (src, name) {
  const start = src.search(new RegExp(`^    ${name} \\([^)]*\\) \\{`, 'm'))
  assert.ok(start >= 0, `member ${name} found`)
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(start, i + 1) }
  }
  assert.fail(`member ${name} never closes`)
}

/** Extract named computed members and eval them as an object factory. */
function extractComputeds (file, names) {
  const src = read(file)
  const bodies = names.map(n => extractMember(src, n))
  // deps are injected — the extracted bodies only ever reference these utils + `this`
  return new Function('dayjs', 'weekGridStart', 'today0', 'dayShift', 'wdLabel', 'dueStateOf',
    'return {\n' + bodies.join(',\n') + '\n}')(dayjs, weekGridStart, today0, dayShift, (t, d) => d, dueStateOf)
}

// 2020-07-15 is a Wednesday — far enough from any plausible wall clock to discriminate the fix
const T = +dayjs('2020-07-15').startOf('day')

function calVm (todoList = []) {
  return {
    tbWeekStart: 0,
    settings: { weekStartDay: 'mon' },
    $store: { state: { todo: { todayTimestamp: T, todoList } } },
    $t: k => k
  }
}

// wire the extracted computeds onto the vm as reactive-style getters so members that
// reference each other via `this` (tbWeekAnchor → today0Ts) resolve like the real component
function wire (vm, c, names) {
  for (const n of names) Object.defineProperty(vm, n, { get: () => c[n].call(vm) })
  return vm
}

// extract all six once; members reference each other via `this`, wired per-test below
const CAL = extractComputeds('renderer/js/views/CalendarView.vue',
  ['today0Ts', 'thisYear', 'thisMonth', 'tbWeekAnchor', 'tbDays', 'tbPool'])

test('[w28.2] CalendarView thisYear/thisMonth derive from todayTimestamp, not the wall clock', () => {
  const vm = wire(calVm(), CAL, ['today0Ts'])
  assert.equal(CAL.today0Ts.call(vm), T)
  assert.equal(CAL.thisYear.call(vm), 2020)
  assert.equal(CAL.thisMonth.call(vm), 7)
  // fallback: a store without todayTimestamp (0) still yields a number, not NaN
  const vmNoTs = wire(calVm(), CAL, ['today0Ts'])
  vmNoTs.$store.state.todo.todayTimestamp = 0
  assert.equal(CAL.thisYear.call(vmNoTs), dayjs(today0()).year())
})

test('[w28.3] tbDays week anchor derives from todayTimestamp — grid + isToday follow the store day', () => {
  const vm = wire(calVm(), CAL, ['today0Ts', 'tbWeekAnchor'])
  const days = CAL.tbDays.call(vm)
  assert.equal(days.length, 7)
  assert.equal(days[0].ts, weekGridStart(T, false), 'anchor is the week grid start of todayTimestamp')
  const todayIdx = days.findIndex(d => d.isToday)
  assert.ok(todayIdx >= 0, 'exactly one day flagged as today')
  assert.equal(days[todayIdx].ts, T)
  // explicit tbWeekStart still wins over the derived anchor (time-block mode navigation)
  const pinned = wire(calVm(), CAL, ['today0Ts', 'tbWeekAnchor'])
  pinned.tbWeekStart = +dayjs('2019-01-07').startOf('day')
  const pinnedDays = CAL.tbDays.call(pinned)
  assert.equal(pinnedDays[0].ts, pinned.tbWeekStart)
})

test('[w28.3] tbPool filters to [weekAnchor, +7d) of the todayTimestamp-derived week', () => {
  const inWeek = { taskId: 'in', complete: false, dayStart: +dayShift(T, 2) }
  const outWeek = { taskId: 'out', complete: false, dayStart: +dayShift(T, 9) }
  const done = { taskId: 'done', complete: true, dayStart: +dayShift(T, 3) }
  const vm = wire(calVm([inWeek, outWeek, done]), CAL, ['today0Ts', 'tbWeekAnchor'])
  const pool = CAL.tbPool.call(vm)
  assert.deepEqual(pool.map(t => t.taskId), ['in'])
})

test('[w28.5] ProjectOverviewView deadlineClass uses the todayTimestamp anchor (same caliber as deadlineText)', () => {
  const c = extractComputeds('renderer/js/views/ProjectOverviewView.vue', ['deadlineClass'])
  const vm = { $store: { state: { todo: { todayTimestamp: T } } } }
  const due2 = +dayjs(T).add(2, 'day')
  const overdue = +dayjs(T).subtract(1, 'day')
  const far = +dayjs(T).add(30, 'day')
  assert.equal(c.deadlineClass.call(vm, due2), 'proj-card__dl--soon')
  assert.equal(c.deadlineClass.call(vm, overdue), 'proj-card__dl--over')
  assert.equal(c.deadlineClass.call(vm, far), '')
  // wall-clock default (old code) would compute a -2000-day delta against 2020 and paint 'over'
  assert.equal(c.deadlineClass.call(vm, due2), 'proj-card__dl--soon', 'class must not flip on the wall clock')
})
