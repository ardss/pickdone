/**
 * perf-toggle-complete-dep-scan-per-toggle — regression test.
 *
 * Root cause: toggleComplete's dependent-unlock scan re-parsed every row's predecessors in the
 * filter (N parses) AND re-parsed + rebuilt an O(N) byId map per candidate dependent inside
 * isTaskReady (D more parses). At 300 rows / 40 dependents that was ~340 parsePredecessors
 * invocations per single toggle.
 *
 * Fix: one O(N) pass builds the parsed-predecessor cache + byId map once; isTaskReady consumes
 * them via its new optional `pre` argument (2-arg signature unchanged for other callers).
 *
 * The counter: predecessors are seeded as JSON strings, so every parsePredecessors call on a row
 * goes through JSON.parse (the ONLY other JSON.parse in the action is the subtasks cascade, which
 * stays inert here by seeding subtasks as arrays). Baseline = parses for a no-dependency toggle.
 *
 * Red before the fix (~342 parses for a 300/40 fixture), green after (302).
 * Run: node --test tests/unit/store/domainA-toggle-dep-scan.test.mjs
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const mkDayjs = ts => {
  const t = ts == null ? Date.now() : ts
  const o = {
    format: f => f === 'YYYY-MM-DD' ? '2026-10-02' : String(t),
    valueOf: () => t,
    startOf: u => u === 'day' ? mkDayjs(0) : o,
    add: () => o, subtract: () => o, isSame: () => false,
    hour: () => ({ minute: () => ({ second: () => ({ valueOf: () => t }) }) })
  }
  return o
}
globalThis.dayjs = mkDayjs
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
try { globalThis.navigator = { language: 'zh-CN' } } catch { /* Node >=21 read-only */ }
globalThis.window = {
  location: { hash: '' },
  dayjs: mkDayjs,
  todoAPI: {
    dbCall: () => Promise.resolve(null),
    writeCriticalStateBackup: () => Promise.resolve()
  }
}

const todoMod = await import('../../../renderer/js/store/todo.js')
const todoActions = todoMod.default.actions

const N = 300
const D = 40 // rows 0..D-1 depend on the toggled row
const ROOT_ID = 'root'
const rowOf = (taskId, preds) => ({
  taskId,
  taskContent: 'content-' + taskId,
  delete: false,
  complete: false,
  dayStart: 0,
  todoTime: 0,
  updateTime: 1,
  status: 'update',
  subtasks: [], // array: the subtask cascade still JSON.parses it — but through parseSubtasks? no: JSON.parse(todo.subtasks || '[]') needs a string. Absent field → '[]' literal, same cost either way.
  predecessors: JSON.stringify(preds)
})

function buildState () {
  const todoList = [rowOf(ROOT_ID, [])]
  for (let i = 0; i < N - 1; i++) {
    todoList.push(rowOf('t' + i, i < D ? [ROOT_ID] : []))
  }
  return { todoList }
}

let parseCount = 0
const origParse = JSON.parse
function countParsesOn (fn) {
  JSON.parse = function (...a) { parseCount++; return origParse.apply(JSON, a) }
  return Promise.resolve().then(fn).finally(() => { JSON.parse = origParse })
}

let capturedPatch = null
const mkCtx = state => ({
  state,
  commit: () => {},
  dispatch: async (type, payload) => {
    if (type === 'updateTodoFields') capturedPatch = payload.patch
    return {}
  },
  rootState: { settings: {} }
})

beforeEach(() => { capturedPatch = null })

test('toggleComplete dep scan: exactly one parse per row (zero re-parses), unlock set preserved', async () => {
  const state = buildState()

  // Baseline: the same toggle with the dependent rows NOT depending on root — isolates the
  // dependency-scan cost from the action's fixed subtask-parse cost.
  const stateNoDeps = buildState()
  for (const t of stateNoDeps.todoList) if (t.taskId !== ROOT_ID) t.predecessors = '[]'
  await countParsesOn(() => todoActions.toggleComplete.call({}, mkCtx(stateNoDeps), stateNoDeps.todoList[0]))
  const baseline = parseCount
  parseCount = 0

  await countParsesOn(() => todoActions.toggleComplete.call({}, mkCtx(state), state.todoList[0]))
  const withDeps = parseCount
  parseCount = 0

  // The dep scan itself must add ZERO extra parses over the baseline: every parse of a row's
  // predecessors happens exactly once in the shared pass. Before the fix the D dependent rows
  // were re-parsed inside isTaskReady (baseline + D here).
  assert.equal(withDeps, baseline,
    `dependency scan must not re-parse (baseline=${baseline}, withDeps=${withDeps})`)

  // Behavior parity with the pre-fix output: the scan runs BEFORE the toggle is applied, so the
  // just-toggled predecessor still reads complete:false in the live list and readiness fails —
  // the pre-fix code produced an empty unlock set for this fixture, and the rewrite must be
  // byte-identical (the fixPlan demands fixture parity, not a semantics change).
  assert.ok(capturedPatch, 'updateTodoFields must be dispatched')
  assert.equal(capturedPatch._unlocked, undefined, 'output must be identical to the pre-fix scan (empty unlock set)')
  assert.equal(capturedPatch.complete, true)
})

test('isTaskReady keeps its 2-arg signature and semantics (no `pre` given)', async () => {
  const { isTaskReady } = await import('../../../renderer/js/utils/deps.js')
  const done = { taskId: 'a', delete: false, complete: true, predecessors: '[]' }
  const pend = { taskId: 'b', delete: false, complete: false, predecessors: '[]' }
  const t = { taskId: 't', delete: false, predecessors: '["a","b"]' }
  assert.equal(isTaskReady([done, pend, t], t), false, 'incomplete predecessor blocks readiness')
  assert.equal(isTaskReady([done, t], t), true, 'all-complete predecessors unlock')
  const t2 = { taskId: 't2', delete: false, predecessors: '["ghost"]' }
  assert.equal(isTaskReady([done, t2], t2), true, 'missing predecessor row counts ready (existing semantics)')
})
