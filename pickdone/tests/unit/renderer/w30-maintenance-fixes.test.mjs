/**
 * W30 maintenance wave — regression guards (8 items, feat/w29-maintenance).
 *
 *   [1] P2 nlDate mixed CJK+Latin branch: the +1-day roll for an already-past explicit time now
 *       carries an explicitYear gate (same semantics the English branch got in W29) —
 *       "2025年1月1日 3pm" stays on the user's literal pinned date.
 *   [2] P2 onboardingTours: driver construction/drive throwing no longer leaves the whole app
 *       shell permanently inert — the synchronous section is guarded and inert is released.
 *   [3] P3 filters.remove fallback filter compares ids loosely (String()) — number row id vs
 *       string route param no longer forks.
 *   [4] P3 leftovers: the post-batch computeViews dispatch carries a .catch — a view-rebuild
 *       failure does not blow up (unhandled rejection) after the move has already landed.
 *   [5] P3 CLI one-shot tomato minutes: startFocus silently aborting (cross-window phase guard)
 *       restores __cliTomatoPrevMinutes immediately (no CLI stop will ever arrive).
 *   [6] P3 editSave: a null current taskId no longer drains dirty flags it cannot dispatch —
 *       the batch survives for the next queueSave/flush.
 *   [7] P3 side-nav projectWarn reads the reactive store-owned todayTimestamp instead of a bare
 *       non-reactive Date.now().
 *   [8] P3 metrics: streak walks back from the INJECTED nowTick (KPI window caliber), and
 *       windowCounts normalizes NaN dayStart onto the todoTime-derived bucket.
 *
 * Run: node --test tests/unit/renderer/w30-maintenance-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const importMod = p => import(pathToFileURL(path.join(ROOT, p)).href)

/* ---------- [1] nlDate mixed CJK+Latin explicit-year gate ---------- */

test('[1a] mixed input with a PINNED full date + past time keeps the literal date (no +1 day, no year change)', async () => {
  const { dayjs } = await importMod('renderer/js/utils/core.js')
  const { parseNaturalDate } = await importMod('renderer/js/utils/nlDate.js')
  const base = dayjs('2026-06-01T16:00:00') // late afternoon: 3pm already passed
  const r = parseNaturalDate('2025年1月1日 3pm', base)
  assert.equal(r.date.format('YYYY-MM-DD'), '2025-01-01', 'pinned historical date must not move')
  assert.equal(r.date.hour(), 15, 'the explicit 3pm still lands on the pinned date')
  assert.match(r.label, /15:00/)
})

test('[1b] mixed input with an IMPLICIT date + past time still rolls one day forward (gate does not over-block)', async () => {
  const { dayjs } = await importMod('renderer/js/utils/core.js')
  const { parseNaturalDate } = await importMod('renderer/js/utils/nlDate.js')
  const base = dayjs('2026-06-01T16:00:00')
  const r = parseNaturalDate('今天 3pm', base)
  assert.equal(r.date.format('YYYY-MM-DD HH:mm'), '2026-06-02 15:00', 'no year pinned: corrective roll still applies')
})

test('[1c] source anchor: the mixed branch guards the roll with explicitYear like the English branch', () => {
  const src = read('renderer/js/utils/nlDate.js')
  assert.match(src, /!explicitYear && withTime\.isBefore\(base\)/)
  // the English branch's W29 gate is untouched (read-only reference)
  assert.match(src, /!explicitYear && d\.isBefore\(base\)/)
})

/* ---------- [2] onboardingTours inert try-guard ---------- */

function fakeAppRoot () {
  const ops = []
  return { ops, setAttribute: (k, v) => ops.push(['set', k, v]), removeAttribute: (k) => ops.push(['remove', k]) }
}
/* runTour auto-skips steps whose element is missing — every selector must "exist" */
const docWithSteps = (root) => { globalThis.document = { getElementById: () => root, querySelector: () => ({}) } }

test('[2a] driver construction throwing releases inert (app stays clickable)', async () => {
  const root = fakeAppRoot()
  docWithSteps(root)
  globalThis.window = globalThis.window || {}; globalThis.window.driver = { js: { driver: () => { throw new Error('driver.js blew up') } } }
  globalThis.localStorage.removeItem('onboardingToursSeen')
  const tours = await importMod('renderer/js/utils/onboardingTours.js')
  const ok = tours.runTour('today', true)
  assert.equal(ok, false, 'the tour reports failure instead of propagating')
  assert.deepEqual(root.ops.some(o => o[0] === 'remove' && o[1] === 'inert'), true, 'inert MUST be released on the failure path')
  // not marked seen → a later entry can retry
  assert.equal(JSON.parse(globalThis.localStorage.getItem('onboardingToursSeen') || '{}').today, undefined)
})

