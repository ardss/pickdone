/**
 * W21 fixes:
 * 1. (P2) projDone fallback group (CategoryView/ProjectView extraGroups) used the non-exclusive
 *    predicate `t.complete && t.dayStart !== today`, so a completed row inside the past R1 window
 *    (catExpDone) or on day+1/day+2 (catTomorrow/catDat) rendered TWICE — once in its real bucket,
 *    once in projDone. Fix: shared exclusive predicate staleDoneExclusive (expiryGroups.js, same
 *    shape as the B9 tagStaleDone) — true only for completions OUTSIDE every other bucket.
 * 2. (P3) QuickAdd.createLines snapshotted this.effDate, which folds in the draft's NL-parsed
 *    date — the contract says NL parsing applies to the whole draft only, never to pasted lines.
 *    Fix: snapshot this.pickedDate (manual chip only).
 * 3. (P3) DayDeck days watcher's re-anchor guard compared calendar-day VALUES across window
 *    indices; after a midnight window shrink the previously fronted day moved index and the
 *    guard blocked the re-anchor, decoupling the card highlight from the store selection.
 *    Fix: the early-return already covers "same day still fronted"; any index drift re-anchors.
 * Run: node --test tests/unit/renderer/w21-projdone-paste-deck-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { readFileSync } from 'node:fs'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '../../..')
const require_ = createRequire(import.meta.url)
const dayjs = require_('dayjs')

const { buildExpiryGroups, staleDoneExclusive, tagStaleDone } = await import('../../../renderer/js/utils/expiryGroups.js')
const { dayShift } = await import('../../../renderer/js/utils/todayBounds.js')

const t = (k, o) => k + (o ? ':' + JSON.stringify(o) : '')
const today = +dayjs().startOf('day')
const R1 = 7
const settings = { expiredCompletedTodoRange: '7', expiredUncompletedTodoRange: '30' }

// ---------- Fix 1: exclusive projDone predicate (red/green matrix) ----------

test('staleDoneExclusive shares tagStaleDone semantics (B9 shape)', () => {
  for (const off of [-30, -8, -7, -3, -1, 0, 1, 2, 3, 30]) {
    const row = { complete: true, dayStart: dayShift(today, off) }
    assert.equal(staleDoneExclusive(row, today, R1), tagStaleDone(row, today, R1), 'offset ' + off)
  }
})

test('staleDoneExclusive bucket-membership matrix: exactly one group per completed row', () => {
  const cases = [
    { off: -3, bucket: 'catExpDone', projDone: false, why: 'past inside the R1 window -> catExpDone' },
    { off: -7, bucket: 'catExpDone', projDone: false, why: 'R1 window edge (inclusive) -> catExpDone' },
    { off: 0, bucket: 'catTodayDone', projDone: false, why: 'completed today -> catTodayDone' },
    { off: 1, bucket: 'catTomorrow', projDone: false, why: 'completed tomorrow -> catTomorrow' },
    { off: 2, bucket: 'catDat', projDone: false, why: 'completed day+2 -> catDat' },
    { off: 3, bucket: 'projDone', projDone: true, why: 'day+3 completion -> only projDone' },
    { off: -8, bucket: 'projDone', projDone: true, why: 'older than the R1 window -> only projDone' }
  ]
  for (const c of cases) {
    const ts = dayShift(today, c.off)
    assert.equal(staleDoneExclusive({ complete: true, dayStart: ts }, today, R1), c.projDone, c.why)
  }
  // non-qualifying rows
  assert.equal(staleDoneExclusive({ complete: true, dayStart: 0 }, today, R1), false, 'undated completion stays out')
  assert.equal(staleDoneExclusive({ complete: false, dayStart: dayShift(today, 3) }, today, R1), false, 'uncompleted rows stay in their own buckets')
})

test('buildExpiryGroups + projDone extraGroup renders each completed row exactly once', () => {
  const rows = [
    { taskId: 'a', taskSort: 9, createTime: 9, complete: true, dayStart: dayShift(today, -3) },  // catExpDone
    { taskId: 'b', taskSort: 8, createTime: 8, complete: true, dayStart: today },                // catTodayDone
    { taskId: 'c', taskSort: 7, createTime: 7, complete: true, dayStart: dayShift(today, 1) },   // catTomorrow
    { taskId: 'd', taskSort: 6, createTime: 6, complete: true, dayStart: dayShift(today, 2) },   // catDat
    { taskId: 'e', taskSort: 5, createTime: 5, complete: true, dayStart: dayShift(today, 3) },   // projDone only
    { taskId: 'f', taskSort: 4, createTime: 4, complete: true, dayStart: dayShift(today, -30) }  // projDone only
  ]
  const groups = buildExpiryGroups({
    list: rows,
    settings,
    today,
    t,
    keys: { expDone: 'k.expDone', expUndo: 'k.expUndo', upcoming: 'k.up', noDate: 'k.nd' },
    extraGroups: [{ key: 'projDone', titleKey: 'k.done', filter: x => staleDoneExclusive(x, today, R1), props: { showDate: true } }]
  })
  const seen = {}
  for (const g of groups) for (const r of g.todos) (seen[r.taskId] = seen[r.taskId] || []).push(g.key)
  for (const id of ['a', 'b', 'c', 'd', 'e', 'f']) {
    assert.deepEqual(seen[id], [seen[id][0]], 'row ' + id + ' appears in exactly one group (got ' + seen[id] + ')')
  }
  assert.deepEqual(seen.a, ['catExpDone'])
  assert.deepEqual(seen.b, ['catTodayDone'])
  assert.deepEqual(seen.c, ['catTomorrow'])
  assert.deepEqual(seen.d, ['catDat'])
  assert.deepEqual(seen.e, ['projDone'])
  assert.deepEqual(seen.f, ['projDone'])
  // regression: the OLD filter double-rendered a/b/c/d in projDone too
  const legacy = rows.filter(x => x.complete && x.dayStart !== today)
  assert.equal(legacy.length, 5, 'old predicate would have caught 5 already-bucketed rows (the bug)')
})

// ---------- Fix 2: QuickAdd paste path uses the manual chip only (source anchor) ----------

const qaddSrc = readFileSync(path.join(ROOT, 'renderer/js/components/QuickAdd.vue'), 'utf8')

test('QuickAdd.createLines snapshots pickedDate, not effDate (paste lines never inherit the draft NL date)', () => {
  // locate the createLines body
  const start = qaddSrc.indexOf('async createLines')
  assert.ok(start > 0, 'createLines found')
  const body = qaddSrc.slice(start, qaddSrc.indexOf('async', start + 10))
  assert.match(body, /const effDate = this\.pickedDate/, 'snapshot must be the manual chip (pickedDate), not effDate')
  assert.doesNotMatch(body, /const effDate = this\.effDate/, 'effDate leaks the draft NL-parsed date into pasted lines')
  // single-line draft path untouched: onEnter still resolves through effDate (NL parse kept)
  assert.match(qaddSrc, /resolveQuickAddDate\(\{\s*pickedDate:\s*this\.effDate/, 'single-line submit path keeps effDate semantics')
})

// ---------- Fix 3: DayDeck days watcher re-anchor (source anchor) ----------

const deckSrc = readFileSync(path.join(ROOT, 'renderer/js/components/DayDeck.vue'), 'utf8')

test('DayDeck days watcher drops the cross-window value-equality guard', () => {
  const start = deckSrc.indexOf('days (nDays, oDays)')
  assert.ok(start > 0, 'days watcher found')
  const body = deckSrc.slice(start, deckSrc.indexOf("'$store.state.ui.daySelectedTs'", start))
  assert.match(body, /if \(nDays\[this\.front\] === target\) return/, 'same-day-still-fronted early return kept (shifted-window case)')
  assert.match(body, /if \(idx !== this\.front\) \{[\s\S]*?_selSync = true[\s\S]*?this\.front = idx/, 'index drift always re-anchors onto the selection')
  assert.doesNotMatch(body, /nDays\[idx\] !== \(oDays/, 'old value-comparison guard removed (compared values across shifted indices)')
})
