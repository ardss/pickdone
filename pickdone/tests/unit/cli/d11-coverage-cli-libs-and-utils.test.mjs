/* maint/d11 coverage-restore wave: behavior tests for the factory-injected CLI sub-modules and
 * shared utils the d11 rounds touched — cli/lib-subs.cjs (subtask index/keyword resolution +
 * reorder), cli/lib-plan.cjs (chip set/list/remove with day defaults), src/main/window-ref.js
 * (parking + destroyed-window guard), and renderer/js/utils/tomatoEstimate.js (per-task meta
 * write-through, pruning, invalidation).
 * Run: node --test tests/unit/cli/d11-coverage-cli-libs-and-utils.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import '../../setup.mjs'
const require = createRequire(import.meta.url)

class CliError extends Error { constructor (msg, code) { super(msg); this.code = code } }

/* ---------- cli/lib-subs.cjs ---------- */

function makeSubsLib () {
  const task = { taskId: 't1', taskContent: 'task', subtasks: JSON.stringify([{ text: 'alpha', checked: false }, { text: 'beta', checked: true }]) }
  const patched = []
  const lib = require('../../../cli/lib-subs.cjs')({
    resolveTask: () => task,
    liveTasks: () => [task],
    patchTodo: (id, patch, meta) => { patched.push([id, patch, meta]); Object.assign(task, patch); return { ...task } },
    CliError
  })
  return { lib, task, patched }
}

test('lib-subs: parse/normalize, index vs keyword resolution, ambiguity and range errors', () => {
  const { lib, task, patched } = makeSubsLib()
  assert.deepEqual(lib.parseSubs(task).length, 2)
  assert.deepEqual(lib.parseSubs({ subtasks: 'not json' }), [])
  lib.addSubtask('t1', '  gamma  ')
  assert.deepEqual(JSON.parse(patched[0][1].subtasks).map(s => s.text), ['alpha', 'beta', 'gamma'])
  lib.checkSubtask('t1', 'alpha', true)
  assert.equal(JSON.parse(patched[1][1].subtasks)[0].checked, true)
  lib.removeSubtask('t1', '2')
  assert.deepEqual(JSON.parse(patched[2][1].subtasks).map(s => s.text), ['alpha', 'gamma'])
  assert.throws(() => lib.checkSubtask('t1', '99', true), e => e.code === 'SUB_NOT_FOUND')
  assert.throws(() => lib.checkSubtask('t1', 'zzz', true), e => e.code === 'SUB_NOT_FOUND')
  assert.throws(() => lib.addSubtask('t1', '   '), e => e.code === 'EMPTY_CONTENT')
})

test('lib-subs: moveSubtask up/down/top/bottom/to with out-of-range guards', () => {
  const { lib } = makeSubsLib()
  const r = lib.moveSubtask('t1', '2', 'top')
  assert.equal(r.order[0], '1.beta[x]', 'moved row lands on top with its checked marker')
  const down = lib.moveSubtask('t1', '1', 'down')
  assert.ok(down.order[1].includes('beta'), 'down swaps it back one slot')
  assert.throws(() => lib.moveSubtask('t1', '9', 'up'), e => e.code === 'SUB_NOT_FOUND')
  assert.throws(() => lib.moveSubtask('t1', '1', 'sideways'), e => e.code === 'USAGE')
  assert.throws(() => lib.moveSubtask('t1', '1', 'to', '99'), e => e.code === 'SUB_NOT_FOUND')
})

/* ---------- cli/lib-plan.cjs ---------- */