test('[2b] a healthy tour still releases inert only via onDestroy (guard does not change the happy path)', async () => {
  const root = fakeAppRoot()
  let destroyCb = null
  docWithSteps(root)
  globalThis.window = globalThis.window || {}; globalThis.window.driver = { js: { driver: (cfg) => { destroyCb = cfg.onDestroy; return { drive () {} } } } }
  globalThis.localStorage.removeItem('onboardingToursSeen')
  const tours = await importMod('renderer/js/utils/onboardingTours.js')
  const ok = tours.runTour('today', true)
  assert.equal(ok, true)
  assert.ok(!root.ops.some(o => o[0] === 'remove'), 'no premature release while the tour runs')
  destroyCb() // user finishes/closes the tour
  assert.ok(root.ops.some(o => o[0] === 'remove' && o[1] === 'inert'), 'onDestroy still releases')
})

/* ---------- [3] filters.remove fallback loose id compare ---------- */

test('[3] remove refetch failure keeps the optimistic removal even with a number id vs string arg', async () => {
  const mod = await importMod('renderer/js/store/filters.js')
  const filters = mod.default
  let committed = null
  const commit = (m, list) => { if (m === 'setList') committed = list }
  const state = { list: [{ id: 5, name: 'a' }, { id: 6, name: 'b' }] }
  globalThis.window = globalThis.window || {}; globalThis.window.todoAPI = Object.assign(globalThis.window.todoAPI || {}, {
    dbCall: async (op) => { if (op === 'filterList') throw new Error('refetch down') }
  })
  await filters.actions.remove({ commit, state }, '5') // route-param STRING vs number row id
  assert.deepEqual(committed.map(f => f.id), [6], 'strict !== would have kept id 5 (type fork)')
})

/* ---------- [4] leftovers computeViews .catch ---------- */

test('[4] a rejecting computeViews after the batch move does not surface an unhandled rejection and the undo snapshot still builds', async () => {
  const { maybeAskLeftovers } = await importMod('renderer/js/utils/leftovers.js')
  const { dayjs } = await importMod('renderer/js/utils/core.js')
  const yStart = +dayjs().subtract(1, 'day').startOf('day')
  const dispatched = []
  const store = {
    state: { todo: { todoList: [{ taskId: 't1', complete: false, delete: false, dayStart: yStart, todoTime: yStart + 3600000, taskContent: 'x' }] } },
    dispatch: async (action, payload) => {
      dispatched.push(action)
      if (action === 'todo/computeViews') throw new Error('view rebuild failed')
      return undefined
    }
  }
  globalThis.window = globalThis.window || {}; globalThis.window.todoAPI = Object.assign(globalThis.window.todoAPI || {}, {
    dbCall: async (op, ...a) => { if (op === 'getMeta') return null; return undefined } // setMeta etc. resolve
  })
  globalThis.window = globalThis.window || {}; globalThis.window.appUI = { $confirm: () => Promise.resolve(), $message: null } // batchMoveWithUndo no-ops without $message
  const todayStr = dayjs().format('YYYY-MM-DD')
  await maybeAskLeftovers(store) // must resolve, not reject / unhandled-reject
  assert.ok(dispatched.includes('todo/updateTodoFields'), 'the move itself dispatched')
  assert.ok(dispatched.includes('todo/computeViews'), 'the view rebuild was attempted')
  assert.equal(globalThis.localStorage.getItem('leftoverAskDate'), todayStr, 'the ask-once flag was written past the failure point')
})

/* ---------- [5] CLI one-shot minutes restored when startFocus silently aborts ---------- */

test('[5] main.js restores __cliTomatoPrevMinutes when startFocus aborted (no CLI stop will arrive)', () => {
  const src = read('renderer/js/main.js')
  // the phase-verification guard sits right after the awaited startFocus: success path attaches,
  // abort path restores the one-shot minutes inline (kept single-line: main.js sits at the 800-line
  // structural gate) and skips the attach (nothing to attach to)
  assert.match(src, /await store\.dispatch\('tomato\/startFocus'\)\s*\n\s*if \(store\.state\.tomato\.status === 'startTomatoTime'\) \{ if \(cmd\.taskId\) await store\.dispatch\('tomato\/attach', cmd\.taskId\) \} else if \(window\.__cliTomatoPrevMinutes > 0\) \{ store\.commit\('tomato\/patch', \{ tomatoTime: window\.__cliTomatoPrevMinutes \}\); window\.__cliTomatoPrevMinutes = 0 \}/)
})

