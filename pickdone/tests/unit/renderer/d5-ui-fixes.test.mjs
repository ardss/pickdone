/**
 * D5 UI maintenance round (renderer components/views/main) — regression guards.
 * Pure logic is extracted from the source via [d5-ui-fixes] pure markers;
 * template/CSS/async-flow fixes are locked in as structural source assertions.
 * Run: node --test tests/unit/renderer/d5-ui-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

function pureFns (file, names) {
  const src = read(file)
  const re = /\[d5-ui-fixes\] pure-start[^\n]*\n([\s\S]*?)\n[^\n]*\[d5-ui-fixes\] pure-end/
  const m = src.match(re)
  assert.ok(m, `${file}: pure block markers missing`)
  const fn = new Function(m[1] + `\nreturn { ${names.join(', ')} }`)
  return fn()
}

// Fake day-boundary helper: deterministic days as N * 86400000 (no real calendar needed)
const startOfDay = ts => Math.floor(ts / 86400000) * 86400000
const DAY = 86400000
const at = (n, hours) => n * DAY + hours * 3600000

/* ---------- #4 TodoItem: cross-day drag preserves time-of-day ---------- */

test('TodoItem crossDayMovePatch: time-of-day survives the move, day markers follow', () => {
  const { crossDayMovePatch } = pureFns('renderer/js/components/TodoItem.vue', ['crossDayMovePatch'])
  const newDay = at(10, 0)
  const oldDay = at(9, 0)
  // todoTime 14:30 and reminder 08:00 anchored to the old day -> shift to the new day, same clock time
  const withTime = crossDayMovePatch({ dayStart: oldDay, todoTime: at(9, 14.5), reminderTime: at(9, 8) }, newDay, startOfDay)
  assert.deepEqual(withTime, { dayStart: newDay, todoTime: at(10, 14.5), reminderTime: at(10, 8) }, 'time-of-day preserved on the new day')
  // pure midnight day markers -> follow the new day (DayDeck parity)
  const markers = crossDayMovePatch({ dayStart: oldDay, todoTime: oldDay, reminderTime: oldDay }, newDay, startOfDay)
  assert.deepEqual(markers, { dayStart: newDay, todoTime: newDay, reminderTime: newDay })
  // todoTime on a different day than dayStart -> untouched
  const misaligned = crossDayMovePatch({ dayStart: oldDay, todoTime: at(5, 0) }, newDay, startOfDay)
  assert.deepEqual(misaligned, { dayStart: newDay })
})

test('TodoItem: cross-day drop uses the patch builder and reverts the touched fields only', () => {
  const src = read('renderer/js/components/TodoItem.vue')
  assert.match(src, /crossDayMovePatch\(dragged, newDay, startOf\)/, 'onDrop must build the patch via crossDayMovePatch')
  assert.ok(!/patch: \{ dayStart: newDay, todoTime: newDay \}/.test(src), 'old todoTime=newDay wipe must stay deleted')
  assert.match(src, /if \('todoTime' in patch\) revertPatch\.todoTime = dragged\.todoTime/, 'revert restores only fields the patch touched')
  assert.match(src, /if \('reminderTime' in patch\) revertPatch\.reminderTime = dragged\.reminderTime/, 'revert restores reminderTime when shifted')
})

/* ---------- #14 DayDeck: header count includes the overdue bucket ---------- */

test('DayDeck: count and progress denominator include overdue items', () => {
  const src = read('renderer/js/components/DayDeck.vue')
  assert.match(src, /totalCountOf\(c\) \}\}/, 'header count must use totalCountOf')
  assert.match(src, /totalCountOf\(c\) \? doneOf\(c\) \/ totalCountOf\(c\)/, 'progress bar must use totalCountOf')
  assert.match(src, /totalCountOf \(card\) \{ return card\.all\.length \+ \(card\.overdue \? card\.overdue\.length : 0\) \}/, 'totalCountOf sums all + overdue')
})

/* ---------- #5 TodoBoxView: batch delete aggregates undo into one toast ---------- */

