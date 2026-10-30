/**
 * F1 repeat-fix batch — regression tests (node:test, source-anchor + extracted-function style,
 * same seam approach as the d-wave series; no Vue mount needed).
 *
 * Covered:
 *   F1  shared/repeat-core.mjs renewalCarryFields: deadlineTs must SHIFT by the renewal dayDiff
 *       (was verbatim `t.deadlineTs || 0` — the renewed instance's date moved forward but its
 *       deadline stayed on the old instance's absolute day → born overdue, accumulating per gen).
 *   F2  RepeatDeleteModal: empty delete scope (ids=[]) must NOT run deleteTodosMany([]) + success
 *       toast — explicit error instead.
 *   F3  RepeatDeleteModal: "this and after" disabled/undefined base.dayStart (recycle-bin base,
 *       cleared dayStart) — radio disabled + confirm guard.
 *   F4  RepeatModal: editing an existing series (hydrateSeries path) must NOT write the merged
 *       form back into the global default repeat settings.
 *   F5  DepView quickDelete routes repeatId tasks through ui/askRepeatDelete (RepeatDeleteModal
 *       contract, same as TodoItem) instead of a direct deleteWithUndo.
 *
 * Run: node --test tests/unit/renderer/f1-repeat-fixes-20261015.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { createRequire } from 'node:module'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')
const require_ = createRequire(import.meta.url)
const dayjs = require_('dayjs')
dayjs.extend(require_('dayjs/plugin/isoWeek'))

const { renewalCarryFields } = await import('../../../shared/repeat-core.mjs')

const REPEAT_CORE = read('shared/repeat-core.mjs')
const DEL_MODAL = read('renderer/js/components/RepeatDeleteModal.vue')
const REPEAT_MODAL = read('renderer/js/components/RepeatModal.vue')
const DEP_VIEW = read('renderer/js/components/DepView.vue')

const DAY = 86400000
const DAY0 = +dayjs(new Date(2026, 9, 5)).startOf('day') // Mon 2026-10-05

/* ---------------- F1: renewalCarryFields shifts deadlineTs ---------------- */

test('F1: deadlineTs shifts by the same pure dayDiff as reminderExtra (no stale overdue chain)', () => {
  const src = { dayStart: DAY0, deadlineTs: DAY0 + 3 * DAY, reminderExtra: [DAY0 + 3600000] }
  // next instance 2 days later at 14:30 — dayDiff must be the PURE day diff (+2d), not +2d+14.5h
  const next = { todoTime: DAY0 + 2 * DAY + 14.5 * 3600000, reminderTime: 0 }
  const out = renewalCarryFields(src, next)
  assert.equal(out.deadlineTs, DAY0 + 3 * DAY + 2 * DAY,
    'deadline must move with the renewed instance day, keeping its intra-day anchor')
  assert.equal(out.reminderExtra[0], DAY0 + 3600000 + 2 * DAY,
    'deadline shift must use the exact same dayDiff the extras use')
})

test('F1: a deadline before the new instance day still moves forward (born-overdue bug fixed)', () => {
  // old behavior: instance moves +7d, deadline stayed at old day +2d → new instance overdue by 5d
  const src = { dayStart: DAY0, deadlineTs: DAY0 + 2 * DAY, reminderExtra: [] }
  const next = { todoTime: DAY0 + 7 * DAY, reminderTime: 0 }
  const out = renewalCarryFields(src, next)
  assert.equal(out.deadlineTs, DAY0 + 9 * DAY)
  assert.ok(out.deadlineTs >= next.todoTime - 12 * 3600000, 'renewed instance no longer born overdue')
})

test('F1: unknown anchor (no dayStart) falls back to the historical verbatim carry; no deadline stays no deadline', () => {
  const outNoAnchor = renewalCarryFields({ dayStart: 0, deadlineTs: DAY0 + DAY, reminderExtra: [123] },
    { todoTime: DAY0 + 2 * DAY, reminderTime: 0 })
  assert.equal(outNoAnchor.deadlineTs, DAY0 + DAY, 'cannot re-anchor → keep the value, never silently zero a real deadline')
  assert.deepEqual(outNoAnchor.reminderExtra, [], 'extras contract unchanged: dropped without an anchor')
  const outNoDeadline = renewalCarryFields({ dayStart: DAY0, deadlineTs: 0, reminderExtra: [] },
    { todoTime: DAY0 + 2 * DAY, reminderTime: 0 })
  assert.equal(outNoDeadline.deadlineTs, 0)
})

