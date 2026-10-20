/**
 * F5 ux-fix batch (2026-10-21) — regression tests, source-contract style (same seam as the
 * d-wave / f3 / f4 series; behavior tests where the module imports cleanly under Node).
 *
 * Covered:
 *   F5-1  RecycleBinView.purge: the single-item permanent-delete confirm names its button with
 *         the EXISTING statsC.RecycleBin.btnPurge key (no generic "OK" on the least reversible
 *         action in the app; no new i18n key minted).
 *   F5-2  TodoBoxView batch delete + HabitView del habit/del moment confirms: same naming via
 *         the EXISTING statsC.TodoBox.btnDelete key.
 *   F5-3  Transition durations tokenized to base.css --dur-fast/--dur-slow in the F5-owned
 *         files (TodoBoxView row + tools btn, RecycleBin .row-btn, HabitView .habit-wd +
 *         .habit-check). TodoGroupBlock/TomatoBar are out of F5's scope on purpose.
 *   F5-4  MatrixGrid: the two .matrix-task:hover rules merged into one; box-shadow joined the
 *         transition list (fades with the background instead of snapping).
 *   F5-5  RepeatModal: the dead @keyframes modal-pop is gone (defined, never referenced).
 *   F5-6  StatisticsView fmtCount: integers get a locale-aware thousands separator
 *         (Intl.NumberFormat + getLocale); the CSV export layer (statistics/csv.js) keeps
 *         plain digits — data-exchange format, verified behaviorally via buildExportRows.
 *
 * Run: node --test tests/unit/renderer/f5-ux-fixes-20261021.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

const RECYCLE = read('renderer/js/views/RecycleBinView.vue')
const TODOBOX = read('renderer/js/views/TodoBoxView.vue')
const HABIT = read('renderer/js/views/HabitView.vue')
const MATRIX = read('renderer/js/components/MatrixGrid.vue')
const REPEAT = read('renderer/js/components/RepeatModal.vue')
const EN_C = read('renderer/js/i18n/locales/en-US-C.js')
const ZH_C = read('renderer/js/i18n/locales/zh-CN-C.js')

test('F5-1 recycle-bin purge confirm button is action-named with the existing btnPurge key', () => {
  const purge = RECYCLE.slice(RECYCLE.indexOf('purge (t) {'))
  assert.match(purge, /confirmButtonText: this\.\$t\('statsC\.RecycleBin\.btnPurge'\)/,
    'single-item permanent delete must name its confirm button (btnPurge), not a generic 确定/OK')
  // key reuse, not a new key: btnPurge still defined in BOTH locale shards (F5 must not touch locales)
  assert.match(EN_C, /btnPurge: /)
  assert.match(ZH_C, /btnPurge/)
})

test('F5-2 batch delete + habit/moment delete confirms reuse the existing btnDelete key', () => {
  assert.match(TODOBOX, /confirmDelete.*confirmButtonText: this\.\$t\('statsC\.TodoBox\.btnDelete'\)/s)
  const delHabit = HABIT.slice(HABIT.indexOf('delHabitConfirm'))
  const delMoment = HABIT.slice(HABIT.indexOf('delMomentConfirm'))
  assert.match(delHabit, /confirmButtonText: this\.\$t\('statsC\.TodoBox\.btnDelete'\)/)
  assert.match(delMoment, /confirmButtonText: this\.\$t\('statsC\.TodoBox\.btnDelete'\)/)
  // key reuse, not a new key: btnDelete still defined in both shards
  assert.match(EN_C, /btnDelete: /)
  assert.match(ZH_C, /btnDelete/)
})

test('F5-3 transition durations use base.css --dur-fast/--dur-slow tokens (F5-owned files)', () => {
  // TodoBoxView row: large bg/state transition (.3s) -> slow; tools btn (.2s hover color) -> fast
  assert.match(TODOBOX, /todo-box-list-item\{position:relative;[^}]*transition:all var\(--dur-slow\)/)
  assert.match(TODOBOX, /__tools \.btn\{[^}]*transition:all var\(--dur-fast\)/)
  // RecycleBin .row-btn hover reveal -> fast
  assert.match(RECYCLE, /\.row-btn\{[^}]*transition:all var\(--dur-fast\)/)
  // HabitView weekday toggle + check circle -> fast
  assert.match(HABIT, /\.habit-wd \{[^}]*transition: all var\(--dur-fast\)/s)
  assert.match(HABIT, /\.habit-check \{[^}]*transition: all var\(--dur-fast\), transform var\(--dur-fast\)/s)
  // no raw hard-coded durations left on the touched declarations
  assert.ok(!/transition:all \.3s cubic-bezier/.test(TODOBOX), 'TodoBoxView row still hard-codes .3s')
  assert.ok(!/transition:all \.2s/.test(RECYCLE), 'RecycleBin .row-btn still hard-codes .2s')
  assert.ok(!/transition: all \.12s/.test(HABIT), 'HabitView .habit-wd still hard-codes .12s')
  // tokens exist in base.css (three tiers, exactly as consumed)
  const BASE = read('assets/css/base.css')
  assert.match(BASE, /--dur-fast: \.15s/)
  assert.match(BASE, /--dur-mid: \.25s/)
  assert.match(BASE, /--dur-slow: \.35s/)
})

test('F5-4 MatrixGrid hover rules merged into one; box-shadow transitions with the background', () => {
  const hovers = MATRIX.match(/\.matrix-task:hover \{[^}]*\}/g) || []
  assert.equal(hovers.length, 1, 'exactly ONE .matrix-task:hover rule (was split in two)')
  assert.match(hovers[0], /background: var\(--hover-bg\)/)
  assert.match(hovers[0], /box-shadow: 0 1px 4px rgba\(0, 0, 0, \.08\)/, 'hover shadow lives in the merged rule')
  const taskRule = MATRIX.match(/\.matrix-task \{[^}]*\}/s)[0]
  assert.match(taskRule, /transition: background var\(--dur-fast\), transform var\(--dur-fast\), box-shadow var\(--dur-fast\)/,
    'box-shadow is in the transition list so it fades with background')
})

test('F5-5 RepeatModal dead @keyframes modal-pop removed', () => {
  assert.ok(!/modal-pop/.test(REPEAT), 'modal-pop keyframes were defined but never referenced')
})

test('F5-6 CSV export stays plain digits; dead view-side fmtCount pure block removed (2026-10-21: fmtCount was never wired to the template — thousands-separator wiring deferred to reviewRows buildKpis)', () => {
  const flat = read('renderer/js/views/statistics/csv.js') + read('renderer/js/views/StatisticsView.vue')
  assert.ok(!flat.includes('1,234') && !flat.includes('6,543.5'), 'CSV cells must never contain thousands separators')
  assert.ok(!/pure-start/.test(read('renderer/js/views/StatisticsView.vue')), 'dead fmtCount pure block is gone (lint no-unused-vars)')
})
