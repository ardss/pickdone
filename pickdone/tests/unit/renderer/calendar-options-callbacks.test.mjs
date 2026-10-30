/**
 * Wave-4 reconciliation: function-level coverage for views/calendarOptions.js — the FullCalendar
 * option-callback closures were previously only exercised inside UI boots (no unit coverage), and
 * the coverage ratchet's function baseline regressed when the wave added new covered code elsewhere.
 * These drive every callback with mock self/info objects — pure wiring assertions, no FullCalendar.
 * Run: node --test tests/unit/renderer/calendar-options-callbacks.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

globalThis.localStorage = globalThis.localStorage || {
  _m: {},
  getItem (k) { return this._m[k] ?? null },
  setItem (k, v) { this._m[k] = String(v) },
  removeItem (k) { delete this._m[k] },
  clear () { this._m = {} },
  key (i) { return Object.keys(this._m)[i] ?? null },
  get length () { return Object.keys(this._m).length }
}
// getLocale() reads window.localStorage — point it at the same shim
globalThis.window.localStorage = globalThis.localStorage
// Pin the zh surface: Node >=21 exposes a global navigator whose language follows the ICU
// default locale (en-US on CI Linux with LANG=C), and getLocale() would otherwise fall into
// its system-language branch and render the en surface
globalThis.localStorage.setItem('appLocale', 'zh-CN')

const { wdLabel, buildCalendarOptions } = await import('../../../renderer/js/views/calendarOptions.js')

const mkEl = () => ({ _attrs: {}, setAttribute (k, v) { this._attrs[k] = v }, classList: { add (c) { this._cls = c } }, listeners: {}, addEventListener (t, fn) { this.listeners[t] = fn } })

const mkSelf = (over = {}) => Object.assign({
  view: 'dayGridWeek',
  busyDays: null,
  lunarMap: {},
  fcEvents: [],
  todayInView: false,
  cursorTs: 0,
  selMonthTs: 0,
  taskById: new Map(),
  $t: k => k,
  $store: { dispatch: async () => null, commit: (a, b) => { this._last = a } },
  $nextTick: async fn => { if (fn) await fn() },
  markEmptyDays: () => {},
  openDayPeek: () => {},
  dayStart,
  _dragInfo: null
}, over)
function dayStart (x) { const d = globalThis.window.dayjs(x); return +d.startOf('day') }

test('wdLabel maps dayjs day() (Sun=0) onto the Monday-first wd0..wd6 key family', () => {
  assert.equal(wdLabel(k => k, 0), 'statsJ.CalendarView.wd6', 'Sunday -> wd6 (last slot, Monday-first)')
  assert.equal(wdLabel(k => k, 1), 'statsJ.CalendarView.wd0', 'Monday -> wd0')
  assert.equal(wdLabel(k => k, 6), 'statsJ.CalendarView.wd5')
})

test('buildCalendarOptions: static option shape + locale branch', () => {
  const cfg = buildCalendarOptions(mkSelf(), 1700000000000)
  assert.equal(cfg.headerToolbar, false)
  assert.equal(cfg.editable, true)
  assert.equal(cfg.eventDurationEditable, false)
  assert.ok(cfg.initialDate)
  const cfgEn = buildCalendarOptions(mkSelf(), null)
  assert.equal(cfgEn.initialDate, undefined, 'no initial date -> undefined (FullCalendar defaults to today)')
})

test('datesSet: todayInView window + reactive cursor/selMonthTs refresh', () => {
  const dayjs = globalThis.window.dayjs
  const self = mkSelf()
  const start = dayjs().startOf('month')
  const cfg = buildCalendarOptions(self, null)
  cfg.datesSet({ view: { currentStart: +start, currentEnd: +start.endOf('month'), currentDate: +start.add(2, 'day') } })
  assert.equal(self.todayInView, true, 'today inside the view range')
  assert.equal(self.cursorTs, +dayjs(start.add(2, 'day')).startOf('day'))
  assert.equal(self.selMonthTs, +start.startOf('month'))
  const self2 = mkSelf()
  const cfg2 = buildCalendarOptions(self2, null)
  cfg2.datesSet({ view: { currentStart: +start.subtract(2, 'month'), currentEnd: +start.subtract(1, 'month'), currentDate: +start.subtract(2, 'month') } })
  assert.equal(self2.todayInView, false, 'today outside the view range')
})

test('moreLinkClick: routes to openDayPeek and cancels the native popover', () => {
  const seen = []
  const self = mkSelf({ openDayPeek: (ts, el) => seen.push([ts, el]) })
  const el = {}
  const cfg = buildCalendarOptions(self, null)
  const r = cfg.moreLinkClick({ date: new Date('2026-05-05T10:00:00'), dayEl: el })
  assert.equal(r, false, 'native more-popover suppressed')
  assert.equal(seen.length, 1)
})

test('dayCellDidMount/eventDidMount/eventClick: a11y attributes + enter-to-edit wiring', () => {
  const commits = []
  const self = mkSelf({ $store: { dispatch: async () => null, commit: (a, b) => commits.push([a, b]) } })
  const cfg = buildCalendarOptions(self, null)
  const cell = mkEl()
  cfg.dayCellDidMount({ date: new Date(), el: cell })
  assert.equal(cell._attrs.tabindex, '0')
  assert.equal(cell._attrs.role, 'gridcell')
  const evEl = mkEl()
  const raw = { taskId: 't1' }
  self.taskById.set('t1', raw)
  cfg.eventDidMount({ el: evEl, event: { id: 't1', title: 'T' } })
  assert.equal(evEl._attrs.tabindex, '0')
  evEl.listeners.keydown({ key: 'Enter', preventDefault: () => {} })
  assert.deepEqual(commits, [['ui/openEdit', raw]], 'Enter on a chip opens the editor')
  cfg.eventClick({ jsEvent: { preventDefault: () => {} }, event: { id: 't1' } })
  assert.equal(commits.length, 2)
})

test('eventDragStart/Stop: drag-state bookkeeping + listener cleanup', () => {
  const cfg = buildCalendarOptions(mkSelf({ _droppedAt: 0 }), null)
  const added = []
  const removed = []
  const origDoc = globalThis.document
  globalThis.document = {
    addEventListener: (t, fn) => added.push([t, fn]),
    removeEventListener: (t, fn) => removed.push([t, fn])
  }
  try {
    cfg.eventDragStart({ event: { id: 't9', start: new Date() } })
    assert.equal(added.length, 1, 'mousemove edge listener armed')
    cfg.eventDragStop()
    assert.equal(removed.length, 1, 'listener disarmed on drag stop')
  } finally { globalThis.document = origDoc }
})

test('dayCellContent: html payload with weekday label; lunar badge only on the zh surface', () => {
  const self = mkSelf({ lunarMap: { [globalThis.window.dayjs().format('YYYY-MM-DD')]: '白露' } })
  const cfg = buildCalendarOptions(self, null)
  const out = cfg.dayCellContent({ date: new Date(), dayNumberText: '7' })
  assert.ok(out.html.includes('todo-week'), 'weekday row present')
  assert.ok(out.html.includes('白露'), 'lunar badge on the zh surface')
  const selfEn = mkSelf()
  const outEn = buildCalendarOptions(selfEn, null).dayCellContent({ date: new Date(), dayNumberText: '7' })
  assert.ok(!outEn.html.includes('todo-lunar'), 'no lunar badge on the en surface')
})

test('events: success(fcEvents) + busyDays recorded', async () => {
  const dayjs = globalThis.window.dayjs
  const self = mkSelf({ fcEvents: [{ start: +dayjs().startOf('day'), title: 'x' }] })
  const cfg = buildCalendarOptions(self, null)
  await new Promise(res => cfg.events({}, list => { res(list) }))
  assert.ok(self.busyDays instanceof Set && self.busyDays.size === 1)
})
