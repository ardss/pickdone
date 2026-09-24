/**
 * Component UX/a11y fixes — regression tests (node:test, no Vue mount).
 * Pure logic is extracted verbatim from the .vue sources between
 * "[component-fixes] pure-start/end" markers; template/CSS/aria fixes are
 * asserted at source level (visual gate covers rendering).
 *
 * Run: node --test tests/component-fixes-a11y.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { attachmentUrlPresent } from '../../../renderer/js/utils/attachmentRefs.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

/* ---------------- i18n bilingual parity ---------------- */

test('i18n: every en-US shard has a zh-CN twin with the same keys', async () => {
  const dir = path.join(ROOT, 'renderer/js/i18n/locales')
  const enFiles = readdirSync(dir).filter(f => f.startsWith('en-US-'))
  for (const f of enFiles) {
    const zf = f.replace('en-US', 'zh-CN')
    const e = (await import(pathToFileURL(path.join(dir, f)).href)).default
    const z = (await import(pathToFileURL(path.join(dir, zf)).href)).default
    const ke = Object.keys(e).sort()
    const kz = Object.keys(z).sort()
    assert.deepEqual(ke, kz, `${f} vs ${zf} key parity`)
  }
})

test('i18n: newly added fix keys exist in both languages with matching placeholders', async () => {
  const dir = path.join(ROOT, 'renderer/js/i18n/locales')
  const load = async f => (await import(pathToFileURL(path.join(dir, f)).href)).default
  const en = await load('en-US-E.js')
  const zh = await load('zh-CN-E.js')
  const enG = await load('en-US-G.js')
  const zhG = await load('zh-CN-G.js')
  const enD = await load('en-US-D.js')
  const zhD = await load('zh-CN-D.js')

  assert.ok(en.statsE.HabitView.intervalAria && zh.statsE.HabitView.intervalAria)
  // EditPanel keys moved to shard J on 2026-09-12 (mixed-stage E dismantle)
  const enJ = await load('en-US-J.js')
  const zhJ = await load('zh-CN-J.js')
  for (const [e, z] of [[enJ['statsJ.EditPanel.depsTruncated'], zhJ['statsJ.EditPanel.depsTruncated']]]) {
    assert.match(e, /\{shown\}/); assert.match(e, /\{total\}/)
    assert.match(z, /\{shown\}/); assert.match(z, /\{total\}/)
  }
  assert.ok(enG.statsG.EpTomato.estDecrease && zhG.statsG.EpTomato.estDecrease)
  assert.ok(enG.statsG.EpTomato.estIncrease && zhG.statsG.EpTomato.estIncrease)
  assert.ok(enG.statsG.DayRail.planDeleted && zhG.statsG.DayRail.planDeleted)
  assert.ok(enG.statsG.SideNav.dblclickRenameTip && zhG.statsG.SideNav.dblclickRenameTip)
  for (const k of ['prevMonth', 'nextMonth', 'prevYear', 'nextYear']) {
    assert.ok(enD.statsD.DayDateStrip[k], `en DayDateStrip.${k}`)
    assert.ok(zhD.statsD.DayDateStrip[k], `zh DayDateStrip.${k}`)
  }
})

/* ---------------- EditPanel: delayed disk deletion guard ---------------- */

test('EditPanel pure helper: attachmentUrlPresent detects url in image/files JSON (fail-safe on bad JSON)', () => {
  // Moved verbatim to utils/attachmentRefs.js (structure-size ratchet); imported directly now
  const row = {
    image: JSON.stringify([{ url: 'att://a.png', name: 'a.png' }]),
    files: JSON.stringify([{ url: 'att://b.pdf', name: 'b.pdf' }])
  }
  assert.equal(attachmentUrlPresent(row, 'att://a.png'), true)
  assert.equal(attachmentUrlPresent(row, 'att://b.pdf'), true)
  assert.equal(attachmentUrlPresent(row, 'att://c.txt'), false)
  assert.equal(attachmentUrlPresent(null, 'att://a.png'), false)
  assert.equal(attachmentUrlPresent({}, 'att://a.png'), false)
  assert.equal(attachmentUrlPresent({ image: 'not-json' }, 'att://a.png'), true, 'malformed JSON counts as present')
  assert.equal(attachmentUrlPresent({ image: '[{}]' }, ''), false, 'empty url never matches')
})

