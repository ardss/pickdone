/**
 * W25 maintenance round (renderer) — three fixes:
 *   [P2] taskMenu.js manual-backfill tomatoId: salted tail — two same-duration backfills of the
 *        SAME task in the same minute (legit: after midnight the startTs clamp pins both to
 *        00:00) used to mint identical ids and tomatoAppendMany's ON CONFLICT silently
 *        overwrote the first ledger row (third entry point; DayRail/TaskAccountModal already
 *        salted the same way).
 *   [P2] sortMode.js 'difficulty': retired difficulty column → migrated to the same
 *        estimated-workload caliber as todoComputeViews.js (getEstimate, higher first).
 *   [P3] SearchView.vue matchTasks: startOf('day') cut had no reactive dependency — page left
 *        mounted across midnight froze the last7/last30 windows. Now a `tick` counter bumped
 *        by a day-flip watch, read via `void this.tick` (same pattern as TodayXView.settledTotal).
 *
 * Run: node --test tests/unit/renderer/w25-fixes-taskmenu-salt-sortmode-searchview.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

// core.js reads the UMD global (window.dayjs); inject before importing renderer utils
// (same recipe as maint-0925-domain1.test.mjs)
const dayjsMod = await import('dayjs')
const dayjs = dayjsMod.default
globalThis.dayjs = dayjs

// ---- env mocks (must exist before any renderer module is imported; same recipe as
//      dw2-taskmenu-copy-guard.test.mjs — no electron required) ----
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
globalThis.window = { location: { hash: '' }, todoAPI: {} }

/* ---------- [P2-1] taskMenu backfill salt ---------- */

test('[w25] backfill: two same-duration mints in the same minute yield DISTINCT tomatoIds', async () => {
  const { buildTaskMenu } = await import('../../../renderer/js/utils/taskMenu.js')
  const task = { taskId: 'taskX', taskContent: 'dup-min backfill' }
  const commits = []
  const makeVm = () => ({
    $t: k => k,
    $store: {
      state: { todo: { todoList: [task] } },
      commit (mut, payload) { if (mut === 'tomato/addRecord') commits.push(payload) },
      dispatch () {}
    },
    $message: { success () {}, warning () {}, error () {} },
    // the menu's manual-backfill path goes through $prompt(25) then backfill(n)
    $prompt: () => Promise.resolve({ value: '25' })
  })

  const vm = makeVm()
  const manual = buildTaskMenu(vm, task).find(i => i.icon === 'plus')
  assert.ok(manual, 'manual-backfill item present (icon plus)')
  await manual.fn()
  await manual.fn() // same minute (test speed) + same duration + same task → old id collided here
  assert.equal(commits.length, 2, 'both backfills produced a ledger record')
  assert.notEqual(commits[0].tomatoId, commits[1].tomatoId,
    'salted tail: same-minute same-duration same-task backfills no longer collide (ON CONFLICT can no longer eat the first row)')
  assert.ok(commits[0].tomatoId.startsWith('tmt_m_'), 'id keeps the tmt_m_ family prefix')
})

test('[w25] taskMenu source anchor: the salted backfill id no longer ends at the raw taskId', () => {
  const src = read('renderer/js/utils/taskMenu.js')
  assert.ok(!src.includes("'tmt_m_' + startTs + '_' + min2 + '_' + String(cur.taskId || 'free'),"),
    'the unsalted id literal is gone')
  assert.ok(/tmt_m_' \+ startTs \+ '_' \+ min2 \+ '_' \+ String\(cur\.taskId \|\| 'free'\) \+ Math\.random\(\)\.toString\(36\)\.slice\(2, 7\)/.test(src),
    'backfill id carries the Math.random salt tail (same family as DayRail/TaskAccountModal)')
})

/* ---------- [P2-2] sortMode difficulty → estimated workload ---------- */

test('[w25] difficulty mode sorts by estimated tomatoes (descending), not the retired difficulty column', async () => {
  const { sortByMode } = await import('../../../renderer/js/utils/sortMode.js')
  const { _testInternals } = await import('../../../renderer/js/utils/tomatoEstimate.js')
  // seed the shared estimate cache directly (getEstimate reads this state; setEstimate would touch main-process IPC)
  _testInternals.state['a'] = 1
  _testInternals.state['b'] = 5
  const rows = [
    { taskId: 'x', difficulty: 99, createTime: 1 }, // retired column: used to win before the migration
    { taskId: 'b', createTime: 2 },                 // estimate 5
    { taskId: 'a', createTime: 3 },                 // estimate 1
    { taskId: 'z', createTime: 4 }                  // no estimate → 0, last
  ]
  const out = sortByMode(rows, 'difficulty').map(r => r.taskId)
  assert.deepEqual(out, ['b', 'a', 'x', 'z'],
    'difficulty mode now orders by estimated workload descending; unset estimates fall last')
  const src = read('renderer/js/utils/sortMode.js')
  assert.ok(!src.includes('b.difficulty'), 'the retired difficulty column read is gone')
  assert.ok(src.includes('getEstimate'), 'comparator uses the shared getEstimate source')
})

/* ---------- [P3-3] SearchView midnight reactivity ---------- */

test('[w25] SearchView: day-flip tick invalidates the matchTasks window cut (source shape; component has heavy el-select deps)', () => {
  const src = read('renderer/js/views/SearchView.vue')
  // the tick counter is declared reactive, read by the computed chain, and bumped on day flip
  assert.ok(/return \{ qText: '', tick: 0/.test(src), 'tick counter lives in data (reactive)')
  assert.ok(/matchTasks \(\) \{\s*void this\.tick/.test(src),
    'matchTasks reads the tick (same `void this.tick` wall-clock pattern as TodayXView.settledTotal)')
  assert.ok(/setInterval/.test(src) && /format\('YYYY-MM-DD'\)/.test(src),
    'a day-flip watcher exists (setInterval comparing the day-key string — not a new inline startOf-day site, per the day-caliber ratchet)')
  assert.ok(/d !== this\._lastSeenDay[\s\S]{0,60}this\.tick\+\+/.test(src),
    'tick only bumps when the calendar day actually changes (cheap, no 1s re-sort churn)')
  assert.ok(src.includes('clearInterval(this._dayCheckTimer)'), 'the watcher is torn down on unmount')
})