/* ---------- [6] editSave: null taskId must not drain undeliverable dirty flags ---------- */

test('[6] flushSave with a null current task keeps the dirty flags for the next opportunity', async () => {
  const { createSaveQueue } = await importMod('renderer/js/utils/editSave.js')
  const written = []
  let currentId = null
  const queue = createSaveQueue(
    { dispatch: async (a, p) => { written.push(p) } },
    { getTaskId: () => currentId, dirtyPatchFor: k => ({ [k]: ['frag-' + k] }), debounceMs: 1 }
  )
  queue.boot()
  queue.markDirty('subtasks')
  await queue.flushSave()
  assert.equal(written.length, 0, 'nothing dispatched while there is no task to write to')
  // the flags must have SURVIVED the null-task flush: once a task exists again the very next
  // flush delivers them (takeDirty itself drains, so re-flush is the observable proof)
  currentId = 't9'
  await queue.flushSave()
  assert.deepEqual(written, [{ taskId: 't9', patch: { subtasks: ['frag-subtasks'] } }])
})

test('[6b] queueSave debounce callback likewise skips the drain when taskId is null', async () => {
  const { createSaveQueue } = await importMod('renderer/js/utils/editSave.js')
  const written = []
  const queue = createSaveQueue(
    { dispatch: async (a, p) => { written.push(p) } },
    { getTaskId: () => null, dirtyPatchFor: k => ({ [k]: ['v-' + k] }), debounceMs: 1 }
  )
  queue.boot()
  queue.markDirty('imgs')
  queue.queueSave({})
  await new Promise(r => setTimeout(r, 20))
  assert.equal(written.length, 0)
  assert.deepEqual(queue.takeDirty('imgs'), { imgs: ['v-imgs'] }, 'flags survive the null-task debounce fire')
})

/* ---------- [7] projectWarn reads the reactive todayTimestamp ---------- */

test('[7] projectWarn uses store.todo.todayTimestamp (reactive owner), not a bare Date.now()', async () => {
  const handlers = await importMod('renderer/js/components/side-nav/sideNavHandlers.js')
  const NOW = 1760000000000
  const meta = {
    a: { deadline: NOW + 3 * 86400000 }, // within 7 days of the STORE clock
    b: { deadline: NOW + 30 * 86400000 }, // far out
    c: { nextMilestone: { date: NOW - 86400000 } } // overdue = also warned
  }
  const vm = { $store: { state: { category: { projectMeta: meta }, todo: { todayTimestamp: NOW } } } }
  assert.equal(handlers.projectWarn(vm), 2)
  const src = read('renderer/js/components/side-nav/sideNavHandlers.js')
  assert.match(src, /todayTimestamp\) \|\| Date\.now\(\)/, 'the computed now carries the reactive store dependency')
})

/* ---------- [8] metrics nowTick streak + NaN dayStart normalization ---------- */

test('[8a] streak walks back from the INJECTED nowTick, not the wall clock', async () => {
  const { buildReviewMetrics } = await importMod('renderer/js/views/statistics/metrics.js')
  const { dayjs } = await importMod('renderer/js/utils/core.js')
  const nowTick = +dayjs('2026-03-10T14:00:00') // deliberately far from the real wall clock
  const done = (d) => ({ taskId: 't' + d, complete: true, delete: false, completedAt: +dayjs('2026-03-' + String(d).padStart(2, '0') + 'T10:00:00') })
  const m = buildReviewMetrics({ todos: [done(8), done(9), done(10)], records: [], catNameOf: () => 'c' }, { start: +dayjs('2026-03-04'), end: nowTick, label: 'x' }, nowTick)
  assert.equal(m.streak, 3, 'with the wall clock (months later) this streak would read 0')
})

test('[8b] windowCounts normalizes a NaN dayStart onto the todoTime-derived bucket', async () => {
  const { windowCounts } = await importMod('renderer/js/views/statistics/metrics.js')
  const { dayjs } = await importMod('renderer/js/utils/core.js')
  const start = +dayjs('2026-03-01T00:00:00')
  const end = +dayjs('2026-03-10T00:00:00')
  const rows = [
    { taskId: 'a', delete: false, complete: false, dayStart: NaN, todoTime: +dayjs('2026-03-02T09:00:00') }, // corrupted dayStart
    { taskId: 'b', delete: false, complete: true, dayStart: NaN, todoTime: 0 } // no salvageable date → bucket 0 (outside window)
  ]
  const w = windowCounts(rows, [], () => 'c', start, end)
  assert.equal(w.planned, 1, 'NaN dayStart previously escaped both the window check and the fallback')
})