test('EditPanel: disk deletion defers to the undo-toast dismiss hook and re-checks the store row first', () => {
  // 2026-09-25 P1 fix: the fixed 5.5s setTimeout raced the hover-paused undo toast (hover past
  // 5.5s + 撤销 revived the list entry with the file already gone). Deletion now rides the
  // toast's onDismiss (fires after the toast actually closes on any path) behind an undone flag.
  const src = read('renderer/js/components/EditPanel.vue')
  // 5500 now appears ONLY in the no-toast fallback branch (toast unavailable -> old semantics);
  // the primary path defers to onDismiss with no parallel timer.
  // Review-hardening (round 2): indexOf ORDER assertions instead of slice+includes/regex —
  // robust against comment rewording and whitespace changes, still pins the exact mechanism.
  const rmStart = src.indexOf('removeFile (arrName, idx)')
  const fallbackIdx = src.indexOf('if (!removeWithUndo(this,')
  const fallbackTimerIdx = src.indexOf('setTimeout(deleteFromDisk, 5500)')
  assert.ok(rmStart > -1, 'removeFile method present')
  assert.ok(fallbackIdx > rmStart, 'fallback branch sits inside removeFile, after the primary removeWithUndo call')
  assert.ok(fallbackTimerIdx > fallbackIdx, 'the 5500 timer exists ONLY in the fallback branch')
  const primary = src.slice(rmStart, fallbackIdx)
  assert.ok(!primary.includes('setTimeout('), 'primary path defers disk deletion to the toast dismiss hook, not a timer')
  const guardIdx = src.indexOf('attachmentUrlPresent(row, item.url)')
  const deleteIdx = src.indexOf('deleteFile(item.url)')
  assert.ok(guardIdx > 0 && deleteIdx > guardIdx, 'deleteFile only runs after the store-row url guard')
  const block = src.slice(src.indexOf('removeFile (arrName, idx)'), src.indexOf('delTask ()'))
  assert.match(block, /undone = true/, 'undo marks the deletion as undone')
  assert.match(block, /onDismiss: deleteFromDisk/, 'disk deletion rides the toast dismiss hook')
  // review-fix (2026-09-25): removeWithUndo now reports whether the toast was shown; the
  // early-return path (no $message/Vue) falls back to the old fixed-delay deletion instead of
  // leaking the disk file forever (onDismiss would never fire there).
  // (fallback ordering asserted above via indexOf — no text-order-fragile regex here)
})

/* ---------------- EditPanel: pomodoro estimate stepper labels ---------------- */

