/**
 * [w17-renderer] user-reported deck/timeline batch (2026-10-28) — regression tests:
 *   1. [P1] DayDeck front drift/blank board: `front` is a bare index; when `days` shrinks or
 *      shifts (midnight tick, daySelectedTs written 0) the front can point outside the window —
 *      every card display:none (blank board) and the ArrowRight guard dies. The component must
 *      re-anchor front onto the valid window aligned to the current selection (ts=0 → today0),
 *      preserving the same calendar day when the window merely shifts.
 *   2. [P1] DayRail selTs computed had no nowTs dependency: with daySelectedTs === 0 (the main
 *      path) its today0() froze at yesterday across midnight — timeline showed yesterday under a
 *      "Today" head and new chips were written into yesterday's bucket.
 *   3. [P2] TodoItem moveDay ignored dayStart: a pure-date task (dayStart in the future, no
 *      todoTime) "+1 day" was Math.max-pulled back to tomorrow (direction inverted). Base must
 *      prefer dayStart.
 *   4. [P2] TodayView list group compared bare `t.dayStart === sel` — drifted rows (cross-timezone
 *      sync / ISO string dayStart) visible in the deck vanished from the list. Same consumer-side
 *      dayStart() normalization as the deck.
 *   5. [P2] dayWindow.deckCards: incomplete rows dated BEYOND the window end fell into no bucket
 *      with no signal (the past direction has the +N overdue badge). They must be counted onto
 *      the last card as a numeric badge (pure number, no new i18n key).
 * Pure logic lives in utils/dayWindow.js; the component wiring is locked with source anchors
 * (same convention as w16-deck-card-view.test.mjs).
 * Run: node --test tests/unit/renderer/w17-deck-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { deckWindowDays, deckCards, anchorFrontIndex, DECK_SPAN_DAYS, DECK_MAX_HORIZON_DAYS } from '../../../renderer/js/utils/dayWindow.js'
import { dayStart, dayShift } from '../../../renderer/js/utils/todayBounds.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const TODAY = dayStart('2026-10-28')
const task = (id, dayStart_, complete = false) => ({ taskId: id, dayStart: dayStart_, complete, delete: false, taskContent: id })

/* ---------- bug 1: anchorFrontIndex + DayDeck days watcher ---------- */

test('anchorFrontIndex: ts=0 anchors onto today0 inside the window', () => {
  const days = deckWindowDays(TODAY, 0)
  assert.equal(anchorFrontIndex(days, TODAY, 0), DECK_SPAN_DAYS, 'front lands on today, not the stale bare index')
})

test('anchorFrontIndex: an out-of-range stale front is clamped back into the window (blank-board fix)', () => {
  const days = deckWindowDays(TODAY, 0)
  const shrunk = days.slice(0, 20) // window shrank below the old front (index 30); today is no longer a member
  const idx = anchorFrontIndex(shrunk, TODAY, 0)
  assert.ok(idx >= 0 && idx < shrunk.length, 'front is a valid index into the new window')
  assert.equal(shrunk[idx], shrunk[shrunk.length - 1], 'today outside the window fronts the nearest (last) member, never a ghost index')
})

test('anchorFrontIndex: selection inside the window fronts that day', () => {
  const sel = dayShift(TODAY, -60)
  const days = deckWindowDays(TODAY, sel)
  assert.equal(anchorFrontIndex(days, TODAY, sel), 0, 'extended window fronts the selection')
})

test('anchorFrontIndex: beyond-cap selection fronts the cap edge (no store write-back territory)', () => {
  const days = deckWindowDays(TODAY, dayShift(TODAY, -300))
  const idx = anchorFrontIndex(days, TODAY, dayShift(TODAY, -300))
  assert.equal(days[idx], dayShift(TODAY, -DECK_MAX_HORIZON_DAYS))
})

test('anchorFrontIndex: drifted/ISO-string selection normalizes before lookup', () => {
  const days = deckWindowDays(TODAY, 0)
  assert.equal(anchorFrontIndex(days, TODAY, '2026-10-28'), DECK_SPAN_DAYS)
  assert.equal(anchorFrontIndex(days, TODAY, TODAY + 13 * 3600000), DECK_SPAN_DAYS)
})

test('DayDeck watches days and re-anchors front (clamped, aligned to selection/today, no write-back)', () => {
  const src = read('renderer/js/components/DayDeck.vue')
  const w = src.slice(src.indexOf('  watch: {'), src.indexOf('created ()'))
  assert.match(w, /days \(/, 'a `days (nDays, oDays)` watcher must exist')
  assert.match(w, /anchorFrontIndex\(/, 're-anchor goes through the shared dayWindow helper')
  assert.match(w, /_selSync = true/, 'time/selection-driven re-anchors must not rewrite the store selection')
  assert.match(src, /import \{[^}]*anchorFrontIndex[^}]*\} from '\.\.\/utils\/dayWindow\.js'/)
})

