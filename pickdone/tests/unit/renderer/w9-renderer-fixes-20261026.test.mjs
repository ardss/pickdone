/**
 * W9 renderer fixes (2026-10-26) — regression tests for the parallel w9-renderer session.
 *
 * Covered:
 *   W9-1  TomatoFloatPage computeds `tasks` / `tasksTruncated` accessed `this.taskPool()`
 *         as a method, but `taskPool` is a computed Array — the ⋮ task menu render threw
 *         "TypeError: this.taskPool is not a function". Behavior test evaluates the real
 *         computed functions with a fake `this`; source contract forbids the call form.
 *   W9-2  RecycleBinView.isOverdue compared against wall-clock `dayjs()` (non-reactive,
 *         goes stale across midnight). It now compares against the reactive store owner
 *         `todo.todayTimestamp` (store maintains it via setTodayTs); day-granular `<`
 *         semantics unchanged. Behavior test proves the read happens off the store state.
 *
 * Run: node --test tests/unit/renderer/w9-renderer-fixes-20261026.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

const FLOAT = read('renderer/js/views/TomatoFloatPage.vue')
const RECYCLE = read('renderer/js/views/RecycleBinView.vue')

/* Extract a computed/method function body from a .vue <script> by name, e.g. "tasks () { ... }"
   or "isOverdue (t) { ... }" — paren params between name and braces */
const fnSource = (src, name) => {
  const start = src.indexOf(name + ' (')
  assert.ok(start >= 0, `${name} (… must exist in the component source`)
  const open = src.indexOf('{', start)
  let depth = 0
  for (let i = open; i < src.length; i++) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') { depth--; if (depth === 0) return src.slice(open + 1, i) }
  }
  assert.fail(`${name} body not balanced`)
}

test('W9-1 TomatoFloatPage tasks/tasksTruncated read taskPool as a property, not a call', () => {
  for (const name of ['tasks', 'tasksTruncated']) {
    const body = fnSource(FLOAT, name)
    assert.doesNotMatch(body, /this\.taskPool\s*\(/,
      `${name} must not invoke taskPool as a function — it is a computed Array, calling it threw TypeError in the ⋮ menu render`)
    assert.match(body, /this\.taskPool(?!\s*\()/, `${name} must access this.taskPool as a property`)
  }
})

test('W9-1 behavior: fixed computeds evaluate against a real computed-style `this`', () => {
  // Evaluate the actual computed bodies (Options API `this` bound by call) — the same
  // expressions that used to throw "this.taskPool is not a function".
  const pool = Array.from({ length: 35 }, (_, i) => ({ taskId: 't' + i }))
  const ctx = { taskPool: pool }
  const tasks = new Function(`return function () { ${fnSource(FLOAT, 'tasks')} }`)().call(ctx)
  const truncated = new Function(`return function () { ${fnSource(FLOAT, 'tasksTruncated')} }`)().call(ctx)
  assert.equal(tasks.length, 30, 'render cap stays at 30 items')
  assert.deepEqual(tasks[0], { taskId: 't0' })
  assert.deepEqual(tasks[29], { taskId: 't29' })
  assert.equal(truncated, true, '35-item pool marks the truncation notice')
  const small = { taskPool: pool.slice(0, 5) }
  assert.equal(new Function(`return function () { ${fnSource(FLOAT, 'tasksTruncated')} }`)().call(small), false)
  assert.equal(new Function(`return function () { ${fnSource(FLOAT, 'tasks')} }`)().call(small).length, 5)
})

test('W9-2 RecycleBinView.isOverdue compares against the reactive store todayTimestamp', () => {
  const body = fnSource(RECYCLE, 'isOverdue')
  assert.match(body, /this\.\$store\.state\.todo\.todayTimestamp/,
    'isOverdue must seed "today" from the reactive store owner so midnight rolls forward')
  assert.doesNotMatch(body, /<\s*dayjs\(\)/,
    'no wall-clock dayjs() on the comparison side — that cached value went stale across midnight')
})

test('W9-2 behavior: isOverdue uses store todayTimestamp with unchanged day-granular semantics', () => {
  const body = fnSource(RECYCLE, 'isOverdue')
  const isOverdue = new Function('dayjs', `return function (t) { ${body} }`)(d => ({
    startOf: () => ({ valueOf: () => d })
  }))
  const store = { state: { todo: { todayTimestamp: 1000 } } }
  const ctx = { $store: store }
  assert.equal(isOverdue.call(ctx, { dayStart: 500 }), true, 'earlier day is overdue')
  assert.ok(!isOverdue.call(ctx, { dayStart: 1000 }), 'today is not overdue')
  assert.ok(!isOverdue.call(ctx, { dayStart: 2000 }), 'future day is not overdue')
  assert.ok(!isOverdue.call(ctx, { dayStart: 0 }), 'undated rows are never overdue (falsy short-circuit)')
  // same function, later store owner: an overdue row flips when the store rolls midnight
  store.state.todo.todayTimestamp = 3000
  assert.equal(isOverdue.call(ctx, { dayStart: 2000 }), true, 'reactive owner drives the verdict, not wall clock')
})