test('TodoBoxView batchDelete: one aggregated batchMoveWithUndo undo toast, closeAll, no per-row deleteWithUndo', () => {
  const src = read('renderer/js/views/TodoBoxView.vue')
  assert.ok(!src.includes("deleteWithUndo(this, this.$store, raw)"), 'per-row deleteWithUndo loop must stay deleted')
  assert.match(src, /import \{ batchMoveWithUndo \} from '\.\.\/utils\/confirm\.js'/, 'batchMoveWithUndo import kept (deleteWithUndo import dropped)')
  const idxCloseAll = src.indexOf('this.$message.closeAll()', src.indexOf('async batchDelete'))
  const idxBatch = src.indexOf('batchMoveWithUndo(this', src.indexOf('async batchDelete'))
  const idxLoop = src.indexOf("dispatch('todo/deleteTodo', raw)", src.indexOf('async batchDelete'))
  assert.ok(idxCloseAll > -1 && idxBatch > -1 && idxLoop > -1, 'batchDelete deletes rows, closes toasts, shows one undo')
  assert.ok(idxLoop < idxCloseAll && idxCloseAll < idxBatch, 'order: delete rows -> closeAll -> single batch undo toast')
  assert.match(src, /msgDeleted/, 'aggregated toast uses the statsC.TodoBox.msgDeleted label')
})

/* ---------- #1/#13 EditPanel: restoreFromBin error path + repeatGroupInfo race ---------- */