test('EditPanel: estimate −/+ buttons have distinct decrease/increase aria-labels', () => {
  // maint/dw-wave2 domain-2 split: the ledger row lives in edit-panel/EpTomato.vue now
  const src = read('renderer/js/components/edit-panel/EpTomato.vue')
  assert.match(src, /:aria-label="\$t\('statsG\.EpTomato\.estDecrease'\)" @click\.stop="\$emit\('est-delta', -1\)"/)
  assert.match(src, /:aria-label="\$t\('statsG\.EpTomato\.estIncrease'\)" @click\.stop="\$emit\('est-delta', 1\)"/)
  assert.ok(!/aria-label="\$t\('statsG\.EpTomato\.estTip'\)" @click\.stop="\$emit\('est-delta'/.test(src), 'shared hint label removed')
})

/* ---------------- EditPanel: subtask row a11y/UX ---------------- */

test('EditPanel: subtask ↑/↓ buttons stay reachable (opacity, not display:none)', () => {
  // 2026-09-12 S4 split: subtask block lives in edit-panel/EpSubtasks.vue
  const src = read('renderer/js/components/edit-panel/EpSubtasks.vue')
  assert.ok(!/\.ep-sub-move\s*\{\s*display:\s*none/.test(src), 'display:none removed')
  assert.match(src, /\.ep-sub:focus-within \.ep-sub-move\s*\{\s*opacity:\s*1/)
})

test('EditPanel: subtask text click toggles the subtask (cursor:pointer now honest)', () => {
  const src = read('renderer/js/components/edit-panel/EpSubtasks.vue')
  assert.match(src, /class="ep-sub-text"[^>]*@click="toggleSub\(s\)"/)
})

test('EditPanel: dependency candidate truncation is announced', () => {
  const src = read('renderer/js/components/edit-panel/EpDependencies.vue')
  assert.match(src, /depsTruncated/, 'truncation notice rendered')
  assert.match(src, /depTotal \(\)/, 'depTotal computed present')
})

/* ---------------- SearchView / TodoItem / DayDateStrip / QuickAdd / TodayXView ---------------- */

test('SearchView: clear button handles Enter like the date chip pattern', () => {
  const src = read('renderer/js/views/SearchView.vue')
  assert.match(src, /main-nav-search__clear[^>]*@keydown\.enter\.prevent="clearQ"/)
})

test('TodoItem: Ctrl+Arrow shortcuts only announced for dated tasks', () => {
  const src = read('renderer/js/components/TodoItem.vue')
  assert.match(src, /:aria-keyshortcuts="todo\.dayStart \? 'Control\+ArrowUp Control\+ArrowDown Shift\+Delete' : 'Shift\+Delete'"/)
})

test('DayDateStrip: calendar ‹ › buttons have titles/aria-labels', () => {
  const src = read('renderer/js/components/DayDateStrip.vue')
  assert.match(src, /calNav\(-1\)" :title="\$t\('statsD\.DayDateStrip\.prevMonth'\)" :aria-label=/)
  assert.match(src, /calNav\(1\)" :title="\$t\('statsD\.DayDateStrip\.nextMonth'\)" :aria-label=/)
})

test('QuickAdd: hidden calendar picker input is removed from the Tab chain on mount', () => {
  const src = read('renderer/js/components/QuickAdd.vue')
  assert.match(src, /ref="calPick"/)
  assert.match(src, /setAttribute\('tabindex', '-1'\)/)
})

test('TodayXView: collapsed drawer is visibility:hidden (content out of Tab chain)', () => {
  const src = read('renderer/js/views/TodayXView.vue')
  assert.match(src, /\.tx-drawer\{[^}]*visibility:hidden/)
  assert.match(src, /\.tx-drawer\.open\{[^}]*visibility:visible/)
})

test('TodoBoxView: dropdown triggers are focusable and open via Enter; menu items keyboard-activatable', () => {
  const src = read('renderer/js/views/TodoBoxView.vue')
  const triggers = src.match(/dropdown-select__label" role="button" tabindex="0"/g) || []
  assert.equal(triggers.length, 3, 'all three triggers focusable')
  assert.match(src, /@keydown\.enter\.prevent="tbTriggerKey"/)
  // the TS cast lives in the tbTriggerKey method (structure guard rejects `as` in templates)
  assert.match(src, /tbTriggerKey \(e\) { \(e\.currentTarget as HTMLElement\)\.click\(\) }/)
  assert.ok(!/class="dd-menu">\s*<li[^>]*@click="setSort\(m\.value\)"[^>]*>\{\{ m\.label \}\}<\/li>\s*<\/ul>\s*<template #reference><span class="dropdown-select__label">{{/.test(src.replace(/\n\s+/g, ' ')), 'sort li lacks keyboard') // sanity regex
  assert.match(src, /@keydown\.enter\.prevent="setSort\(m\.value\)"/)
  assert.match(src, /@keydown\.enter\.prevent="setOrder\(o\.value\)"/)
  assert.match(src, /@keydown\.enter\.prevent="setCat\(c\.categoryId\)"/)
})

test('SideNav: category rows advertise double-click rename via title', () => {
  // maint/dw-wave2 domain-2 split: folder/child/flat rows are one SnCategoryItem — the title
  // on its single root serves all three variants
  const src = read('renderer/js/components/side-nav/SnCategoryItem.vue')
  assert.match(src, /:title="\$t\('statsG\.SideNav\.dblclickRenameTip'\)"/)
  for (const v of ['folder', 'child', 'flat']) assert.match(src, new RegExp(`'${v}'`), `${v} variant served by the single row component`)
})

/* ---------------- HabitView ---------------- */

test('HabitView: weekday picker uses real buttons with aria-pressed', () => {
  const src = read('renderer/js/views/HabitView.vue')
  assert.match(src, /<button v-for="\(w,i\) in WD"[^>]*type="button" class="habit-wd"/)
  assert.match(src, /:aria-pressed="freqWeekdays\.includes\(i\) \? 'true' : 'false'"/)
  assert.ok(!/<label v-for="\(w,i\) in WD"/.test(src), 'click-only labels removed')
})

test('HabitView: interval number input has an aria-label', () => {
  const src = read('renderer/js/views/HabitView.vue')
  assert.match(src, /habit-interval-n" :aria-label="\$t\('statsE\.HabitView\.intervalAria'\)"/)
})

test('HabitView: 30-day grid tooltip formats the date via dayjs instead of the raw key', () => {
  const src = read('renderer/js/views/HabitView.vue')
  assert.match(src, /:title="gridTip\(d\)"/)
  assert.match(src, /gridTip \(d\) \{ return dayjs\(d\.key\)\.format\(FMT\.cnDate\)/)
  assert.ok(!/d\.key \+ \(d\.on \? ' ✓'/.test(src))
})

/* ---------------- MatrixGrid / DayRail ---------------- */

test('MatrixGrid: drag-over highlight moved to the quadrant root', () => {
  const src = read('renderer/js/components/MatrixGrid.vue')
  assert.match(src, /class="matrix-quadrant" :class="\[q\.cls, \{ 'over': overKey===q\.key \}\]"/)
  assert.match(src, /\.matrix-quadrant\.over\s*\{\s*outline:\s*2px solid var\(--brand\)/)
  assert.ok(!/__head"[^>]*:class="\{'over'/.test(src), 'head-level over binding removed')
})

test('DayRail: removePlan goes through the 5s undo toast contract', () => {
  const src = read('renderer/js/components/DayRail.vue')
  assert.match(src, /import \{ removeWithUndo \} from '\.\.\/utils\/confirm\.js'/)
  const fn = src.slice(src.indexOf('removePlan (p)'), src.indexOf('planDone (p)'))
  assert.match(fn, /removeWithUndo\(this/)
  assert.match(fn, /dayPlans\.addChips\(/, 'undo re-adds the plan chip')
  assert.match(fn, /dayPlans\.removeChips\(/, 'do-path removes the plan chip')
})

test('DayRail: deleted-task plan chips show a localized fallback, not the raw taskId', () => {
  const src = read('renderer/js/components/DayRail.vue')
  assert.match(src, /t \? t\.taskContent : this\.\$t\('statsG\.DayRail\.planDeleted'\)/)
  assert.ok(!/name: t \? t\.taskContent : taskId/.test(src))
})
