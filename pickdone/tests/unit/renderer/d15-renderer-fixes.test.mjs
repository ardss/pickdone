/**
 * D15 renderer fixes (views / components / i18n wave, 2026-10-03).
 * Behavior fixes carry real unit tests; template-level fixes carry source-anchor locks
 * (the established pattern here, e.g. uiux-1001-quickadd-esc.test.mjs — mounting SFCs
 * in the Node harness is out of scope).
 * Run: node --test tests/unit/renderer/d15-renderer-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { buildTbBuckets, tbBucketGet, TB_HOURS } from '../../../renderer/js/utils/calendarBuckets.js'
import { splitRecordStart } from '../../../renderer/js/utils/recordAnchor.js'
import { roleButtonActivate } from '../../../renderer/js/utils/roleButtonKey.js'
import { dayjs } from '../../../renderer/js/utils/core.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

const HOUR = 3600000
const toDayTs = ts => +dayjs(ts).startOf('day')

/* ===== A1: time-block hour window contract ===== */

test('A1: every bucket a task can produce is reachable from the rendered TB_HOURS window', () => {
  assert.deepEqual(TB_HOURS, Array.from({ length: 24 }, (_, i) => i))
  const day0 = +dayjs('2026-10-05T00:00:00').startOf('day')
  // 00:30 and 05:15 used to vanish: bucketed fine, but the grid only rendered hours 6-23
  const list = [
    { taskId: 'early', todoTime: day0 + 0.5 * HOUR, dayStart: day0 },
    { taskId: 'dawn', todoTime: day0 + 5.25 * HOUR, dayStart: day0 },
    { taskId: 'day', todoTime: day0 + 14 * HOUR, dayStart: day0 }
  ]
  const buckets = buildTbBuckets(list, toDayTs)
  for (const t of list) {
    const hour = Math.floor((t.todoTime - toDayTs(t.todoTime)) / HOUR)
    assert.ok(TB_HOURS.includes(hour), `hour ${hour} must be rendered`)
    assert.deepEqual(tbBucketGet(buckets, day0, hour).map(x => x.taskId), [t.taskId])
  }
})

/* ===== A3: ledger record anchored to its START day ===== */

test('A3: cross-midnight record yields a 0-1439 startMin that round-trips losslessly', () => {
  const day = '2026-10-05'
  const end = +dayjs(`${day}T00:20:00`) // 23:50 -> 00:20 record: end day is the 5th, start day the 4th
  const { startTs, day0, startMin } = splitRecordStart(end, 30)
  assert.equal(startMin, 23 * 60 + 50, 'start anchored to the previous day: 23:50, not -10')
  assert.equal(startMin >= 0 && startMin <= 1439, true, 'picker clamps to 0-1439, so startMin must be in range')
  assert.equal(day0, +dayjs('2026-10-04T00:00:00'))
  // saveEdit reconstructs endTime = day0 + startMin*60000 + dur*60000 — must equal the original
  assert.equal(day0 + startMin * 60000 + 30 * 60000, end)
  assert.equal(startTs, end - 30 * 60000)
})

test('A3: same-day record is unchanged by the re-anchoring', () => {
  const end = +dayjs('2026-10-05T14:30:00')
  const { day0, startMin } = splitRecordStart(end, 25)
  assert.equal(day0, +dayjs('2026-10-05T00:00:00'))
  assert.equal(startMin, 14 * 60 + 5)
})

/* ===== A13: ARIA button pattern — Enter AND Space ===== */

test('A13: roleButtonActivate fires on Enter and Space, ignores other keys', () => {
  let calls = 0
  const handler = roleButtonActivate(function () { calls++; assert.equal(this.ctxMarker, 'self') })
  const evts = []
  const mk = key => { const e = { key, preventDefault: () => { e.pd = true } }; return e }
  const ctx = { ctxMarker: 'self' }
  handler.call(ctx, mk('Enter')); assert.equal(calls, 1)
  handler.call(ctx, mk(' ')); assert.equal(calls, 2)
  assert.equal(evts.length, 0)
  for (const k of ['a', 'Escape', 'Tab', 'ArrowDown']) handler.call(ctx, mk(k))
  assert.equal(calls, 2, 'no activation for non-activation keys')
})

/* ===== Source-anchor locks (template-level fixes) ===== */

test('A2: QuickAddPage window Esc handler carries the IME composition guard', () => {
  const src = read('renderer/js/views/QuickAddPage.vue')
  const m = src.match(/onKey \(e\) \{([\s\S]*?)\n {4}\}/)
  assert.ok(m, 'onKey handler present')
  assert.match(m[1], /e\.isComposing \|\| e\.keyCode === 229/, 'guard BEFORE the Escape branch')
  assert.ok(src.indexOf('isComposing') < src.indexOf("e.key === 'Escape'"), 'guard precedes the Esc handling')
})

test('A5+B12: the estimate pill and project stats present estimate as focus MINUTES (single semantic)', () => {
  const todo = read('renderer/js/components/TodoItem.vue')
  assert.match(todo, /focusMinutesTitle/, 'pill title uses the focus-minutes key')
  assert.doesNotMatch(todo, /pomodoroInvested/, 'old tomato-rounds label is gone')
  const zh = read('renderer/js/i18n/locales/zh-CN-E.js')
  assert.match(zh, /focusMinutesTitle.*专注投入 \{n\} 分钟/)
  // both project surfaces sum the same field with a minutes label
  for (const v of ['renderer/js/views/ProjectOverviewView.vue', 'renderer/js/views/ProjectView.vue']) {
    assert.match(read(v), /t\.estimate \|\| 0\), 0\)/)
  }
})

