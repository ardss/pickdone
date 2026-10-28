/**
 * [w16-deck] user-reported card-view batch (2026-10-28) — regression tests:
 *   1. Overdue placement: an incomplete task dated on a PAST day INSIDE the window stays on its
 *      OWN day card (it used to be dumped into the today card's overdue zone AND stay on its own
 *      card -> duplicated / inflated today).
 *   2. Out-of-window overdue: only incomplete tasks older than the WINDOW START join the today
 *      card's overdue zone, capped at DECK_OVERDUE_CAP shown rows (+N numeric badge, no new i18n key).
 *   3. Window extension: base window is today ±30 days; a selected day outside it extends the
 *      window to cover the selection (capped at 180 days back). The component must NEVER write
 *      the (clamped) choice back into ui/setDaySelected — internal front clamping only.
 *   4. Drift normalization: bucketing compares dayStart()-normalized local midnights, so a
 *      cross-timezone synced row (dayStart at 13:00, or a 'YYYY-MM-DD' string) lands on its own
 *      day card instead of vanishing into the today overdue zone.
 *   5. No O(days x tasks) regression: cards bucket via ONE pass over the source list (Map), not
 *      a filter per card.
 * Pure logic lives in utils/dayWindow.js; the wiring is locked with source anchors (same
 * convention as maint-deep-r2-ux / navgate tests).
 * Run: node --test tests/unit/renderer/w16-deck-card-view.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { deckWindowDays, deckCards, DECK_SPAN_DAYS, DECK_MAX_HORIZON_DAYS, DECK_OVERDUE_CAP } from '../../../renderer/js/utils/dayWindow.js'
import { dayStart, dayShift } from '../../../renderer/js/utils/todayBounds.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const TODAY = dayStart('2026-10-28') // fixed local midnight; helpers must not read the clock

const task = (id, dayStart_, complete = false) => ({ taskId: id, dayStart: dayStart_, complete, delete: false, taskContent: id })

/* ---------- 1. window shape ---------- */

test('deckWindowDays: base window is today ±30 days centered on today', () => {
  const days = deckWindowDays(TODAY, 0)
  assert.equal(days.length, DECK_SPAN_DAYS * 2 + 1)
  assert.equal(days[DECK_SPAN_DAYS], TODAY, 'today sits mid-window')
  assert.equal(days[0], dayShift(TODAY, -30))
  assert.equal(days[days.length - 1], dayShift(TODAY, 30))
})

test('deckWindowDays: a selected day older than the window extends it (60 days back mandated case)', () => {
  const sel = dayShift(TODAY, -60)
  const days = deckWindowDays(TODAY, sel)
  assert.equal(days[0], sel, 'window starts AT the selected day')
  assert.ok(days.includes(sel) && days.includes(TODAY))
  assert.equal(days[days.length - 1], dayShift(TODAY, 30), 'future edge unchanged')
})

test('deckWindowDays: extension is capped at 180 days back, front clamps at the cap edge', () => {
  const farSel = dayShift(TODAY, -300)
  const days = deckWindowDays(TODAY, farSel)
  assert.equal(days[0], dayShift(TODAY, -DECK_MAX_HORIZON_DAYS), 'window start pinned to the -180d cap')
  assert.equal(days.length, DECK_MAX_HORIZON_DAYS + DECK_SPAN_DAYS + 1)
})

test('deckWindowDays: steps are local calendar midnights (dayShift), never raw ms products', () => {
  const days = deckWindowDays(TODAY, 0)
  for (const ts of days) assert.equal(ts, dayStart(ts), 'every member is a local midnight')
})

/* ---------- 2. overdue placement ---------- */

test('overdue task inside the window stays on its OWN day card and is NOT duplicated into today', () => {
  const d3 = dayShift(TODAY, -3)
  const list = [task('old', d3)]
  const days = deckWindowDays(TODAY, 0)
  const cards = deckCards(list, days, TODAY)
  const own = cards.find(c => c.ts === d3)
  const today = cards.find(c => c.ts === TODAY)
  assert.equal(own.all.length, 1, 'the overdue row lives on its own date card')
  assert.equal(today.overdue.length, 0, 'today overdue zone does not duplicate it')
  assert.equal(today.all.length, 0)
})