test('DayDeck front never points outside days: guards compare against the live window length', () => {
  const src = read('renderer/js/components/DayDeck.vue')
  assert.match(src, /this\.front < this\.days\.length - 1/, 'ArrowRight guard reads the live window')
  assert.match(src, /this\.front > 0/, 'left guard intact')
})

/* ---------- bug 2: DayRail selTs midnight freeze ---------- */

test('DayRail selTs depends on nowTs so a ts=0 selection survives midnight', () => {
  const src = read('renderer/js/components/DayRail.vue')
  const selTs = src.slice(src.indexOf('selTs () {'), src.indexOf('isViewingToday ()'))
  assert.match(selTs, /void this\.nowTs/, 'selTs must add the same reactive nowTs dependency as today/selDayStart')
})

/* ---------- bug 3: TodoItem moveDay dayStart base ---------- */

test('moveDay bases the postpone on dayStart first (pure-date future task keeps direction)', () => {
  const src = read('renderer/js/components/TodoItem.vue')
  const mdFrom = src.indexOf('moveDay (offset)')
  const md = src.slice(mdFrom, src.indexOf('const startOf', mdFrom))
  assert.match(md, /cur\.dayStart\s*\?\s*dayjs\(cur\.dayStart\)/, 'base prefers the task dayStart over bare today')
})

test('moveDay postpone semantics stay at-least-tomorrow (max of wall-clock offset and base offset)', () => {
  const src = read('renderer/js/components/TodoItem.vue')
  const mdFrom = src.indexOf('moveDay (offset)')
  const md = src.slice(mdFrom, src.indexOf('const startOf', mdFrom))
  assert.match(md, /Math\.max\(\+dayjs\(\)\.add\(offset, 'day'\)\.startOf\('day'\), \+base\.add\(offset, 'day'\)\.startOf\('day'\)\)/)
})

/* ---------- bug 4: TodayView list filter normalization ---------- */

test('TodayView list groups bucket via dayStart() normalization (drifted rows stay visible)', () => {
  const src = read('renderer/js/views/TodayView.vue')
  assert.match(src, /import \{ dayStart \} from '\.\.\/utils\/todayBounds\.js'/, 'consumer-side dayStart import')
  const g = src.slice(src.indexOf('    groups () {'), src.indexOf('</script>'))
  assert.match(g, /dayStart\(/, 'the day-sel group filter normalizes both sides')
  assert.ok(!/filter\(t => t\.dayStart === sel\)/.test(g), 'raw strict-equality drift amplifier must stay deleted')
})

test('TodayView dayStart normalization buckets drifted rows correctly (pure check)', () => {
  // the same normalization the list filter uses
  const sel = dayStart(TODAY)
  const drifted = TODAY + 13 * 3600000 // 13:00 today
  const iso = '2026-10-28'
  assert.equal(dayStart(drifted), sel)
  assert.equal(dayStart(iso), sel)
})

/* ---------- bug 5: beyond-cap future rows counted on the last card ---------- */

test('deckCards counts incomplete rows beyond the window end on the LAST card (futureN)', () => {
  const days = deckWindowDays(TODAY, 0)
  const beyond = [task('f1', dayShift(TODAY, 31)), task('f2', dayShift(TODAY, 45)), task('f3', dayShift(TODAY, 200))]
  const cards = deckCards(beyond, days, TODAY)
  const last = cards[cards.length - 1]
  assert.equal(days[days.length - 1], dayShift(TODAY, DECK_SPAN_DAYS))
  assert.equal(last.futureN, 3, 'the last card carries the truncated future count')
  assert.ok(cards.slice(0, -1).every(c => c.futureN === 0), 'no other card carries it')
  assert.ok(last.all.length === 0, 'beyond-cap rows do not materialize onto a card')
})

test('deckCards futureN excludes completed rows (same contract as the overdue zone) and in-window rows', () => {
  const days = deckWindowDays(TODAY, 0)
  const list = [task('done-beyond', dayShift(TODAY, 60), true), task('in-window', dayShift(TODAY, 10)), task('beyond', dayShift(TODAY, 31))]
  const cards = deckCards(list, days, TODAY)
  assert.equal(cards[cards.length - 1].futureN, 1)
  assert.equal(cards.find(c => c.ts === dayShift(TODAY, 10)).all.length, 1)
})

test('deckCards with no beyond-cap rows reports futureN 0', () => {
  const cards = deckCards([task('t', TODAY)], deckWindowDays(TODAY, 0), TODAY)
  assert.ok(cards.every(c => c.futureN === 0))
})

test('DayDeck renders the future badge as a pure number reusing the overdue +N style (no new i18n key)', () => {
  const src = read('renderer/js/components/DayDeck.vue')
  const tpl = src.slice(0, src.indexOf('<script'))
  assert.match(tpl, /c\.futureN/, 'template reads the futureN counter')
  assert.match(tpl, /pd-day-deck__overdue-more[^>]*"\s*[^>]*\+{{ c\.futureN }}|v-if="c\.futureN"/, 'numeric badge reuses the +N styling')
  assert.ok(!/statsE\.TodayView\.[a-zA-Z]*(future|ahead|beyond)/i.test(tpl), 'no new i18n key introduced')
})