test('F1: the shift shares the dayDiff computation with reminderExtra (single source in the function)', () => {
  const m = REPEAT_CORE.match(/const dayDiff = \(([\s\S]*?)\n/)
  assert.ok(m, 'dayDiff computation present')
  assert.match(REPEAT_CORE, /t\.deadlineTs \+ dayDiff/, 'deadlineTs must be shifted with the same dayDiff binding')
  assert.doesNotMatch(REPEAT_CORE, /deadlineTs: t\.deadlineTs \|\| 0/, 'verbatim carry removed')
})

/* ---------------- F2/F3: RepeatDeleteModal empty-scope + invalid base day ---------------- */

test('F2: an empty delete scope is rejected before deleteTodosMany — no success toast, no undo snapshot', () => {
  const confirmAt = DEL_MODAL.indexOf('async confirm ()')
  const dispatchAt = DEL_MODAL.indexOf("dispatch('todo/deleteTodosMany'", confirmAt)
  const guardAt = DEL_MODAL.indexOf('if (!ids.length)', confirmAt)
  assert.ok(guardAt > 0, 'empty-scope guard present in confirm()')
  assert.ok(guardAt < dispatchAt, 'the guard must run BEFORE the batch delete dispatch')
  // the guard path returns with an error message and never reaches the success/undo toast
  const guardBody = DEL_MODAL.slice(guardAt, DEL_MODAL.indexOf('await this.$store.dispatch', guardAt))
  assert.match(guardBody, /this\.\$message\.error\(/, 'explicit error feedback on an empty scope')
  assert.doesNotMatch(guardBody, /deleteTodosMany/, 'guard body must not delete anything')
})

test('F3: the "this and after" option is disabled when the base day is invalid (recycle-bin / cleared dayStart)', () => {
  const fromRadio = DEL_MODAL.match(/<el-radio value="from"[^>]*>/)
  assert.ok(fromRadio, 'from radio found')
  assert.match(fromRadio[0], /:disabled="!baseDayValid"/, 'from scope requires a valid base dayStart')
  const comp = DEL_MODAL.match(/baseDayValid \(\) \{ return !!\(this\.base && this\.base\.dayStart > 0\) \}/)
  assert.ok(comp, 'baseDayValid must require dayStart > 0 (0/undefined are invalid)')
})

test('F3: an invalid base day makes the from-cutoff degenerate — confirm() must reject the scope', () => {
  // confirm() guard must sit BEFORE the ids computation (the cutoff is meaningless there)
  const confirmAt = DEL_MODAL.indexOf('async confirm ()')
  const fromGuardAt = DEL_MODAL.indexOf("this.mode === 'from' && !(b.dayStart > 0)", confirmAt)
  const idsAt = DEL_MODAL.indexOf('const ids = []', confirmAt)
  assert.ok(fromGuardAt > 0 && fromGuardAt < idsAt, '"from" scope rejected when base.dayStart is not > 0, before any id is collected')
  // behavioural check of WHY: with dayStart=0 the old comparison matches EVERY row (whole-group
  // delete); with undefined it matches nothing (silent no-op that still toasted success)
  const rows = [{ dayStart: DAY0 }, { dayStart: DAY0 + DAY }]
  const withZero = []
  const b0 = { dayStart: 0 }
  rows.forEach(t => { if (t.dayStart >= b0.dayStart) withZero.push(t) })
  assert.equal(withZero.length, 2, 'dayStart 0 cutoff degenerates to whole-group — hence the guard')
  const withUndef = []
  const bu = { dayStart: undefined }
  rows.forEach(t => { if (t.dayStart >= bu.dayStart) withUndef.push(t) })
  assert.equal(withUndef.length, 0, 'undefined cutoff matches nothing — hence the empty-scope guard')
})

/* ---------------- F4: RepeatModal edit path must not clobber global defaults ---------------- */

test('F4: generate() persists the global default ONLY on the new-series path (not after hydrateSeries)', () => {
  const genAt = REPEAT_MODAL.indexOf('async generate ()')
  const commitAt = REPEAT_MODAL.indexOf("commit('repeatSettings/updateSettings'", genAt)
  assert.ok(commitAt > 0, 'updateSettings commit present in generate()')
  const stmtStart = REPEAT_MODAL.lastIndexOf('if (!this.editingSeries)', commitAt)
  assert.ok(stmtStart > genAt && stmtStart < commitAt,
    'the commit must be guarded by the editingSeries flag (edit-existing-series path skips it)')
})

test('F4: hydrateSeries marks the edit-existing-series path when a persisted rule is applied', () => {
  const hydAt = REPEAT_MODAL.indexOf('async hydrateSeries ()')
  const assignAt = REPEAT_MODAL.indexOf('Object.assign(this.form, rule)', hydAt)
  const flagAt = REPEAT_MODAL.indexOf('this.editingSeries = true', hydAt)
  assert.ok(assignAt > 0 && flagAt > assignAt, 'editingSeries set right after the rule is merged into the form')
})

/* ---------------- F5: DepView repeat delete honors the scope-confirm contract ---------------- */

test('F5: DepView quickDelete routes repeatId tasks through ui/askRepeatDelete instead of deleteWithUndo', () => {
  const qdAt = DEP_VIEW.indexOf('quickDelete (t)')
  assert.ok(qdAt > 0, 'quickDelete present')
  const body = DEP_VIEW.slice(qdAt, DEP_VIEW.indexOf('toggleTomato (t)', qdAt))
  assert.match(body, /repeatId/, 'quickDelete must inspect the repeatId')
  assert.match(body, /commit\('ui\/askRepeatDelete'/, 'repeat tasks open the RepeatDeleteModal (globally mounted in layout.vue)')
  assert.match(body, /deleteWithUndo\(this, this\.\$store, todo\)/, 'non-repeat tasks keep the direct deleteWithUndo path')
  // contract parity with TodoItem's delete entry
  const todoItem = read('renderer/js/components/TodoItem.vue')
  assert.match(todoItem, /ui\/askRepeatDelete/, 'TodoItem contract reference intact')
})