test('EditPanel restoreFromBin: await wrapped in try/catch, error toast, item kept in bin', () => {
  const src = read('renderer/js/components/EditPanel.vue')
  const body = src.slice(src.indexOf('async restoreFromBin'), src.indexOf('addSub ('))
  assert.match(body, /try \{[\s\S]*await this\.\$store\.dispatch\('todo\/updateTodoFields'[\s\S]*\} catch \(e\) \{/, 'dispatch is awaited inside try/catch')
  assert.match(body, /statsC\.RecycleBin\.restoreFailedMsg/, 'failure reuses the restore-failed i18n key')
  assert.match(body, /return/, 'failure returns early: success toast + hydrate skipped, item stays in bin')
})

test('EditPanel repeatGroupInfo: stale response discarded when the edited task changed mid-await', () => {
  const src = read('renderer/js/components/EditPanel.vue')
  const body = src.slice(src.indexOf('async repeatGroupInfo'), src.indexOf('close ()'))
  const idCap = body.indexOf('const taskId = this.e.taskId')
  const awaitPos = body.indexOf('await window.todoAPI.dbCall')
  const guard = body.indexOf('this.e.taskId === taskId')
  assert.ok(idCap > -1 && awaitPos > -1 && guard > -1, 'id captured before await, guard after')
  assert.ok(idCap < awaitPos && awaitPos < guard, 'capture -> await -> guarded apply order')
})

/* ---------- #2/#3 RecycleBinView: pickDate await/catch, tabindex watcher ---------- */

test('RecycleBinView pickDate: awaited dispatch, success only on success, error toast on failure', () => {
  const src = read('renderer/js/views/RecycleBinView.vue')
  const body = src.slice(src.indexOf('async pickDate'), src.indexOf('openEdit ('))
  assert.ok(body.includes('async pickDate'), 'pickDate is async')
  assert.match(body, /try \{[\s\S]*await this\.\$store\.dispatch\('todo\/updateTodoFields'[\s\S]*\} catch/, 'dispatch awaited in try/catch')
  const okPos = body.indexOf('restoredToDate')
  const awaitPos = body.indexOf('await this.$store.dispatch')
  const catchPos = body.indexOf('} catch')
  assert.ok(awaitPos < okPos && okPos < catchPos, 'success toast only after a successful await')
  assert.match(body, /restoreFailedMsg/, 'failure shows the restore-failed error toast')
})

test('RecycleBinView: rc-pick tabindex patch runs via watcher on list, not just mounted', () => {
  const src = read('renderer/js/views/RecycleBinView.vue')
  assert.match(src, /pinPickTabindex \(\)/, 'patch extracted into pinPickTabindex method')
  assert.match(src, /watch: \{[\s\S]*list \(\) \{ this\.pinPickTabindex\(\) \}/, 'list watcher reruns the patch for later-rendered rows')
  const mounted = src.slice(src.indexOf('mounted ()'), src.indexOf('watch:'))
  assert.match(mounted, /this\.pinPickTabindex\(\)/, 'mounted calls the same method')
})

/* ---------- #9/#10 QuickAdd: picker clear contract, quiet mode ---------- */

test('QuickAdd onCalPick: picker clear maps to pickedDate = 0 (no date), not null', () => {
  const src = read('renderer/js/components/QuickAdd.vue')
  assert.match(src, /onCalPick \(ts\) \{[\s\S]*this\.pickedDate = ts \|\| 0/, 'clear -> 0 = explicitly no date (chip-clear contract)')
  assert.ok(!/this\.pickedDate = ts \|\| null/.test(src), 'null mapping removed (would re-schedule via NL parse/today)')
})

test('QuickAdd quiet prop gates the success toast; QuickAddPage opts in', () => {
  const qa = read('renderer/js/components/QuickAdd.vue')
  assert.match(qa, /props: \{ quiet: \{ type: Boolean, default: false \} \}/, 'quiet prop declared')
  assert.match(qa, /if \(!this\.quiet\) this\.\$message\.success\(msg\)/, 'toast gated by quiet')
  const page = read('renderer/js/views/QuickAddPage.vue')
  assert.match(page, /<quick-add ref="qa" quiet @created="onCreated"\/>/, 'standalone window passes quiet')
})

/* ---------- #17 main.js: periodic computeViews dispatches have .catch ---------- */

test('main.js: both todo/computeViews dispatches catch rejections', () => {
  const src = read('renderer/js/main.js')
  const hits = src.match(/store\.dispatch\('todo\/computeViews'\)[^\n]*/g) || []
  assert.ok(hits.length >= 2, 'both dispatch sites present')
  for (const h of hits) assert.match(h, /\.catch\(/, `dispatch must carry .catch: ${h}`)
})

/* ---------- #18 RepeatDeleteModal: deleteMeta instead of setMeta('') ---------- */

test('RepeatDeleteModal cleanupOrphanRule: uses deleteMeta', () => {
  const src = read('renderer/js/components/RepeatDeleteModal.vue')
  assert.match(src, /dbCall\('deleteMeta', \['repeatRule:' \+ rid\]\)/, 'orphan rule meta is deleted, not emptied')
  assert.ok(!src.includes("dbCall('setMeta', ['repeatRule:' + rid, ''])"), 'setMeta empty-string tombstone removed')
})

/* ---------- #6/#11/#12/#15/#16 CSS tokens, CSV counts, search sort ---------- */

test('CalendarView: dark override for fc-day-today and lunar text uses token', () => {
  const src = read('renderer/js/views/CalendarView.vue')
  assert.match(src, /html\[data-theme="dark"\] \.cal-fc\.fc \.fc-day-today \{ background: rgba\(147, 160, 245, \.10\); \}/, 'dark today-cell override present')
  assert.match(src, /\.lunar\{margin-left:5px;color:var\(--text-3, #9b9b9b\)/, 'lunar color uses text-3 token')
})

test('TodoGroups: tg-week color uses text-2 token', () => {
  const src = read('renderer/js/components/TodoGroups.vue')
  assert.match(src, /\.tg-week \{ color: var\(--text-2, #5f6368\)/, 'week label uses text-2 token (dark-theme safe)')
})

test('StatisticsView fmtCount: integers print plainly, fractions keep one decimal', () => {
  const { fmtCount } = pureFns('renderer/js/views/StatisticsView.vue', ['fmtCount'])
  assert.equal(fmtCount(12), '12')
  assert.equal(fmtCount(0), '0')
  assert.equal(fmtCount(12.5), '12.5')
  assert.equal(fmtCount(7.25), '7.3')
})

test('SearchView: sort applies regardless of keyword presence', () => {
  const src = read('renderer/js/views/SearchView.vue')
  assert.ok(!src.includes("if (this.q.trim()) list.sort"), 'keyword-gated sort removed')
  assert.match(src, /\n\s*list\.sort\(\(a, b\) => b\.todoTime - a\.todoTime\)/, 'sort runs unconditionally')
})