function makePlanLib () {
  const rows = []
  let seq = 1
  const committed = []
  const dayjs = require('dayjs')
  const lib = require('../../../cli/lib-plan.cjs')({
    open: () => ({ call: (op) => op === 'planAll' ? rows.slice() : [] }),
    commit: (entity, verb, payload) => {
      committed.push([entity, verb, payload])
      if (verb === 'putMany') for (const r of payload) rows.push({ id: seq++, ...r })
      if (verb === 'deleteTaskDay') for (let i = rows.length - 1; i >= 0; i--) if (rows[i].taskId === payload.taskId && rows[i].day === payload.day) rows.splice(i, 1)
      if (verb === 'removeIds') for (const id of payload) { const i = rows.findIndex(r => r.id === id); if (i >= 0) rows.splice(i, 1) }
    },
    audit: { record: () => {} },
    CliError,
    dayjs,
    resolveTask: input => ({ taskId: 't1', taskContent: 'task', dayStart: 0, complete: false }),
    liveTasks: () => [{ taskId: 't1', taskContent: 'task', complete: false }],
    parseDate: s => new Date(s).getTime(),
    dayStartOf: ts => +dayjs(ts).startOf('day')
  })
  return { lib, rows, committed }
}

test('lib-plan: set/list/remove chips with duplicate guard, --replace and bad-time usage errors', () => {
  const { lib, rows, committed } = makePlanLib()
  const today = require('dayjs')().format('YYYY-MM-DD')
  const p1 = lib.planSet('t1', '09:00')
  assert.equal(p1.day, today, 'no dayStart, no --date → today')
  assert.deepEqual(p1.chips, ['09:00'])
  assert.throws(() => lib.planSet('t1', '09:00'), e => e.code === 'PLAN_EXISTS', 'same chip twice without --replace refuses')
  assert.throws(() => lib.planSet('t1', '99:99'), e => e.code === 'USAGE')
  lib.planSet('t1', '10:00')
  lib.planSet('t1', '09:00', { replace: true })
  assert.equal(rows.filter(r => r.taskId === 't1').length, 1, '--replace rebuilt the day for the task')
  const listed = lib.planList()
  assert.deepEqual(listed.tasks[0].chips, ['09:00'])
  assert.equal(listed.tasks[0].content, 'task')
  const removed = lib.planRemove('t1', { at: '09:00' })
  assert.equal(removed.removed, 1)
  assert.throws(() => lib.planRemove('t1', {}), e => e.code === 'PLAN_NOT_FOUND', 'no chips left → not found')
  assert.ok(committed.some(c => c[1] === 'putMany'))
})

/* ---------- src/main/window-ref.js ---------- */

test('window-ref: destroyed window resolves to null; parkForTest positions off-screen without a screen module', () => {
  const { setMainWindow, getMainWindow, parkForTest } = require('../../../src/main/window-ref.js')
  setMainWindow(null)
  assert.equal(getMainWindow(), null)
  let destroyed = false
  const win = {
    isDestroyed: () => destroyed,
    showInactive () {},
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    setPosition: (x, y) => { win.pos = [x, y] }
  }
  setMainWindow(win)
  assert.equal(getMainWindow(), win)
  destroyed = true
  assert.equal(getMainWindow(), null, 'destroyed window never leaks to consumers')
  destroyed = false
  parkForTest(win, {})
  assert.ok(win.pos[0] < 0, 'no screen module → parked off-screen left, not minimized')
  parkForTest(null, {})
  parkForTest({ isDestroyed: () => true }, {})
})

/* ---------- renderer/js/utils/tomatoEstimate.js ---------- */

test('tomatoEstimate: set/get round-trip clamps, pruneEstimates drops dead ids, invalidate clears the memo', async () => {
  const est = await import('../../../renderer/js/utils/tomatoEstimate.js')
  globalThis.window.todoAPI = { dbCall: async () => null, onAppQuittingFlush () {} }
  est.setEstimate('e1', 5)
  assert.equal(est.getEstimate('e1'), 5)
  est.setEstimate('e1', 999)
  assert.equal(est.getEstimate('e1'), 20, 'clamped to the shared MAX')
  est.setEstimate('e1', -3)
  assert.equal(est.getEstimate('e1'), 0, 'clamped to 0')
  est.setEstimate('e2', 3)
  est.pruneEstimates(['e2'])
  assert.equal(est.getEstimate('e1'), 0, 'dead id pruned from the LS mirror')
  assert.equal(est.getEstimate('e2'), 3, 'alive id kept')
  est.invalidateEstimateCache()
  await est.ensureEstimate('e2')
  assert.equal(est.getEstimate('e2'), 3)
})