test('future-day tasks bucket onto their own cards within the window', () => {
  const d5 = dayShift(TODAY, 5)
  const cards = deckCards([task('fut', d5), task('tod', TODAY, true)], deckWindowDays(TODAY, 0), TODAY)
  assert.equal(cards.find(c => c.ts === d5).all.length, 1)
  assert.equal(cards.find(c => c.ts === TODAY).all.length, 1)
})

test('out-of-window overdue joins ONLY the today card, capped at DECK_OVERDUE_CAP shown rows', () => {
  const list = []
  for (let i = 1; i <= DECK_OVERDUE_CAP + 3; i++) list.push(task('ov' + i, dayShift(TODAY, -30 - i)))
  const days = deckWindowDays(TODAY, 0)
  const cards = deckCards(list, days, TODAY)
  const today = cards.find(c => c.ts === TODAY)
  assert.equal(today.overdue.length, list.length, 'today overdue zone holds all out-of-window rows (count feeds the label)')
  assert.equal(today.overdueShown.length, DECK_OVERDUE_CAP, 'shown rows are capped')
  assert.ok(!cards.some(c => c.ts === dayShift(TODAY, -31)), 'no card exists outside the window')
  assert.ok(cards.every(c => c.all.length === 0), 'nothing outside the window is double-bucketed onto a card')
  // nearest-first ordering so the capped slice shows the freshest overdue days
  assert.deepEqual(today.overdueShown.map(t => t.dayStart), [dayShift(TODAY, -31), dayShift(TODAY, -32), dayShift(TODAY, -33), dayShift(TODAY, -34), dayShift(TODAY, -35)])
})

test('completed out-of-window rows do NOT resurrect in the today overdue zone', () => {
  const cards = deckCards([task('done-old', dayShift(TODAY, -40), true)], deckWindowDays(TODAY, 0), TODAY)
  assert.equal(cards.find(c => c.ts === TODAY).overdue.length, 0)
})

test('overdue zone tracks the WINDOW START, not today-30: extension drains the zone', () => {
  const sel = dayShift(TODAY, -60)
  const list = [task('mid', dayShift(TODAY, -40)), task('edge', dayShift(TODAY, -80))]
  const days = deckWindowDays(TODAY, sel)
  const cards = deckCards(list, days, TODAY)
  assert.equal(cards.find(c => c.ts === dayShift(TODAY, -40)).all.length, 1, 'in-window overdue row has its own card')
  const today = cards.find(c => c.ts === TODAY)
  assert.equal(today.overdue.length, 1, 'only rows older than the window start remain in the zone')
  assert.equal(today.overdue[0].taskId, 'edge')
})

test('deleted rows and dayStart-less rows are ignored (old contract kept)', () => {
  const cards = deckCards(
    [task('x', TODAY), { taskId: 'del', dayStart: TODAY, delete: true }, { taskId: 'someday', dayStart: 0 }],
    deckWindowDays(TODAY, 0), TODAY)
  assert.equal(cards.find(c => c.ts === TODAY).all.length, 1)
  assert.equal(cards.find(c => c.ts === TODAY).overdue.length, 0)
})

/* ---------- 3. drift normalization ---------- */

test('a drifted (non-midnight) dayStart lands on its own day card, not the today overdue zone', () => {
  const d3 = dayShift(TODAY, -3)
  const drifted = task('drift', d3 + 13 * 3600000) // 13:00 of that day — non-local-midnight ms
  const cards = deckCards([drifted], deckWindowDays(TODAY, 0), TODAY)
  assert.equal(cards.find(c => c.ts === d3).all.length, 1, 'consumer-side dayStart() normalization buckets it home')
  assert.equal(cards.find(c => c.ts === TODAY).overdue.length, 0)
})

test("a 'YYYY-MM-DD' string dayStart parses as LOCAL wall time and buckets home", () => {
  const cards = deckCards([task('str', '2026-10-25')], deckWindowDays(TODAY, 0), TODAY)
  const own = cards.find(c => c.ts === dayStart('2026-10-25'))
  assert.equal(own.all.length, 1)
  assert.equal(cards.find(c => c.ts === TODAY).overdue.length, 0)
})