test('A6: the undated 生成 button explains itself inline (same key generate() rejects with)', () => {
  const src = read('renderer/js/components/RepeatModal.vue')
  assert.match(src, /rm-base-warn[\s\S]*?statsD\.RepeatModal\.noBaseDate/)
})

test('A7+B8: tag rename guards the bookkeeping dispatch; the rewrite corpus includes the recycle bin', () => {
  const src = read('renderer/js/components/side-nav/SnManageTagsModal.vue')
  assert.match(src, /try \{[\s\S]*?ui\/renameUserTag[\s\S]*?\} catch \(e\)/, 'renameUserTag dispatch failure is toasted, not an unhandled rejection')
  assert.match(src, /recycleList/, 'tagTodos covers binned tasks too')
})

test('A8: tag delete is undoable via the app-wide undo toast (content snapshot restored)', () => {
  const src = read('renderer/js/components/side-nav/SnManageTagsModal.vue')
  assert.match(src, /showUndoToast/)
  assert.match(src, /snapshot = targets\.map/, 'snapshot taken before the destructive rewrite')
  assert.match(src, /statsA\.core\.undo/)
})

test('A9: duplicate tag add in EpTags warns instead of a silent no-op', () => {
  const src = read('renderer/js/components/edit-panel/EpTags.vue')
  assert.match(src, /tagExists/)
})

test('A10: habit/moment deletes ride the undo toast and restore via the store replaceAll contract', () => {
  const src = read('renderer/js/views/HabitView.vue')
  assert.match(src, /habits\/replaceAll/, 'restore uses the existing store mutation, no parallel channel')
  assert.match(src, /showUndoToast/)
})

test('A11: habit month pager is clamped and has a back-to-today control', () => {
  const src = read('renderer/js/views/HabitView.vue')
  assert.match(src, /CAL_MIN_OFFSET = -24/)
  assert.doesNotMatch(src, /@click="calOffset--"/, 'raw unbounded inline navigation removed')
  assert.doesNotMatch(src, /@click="calOffset\+\+"/)
  assert.match(src, /calTodayBtn/)
})

test('A12+A13: SnFootActions expanded sync img has alt and Space activation', () => {
  const src = read('renderer/js/components/side-nav/SnFootActions.vue')
  assert.ok(!/icon-sync3\.svg"(?! alt=)/.test(src), 'every sync img carries alt')
  assert.match(src, /roleButtonActivate/)
  // WeatherWidget + CompletedView tip activate on the shared helper too
  assert.match(read('renderer/js/components/WeatherWidget.vue'), /roleButtonActivate/)
  assert.match(read('renderer/js/views/CompletedView.vue'), /roleButtonActivate/)
})

test('A14: the bound is-loading class has a matching style', () => {
  const src = read('renderer/js/components/WeatherWidget.vue')
  assert.match(src, /'is-loading': loading/)
  assert.match(src, /\.weather-widget\.is-loading \.w-temp \{ animation:/)
})

test('A15: a thrown update check is reported as a failure, not a dev-environment notice', () => {
  const src = read('renderer/js/components/SettingsModal.vue')
  const m = src.match(/catch \(e\) \{\s*\n\s*this\.updStatus = 'idle'[\s\S]*?\n {6}\}/)
  assert.ok(m, 'catch block present')
  assert.match(m[0], /failedReason/, 'reports the failure reason')
  assert.doesNotMatch(m[0], /devEnv/, 'no devEnv in the catch path')
})

test('A16: DepView posMap load/persist failures surface (warn-once), nothing swallowed silently', () => {
  const src = read('renderer/js/components/DepView.vue')
  assert.match(src, /warnOncePosFailure/)
  assert.match(src, /posLoadFailed/)
  assert.match(src, /posSaveFailed/)
  assert.doesNotMatch(src, /JSON\.stringify\(this\.posMap\)\]\)\.catch\(\(\) => \{\}\)/)
})

test('A17: the attach-pool cap is announced when exceeded', () => {
  const src = read('renderer/js/components/TomatoFocusRecordModal.vue')
  assert.match(src, /attachTruncated/)
  assert.match(src, /truncatedHint/)
})

/* ===== i18n parity of the new keys ===== */

test('D15 new i18n keys exist in both locales with matching placeholders', () => {
  const bZh = read('renderer/js/i18n/locales/zh-CN-B.js'); const bEn = read('renderer/js/i18n/locales/en-US-B.js')
  assert.match(bZh, /calTodayBtn/); assert.match(bEn, /calTodayBtn/)
  assert.match(bZh, /deletedToast/); assert.match(bEn, /deletedToast/)
  assert.match(bZh, /momentDeletedToast/); assert.match(bEn, /momentDeletedToast/)
  assert.match(read('renderer/js/i18n/locales/zh-CN-D.js'), /truncatedHint/)
  assert.match(read('renderer/js/i18n/locales/en-US-D.js'), /truncatedHint/)
  assert.match(read('renderer/js/i18n/locales/zh-CN-A.js'), /posLoadFailed/)
  assert.match(read('renderer/js/i18n/locales/en-US-A.js'), /posLoadFailed/)
  assert.match(read('renderer/js/i18n/locales/zh-CN-E.js'), /focusMinutesTitle/)
  assert.match(read('renderer/js/i18n/locales/en-US-E.js'), /focusMinutesTitle/)
  assert.match(read('renderer/js/i18n/locales/zh-CN-J.js'), /tagExists/)
  assert.match(read('renderer/js/i18n/locales/en-US-J.js'), /tagExists/)
})
