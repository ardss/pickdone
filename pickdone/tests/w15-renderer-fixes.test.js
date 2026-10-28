/**
 * [fix 2026-10-27] W15 renderer bug batch — regression tests (red→green discipline).
 *
 * Covers:
 *   1. EditPanel.vue global Esc whitelist must treat DayDateStrip's calendar popover
 *      (.ds-cal-pop) as an overlay that owns Esc; DayDateStrip's local esc handler must
 *      .stop so the keypress never reaches the window listener (panel closed + inline task
 *      orphan-deleted behind the user's back).
 *   2/3/4. nlDate.js English branch: "jan 2027" (month + 4-digit year, no day), weekend on
 *      Saturday itself, chip label preserves the user's casing.
 *   5. MatrixGrid dropOn: a drag whose row left this.tasks mid-drag must still resolve the
 *      task (dragId / dataTransfer fallback), and dragleave must not kill the quadrant
 *      highlight when crossing onto child elements (MatrixGrid + DayDeck).
 *
 * Component behavior is tested the established way (no node component-mount harness in this
 * repo, cf. tests/dayrail-resize-raf.test.js): the exact listener source is extracted from
 * the SFC and driven with stubs; pure contracts (esc wiring, template bindings) are pinned
 * by source assertions.
 * Run: node --test tests/w15-renderer-fixes.test.js
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import dayjs from 'dayjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

const editPanelSrc = read('renderer/js/components/EditPanel.vue')
const dayDateStripSrc = read('renderer/js/components/DayDateStrip.vue')
const matrixGridSrc = read('renderer/js/components/MatrixGrid.vue')
const dayDeckSrc = read('renderer/js/components/DayDeck.vue')

// ---------- Bug 1: Esc ownership ----------
test('EditPanel global Esc whitelist includes the DayDateStrip calendar popover', () => {
  assert.match(
    editPanelSrc,
    /document\.querySelector\('\.el-picker-panel[^']*\.ds-cal-pop[^']*'\)/,
    'the .ds-cal-pop popover must own Esc in the window-level whitelist'
  )
})

test('DayDateStrip calendar popover esc handler stops propagation', () => {
  assert.match(dayDateStripSrc, /@keydown\.esc\.prevent\.stop="showCal = false"/)
})

test('DayDateStrip focus-internal Esc handling (watch block) is untouched', () => {
  // The popover autofocus comment/flow at ~line 88 must remain: Esc closes while focus is
  // inside — our .stop must not regress that path (same element handler, focus starts inside).
  assert.match(dayDateStripSrc, /first\.focus\(\)/)
})

// ---------- Bugs 2/3/4: nlDate English branch ----------
// nlDate's dependency graph (core.js → i18n) touches `window` at import time; this is a
// headless node run — alias it to globalThis before the import.
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis
if (typeof globalThis.navigator === 'undefined') globalThis.navigator = { userAgent: 'node' }
const { parseNaturalDate } = await import('../renderer/js/utils/nlDate.js')
// Tue 2026-10-22 10:00 local
const BASE = dayjs(new Date(2026, 9, 22, 10, 0))

test('"jan 2027" resolves to Jan 1 2027 with no stray digits left in the title', () => {
  const r = parseNaturalDate('remodel jan 2027', BASE)
  assert.ok(r.date, 'a date must parse')
  assert.equal(r.date.format('YYYY-MM-DD'), '2027-01-01')
  assert.equal(r.restText, 'remodel', 'the year digits must be fully consumed')
  assert.equal(r.label, 'jan 2027')
})

test('pure "jan 2027" consumes the whole input', () => {
  const r = parseNaturalDate('jan 2027', BASE)
  assert.equal(r.date.format('YYYY-MM-DD'), '2027-01-01')
  assert.equal(r.restText, '')
})

test('existing month-day forms unchanged', () => {
  const a = parseNaturalDate('jan 15 2026', BASE)
  assert.equal(a.date.format('YYYY-MM-DD'), '2026-01-15')
  assert.equal(a.restText, '')
  assert.equal(a.label, 'jan 15 2026')
  const b = parseNaturalDate('jan 15, 2026', BASE)
  assert.equal(b.date.format('YYYY-MM-DD'), '2026-01-15')
  assert.equal(b.label, 'jan 15 2026')
  const c = parseNaturalDate('jan 15', BASE)
  // bare Jan 15 already passed in 2026 → rolls to 2027
  assert.equal(c.date.format('YYYY-MM-DD'), '2027-01-15')
  assert.equal(c.restText, '')
})

test('glued junk like "jan 152026" must not match at all', () => {
  const r = parseNaturalDate('jan 152026', BASE)
  assert.equal(r.date, null, 'invalid digit runs must not half-match')
  assert.equal(r.restText, 'jan 152026', 'input left intact when nothing parses')
})

test('"this weekend" on a Saturday resolves to the same day', () => {
  const sat = dayjs(new Date(2026, 9, 24, 9, 0)) // Saturday
  const r = parseNaturalDate('this weekend', sat)
  assert.equal(r.date.format('YYYY-MM-DD'), '2026-10-24')
})

test('"this weekend" from a weekday still lands on that week\'s Saturday', () => {
  const r = parseNaturalDate('this weekend', BASE) // Tue Oct 22
  assert.equal(r.date.format('YYYY-MM-DD'), '2026-10-24')
})

test('chip label preserves the user\'s casing ("Jan 15", not "jan 15")', () => {
  const r = parseNaturalDate('Jan 15', BASE)
  assert.equal(r.label, 'Jan 15')
  const r2 = parseNaturalDate('Jan 15, 2026', BASE)
  assert.equal(r2.label, 'Jan 15 2026')
})

// ---------- Bug 5: MatrixGrid drop fallback + dragleave ----------
// Extract dropOn's body verbatim from the SFC and drive it with a stub context.
{
  const m = matrixGridSrc.match(/dropOn \(q, e\) \{([\s\S]*?)\n {4}\},/)
  assert.ok(m, 'dropOn found in MatrixGrid.vue')
  const makeDropOn = new Function('return function dropOn (q, e) {' + m[1] + '}')

  const rig = ({ tasks, storeList, dragId }) => {
    const moved = []
    const ctx = {
      dragId,
      tasks,
      $store: { state: { todo: { todoList: storeList } } },
      moveQuadrant (t, q) { moved.push({ t, q }) }
    }
    return { ctx, moved, dropOn: makeDropOn().bind(ctx) }
  }

  const Q1 = { key: 'q1', important: 1, urgent: 1 }
  const task = id => ({ taskId: id, important: 0, urgent: 0 })
  const dt = id => ({ getData: () => String(id) })

  test('cross-view drop with stale dragId (row left this.tasks mid-drag) falls back to the store', () => {
    const { ctx, moved, dropOn } = rig({
      tasks: [task(2)], // dragged row (1) no longer rendered
      storeList: [task(1), task(2)],
      dragId: 1
    })
    dropOn.call(ctx, Q1, { dataTransfer: dt(1) })
    assert.equal(moved.length, 1, 'drop must move the task, not silently no-op')
  })

  test('drop with no internal dragId still resolves via dataTransfer (original cross-view path)', () => {
    const { ctx, moved, dropOn } = rig({ tasks: [], storeList: [task(7)], dragId: null })
    dropOn.call(ctx, Q1, { dataTransfer: dt(7) })
    assert.equal(moved.length, 1)
  })

  test('same-quadrant drop is still a no-op', () => {
    const { ctx, moved, dropOn } = rig({
      tasks: [{ taskId: 1, important: 1, urgent: 1 }],
      storeList: [{ taskId: 1, important: 1, urgent: 1 }],
      dragId: 1
    })
    dropOn.call(ctx, Q1, { dataTransfer: dt(1) })
    assert.equal(moved.length, 0)
  })

  test('unresolvable drop is still a no-op', () => {
    const { ctx, moved, dropOn } = rig({ tasks: [], storeList: [], dragId: null })
    dropOn.call(ctx, Q1, { dataTransfer: dt(99) })
    assert.equal(moved.length, 0)
  })
}

// Extract onDragLeave from both SFCs; both must keep the highlight while the pointer is
// over a child element and clear it when truly leaving.
const extractDragLeave = (src, file) => {
  const m = src.match(/onDragLeave \((idx, )?e\) \{([\s\S]*?)\n {4}\},/)
  assert.ok(m, `onDragLeave found in ${file}`)
  return { hasIdx: !!m[1], fn: new Function('return function onDragLeave (' + (m[1] || '') + 'e) {' + m[2] + '}')() }
}

for (const [file, src, key] of [['MatrixGrid.vue', matrixGridSrc, 'overKey'], ['DayDeck.vue', dayDeckSrc, 'dropHover']]) {
  const { hasIdx, fn: onDragLeave } = extractDragLeave(src, file)
  const containsTrue = { contains: () => true }
  const containsFalse = { contains: () => false }
  // DayDeck's handler takes (idx, e) and guards on dropHover === idx; call it the way the
  // template does — idx must equal the currently-highlighted card.
  const call = (ctx, evt) => hasIdx ? onDragLeave.call(ctx, ctx[key], evt) : onDragLeave.call(ctx, evt)

  test(`${file}: dragleave onto a CHILD element keeps the highlight (no flicker)`, () => {
    const ctx = { [key]: 'x' }
    call(ctx, { currentTarget: containsTrue, relatedTarget: {} })
    assert.equal(ctx[key], 'x', 'child crossing must not clear ' + key)
  })

  test(`${file}: dragleave out of the container clears the highlight`, () => {
    const ctx = { [key]: 'x' }
    call(ctx, { currentTarget: containsFalse, relatedTarget: {} })
    assert.equal(ctx[key], null, 'real leave must clear ' + key)
  })

  test(`${file}: dragleave with no relatedTarget (left to window edge) clears`, () => {
    const ctx = { [key]: 'x' }
    call(ctx, { currentTarget: containsTrue, relatedTarget: null })
    assert.equal(ctx[key], null)
  })

  test(`${file}: template binds the method, not the old inline clear`, () => {
    assert.match(src, /@dragleave="onDragLeave\(/)
    assert.doesNotMatch(src, /@dragleave="[a-zA-Z]+ ?===?[^"]*&& \([a-zA-Z]+ ?= ?null\)"/)
  })
}