/* ---------- 4. no store write-back + wiring anchors ---------- */

test('DayDeck days derive from the store selection (extension is reactive) via deckWindowDays', () => {
  const src = read('renderer/js/components/DayDeck.vue')
  assert.match(src, /import \{[^}]*deckWindowDays, deckCards[^}]*\} from '\.\.\/utils\/dayWindow\.js'/)
  const days = src.slice(src.indexOf('    days ()'), src.indexOf('    today0 ()'))
  assert.match(days, /deckWindowDays\(this\.today0, this\.\$store\.state\.ui\.daySelectedTs\)/,
    'days must depend on the store selection so an out-of-window pick extends the window')
})

test('DayDeck cards delegate bucketing to deckCards (single pass, normalized, capped)', () => {
  const src = read('renderer/js/components/DayDeck.vue')
  const cards = src.slice(src.indexOf('    cards ()'), src.indexOf('    labelOf ()'))
  assert.match(cards, /deckCards\(this\.source, this\.days, this\.today0\)/,
    'no per-card list.filter: bucketing is the shared single-pass helper')
  assert.ok(!/t\.dayStart === ts/.test(src), 'raw strict-equality dayStart bucketing (drift amplifier) must stay deleted')
})

test('store watcher fronts the extended window WITHOUT writing the choice back', () => {
  const src = read('renderer/js/components/DayDeck.vue')
  const watcher = src.slice(src.indexOf("'$store.state.ui.daySelectedTs' (ts)"), src.indexOf('created ()'))
  assert.match(watcher, /dayStart\(\+ts\)/, 'the raw selection is dayStart()-normalized before lookup')
  assert.match(watcher, /_selSync = true/, 'front changes caused by the store sync are flagged')
  assert.ok(!watcher.includes("commit('ui/setDaySelected'"), 'the selection sync path must not write back')
})

test('front watcher write-back is guarded by _selSync (local flips sync the strip; store sync never rewrites)', () => {
  const src = read('renderer/js/components/DayDeck.vue')
  const front = src.slice(src.indexOf('    front (idx)'), src.indexOf("'$store.state.ui.daySelectedTs'"))
  assert.match(front, /if \(this\._selSync\)/, 'store-driven front changes skip the write-back')
  assert.match(front, /commit\('ui\/setDaySelected'/, 'local navigation still syncs the strip highlight')
})

test('created alignment fronts the selected day without a write-back and falls back to the cap edge', () => {
  const src = read('renderer/js/components/DayDeck.vue')
  const created = src.slice(src.indexOf('created ()'), src.indexOf('mounted ()'))
  assert.match(created, /clampToDayWindow/, 'a selection beyond the 180d horizon fronts the nearest cap edge')
  assert.match(created, /_selSync = true/, 'initial alignment must not trigger the front write-back')
})

test('the today-card overdue zone renders the capped slice + a numeric +N badge (no new i18n key)', () => {
  const src = read('renderer/js/components/DayDeck.vue')
  const tpl = src.slice(0, src.indexOf('<script'))
  assert.match(tpl, /v-for="t in c\.overdueShown"/, 'the overdue list renders the capped slice')
  assert.match(tpl, /deckOverdue/, 'label reuses the existing deckOverdue key')
  assert.match(tpl, /c\.overdue\.length - c\.overdueShown\.length/, 'numeric +N summary badge')
  const keys = ['deckOverdue', 'deckEmpty']
  for (const k of keys) {
    for (const loc of ['renderer/js/i18n/locales/zh-CN-E.js', 'renderer/js/i18n/locales/en-US-E.js']) assert.match(read(loc), new RegExp('"' + k + '"'), k + ' exists in ' + loc)
  }
})

test('hidden cards render as empty shells: card content is gated near the front (lazy render)', () => {
  const src = read('renderer/js/components/DayDeck.vue')
  const tpl = src.slice(0, src.indexOf('<script'))
  assert.match(tpl, /v-if="painted\(idx\)"/, 'content behind the visible band is not rendered')
  const methods = src.slice(src.indexOf('methods: {'), src.indexOf('</script>'))
  assert.match(methods, /painted \(idx\)/, 'the gate shares the styleOf visibility threshold')
})
