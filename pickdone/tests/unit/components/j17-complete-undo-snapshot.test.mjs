/**
 * [J17 2026-10-22] toggleCompleteWithUndo's 撤销 must restore the EXACT pre-toggle snapshot —
 * not blindly re-toggle. RED-first pin (lead disposition on the round-2 P3 design flag).
 *
 * Live finding (j13): in a child-driven auto-complete the toast's undo dispatched toggleComplete
 * AGAIN; with isCompleteWithSubtasks ON the re-toggle's uncheck cascade wiped BOTH child checks
 * — the user watched themselves check 子一+子二, one undo → 0/2. The system must only undo what
 * THE SYSTEM did (the completion flip + its cascade); the user's own earlier writes survive
 * (J10 snapshot doctrine).
 *
 * Flow note: toggleCompleteWithUndo IS the completion entry — it performs the toggle itself and
 * returns the dispatch promise. Each scenario: seed the pre-toggle state → call it → await p →
 * invoke the captured undo → assert the exact pre-toggle state is restored.
 *
 * Run: node --test tests/unit/components/j17-complete-undo-snapshot.test.mjs
 */
import '../../setup.mjs'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

let cleanupGlobals = () => {}
let toggleCompleteWithUndo

before(async () => {
  const { JSDOM } = require('jsdom')
  const g = globalThis
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const w = dom.window
  const Vue = require('vue')
  w.Vue = Vue // showUndoToast needs window.Vue.h
  const setGlobal = (k, v) => {
    try { g[k] = v } catch { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }) }
  }
  for (const [k, v] of Object.entries({ window: w, document: w.document, navigator: w.navigator })) setGlobal(k, v)
  cleanupGlobals = () => {
    for (const k of ['window', 'document', 'navigator']) {
      try { delete g[k] } catch { Object.defineProperty(g, k, { value: undefined, configurable: true }) }
    }
    dom.window.close()
  }
  ;({ toggleCompleteWithUndo } = await import('../../../renderer/js/utils/completeAction.js'))
})
after(() => { cleanupGlobals() })

/** Store stub whose toggleComplete mirrors the REAL action semantics (completion flip +
 *  completedAt + isCompleteWithSubtasks cascade) with in-place row mutation (upsertLocal shape). */
function makeStore (cascadeOn) {
  const row = {
    taskId: 't1', taskContent: '母舰', complete: false, completedAt: 0,
    subtasks: JSON.stringify([{ text: '子一', checked: false }, { text: '子二', checked: false }]),
    delete: false, dayStart: 0, categoryId: 0
  }
  const state = { todo: { todoList: [row], recycleList: [] } }
  const store = {
    state,
    dispatch (type, payload) {
      if (type === 'todo/toggleComplete') {
        const target = !payload.complete
        payload.complete = target
        payload.completedAt = target ? 99999 : 0
        if (cascadeOn) {
          const subs = JSON.parse(payload.subtasks || '[]')
          for (const s of subs) s.checked = target
          payload.subtasks = JSON.stringify(subs)
        }
        return Promise.resolve(payload)
      }
      if (type === 'todo/updateTodoFields') {
        Object.assign(row, payload.patch)
        return Promise.resolve(row)
      }
      return Promise.resolve(null)
    }
  }
  return { row, store }
}

const messageStub = () => {
  const m = (...a) => {}
  m.success = () => {}
  m.error = () => {}
  m.closeAll = () => {}
  return m
}

/** Run the completion entry and capture the undo closure from the toast children. */
async function runAndCaptureUndo ({ row, store }) {
  let undoFn = null
  const origH = globalThis.window.Vue.h
  globalThis.window.Vue = {
    h: (tag, props, children) => {
      if (tag === 'a' && props && props.onClick) { undoFn = props.onClick; return origH(tag, props, children) }
      return origH(tag, props, children)
    }
  }
  try {
    const p = toggleCompleteWithUndo({ store, message: messageStub(), todo: row })
    await p // the entry performs the toggle itself — wait for the flip to land
  } finally { globalThis.window.Vue = { h: origH } }
  return undoFn
}

test('j17: undoing a child-driven auto-complete keeps the user\'s own child checks, reverts only the completion', async () => {
  const { row, store } = makeStore(true)
  // by auto-complete time the user has checked BOTH children themselves (子二's write precedes the cascade)
  row.subtasks = JSON.stringify([{ text: '子一', checked: true }, { text: '子二', checked: true }])
  const undo = await runAndCaptureUndo({ row, store })
  assert.equal(row.complete, true, 'the entry completed the parent')
  assert.deepEqual(JSON.parse(row.subtasks).map(s => s.checked), [true, true], 'cascade kept the checked children')
  await undo()
  assert.equal(row.complete, false, 'the system completion is undone')
  assert.deepEqual(JSON.parse(row.subtasks).map(s => s.checked), [true, true],
    "the user's own child checks survive the undo — the old blind re-toggle cascade-unchecked them to [false,false]")
})

test('j17: undoing a parent-driven completion (cascade ON) reverts parent AND cascade exactly', async () => {
  const { row, store } = makeStore(true)
  const undo = await runAndCaptureUndo({ row, store })
  assert.equal(row.complete, true)
  assert.deepEqual(JSON.parse(row.subtasks).map(s => s.checked), [true, true], 'cascade checked the children')
  await undo()
  assert.equal(row.complete, false)
  assert.deepEqual(JSON.parse(row.subtasks).map(s => s.checked), [false, false],
    'the cascade the SYSTEM performed is reverted with it')
})

test('j17: undoing an un-complete (restore direction) restores completion + checked children exactly', async () => {
  const { row, store } = makeStore(true)
  row.complete = true
  row.completedAt = 12345
  row.subtasks = JSON.stringify([{ text: '子一', checked: true }, { text: '子二', checked: true }])
  const undo = await runAndCaptureUndo({ row, store })
  assert.equal(row.complete, false, 'the entry un-completed')
  assert.deepEqual(JSON.parse(row.subtasks).map(s => s.checked), [false, false], 'cascade unchecked')
  await undo()
  assert.equal(row.complete, true, 'restored')
  assert.equal(row.completedAt, 12345, 'the exact pre-toggle completedAt is restored (not a fresh now())')
  assert.deepEqual(JSON.parse(row.subtasks).map(s => s.checked), [true, true])
})

test('j17: undo with the cascade setting OFF still restores the exact pre-toggle values', async () => {
  const { row, store } = makeStore(false)
  row.subtasks = JSON.stringify([{ text: '子一', checked: true }, { text: '子二', checked: false }])
  const undo = await runAndCaptureUndo({ row, store })
  assert.equal(row.complete, true)
  assert.deepEqual(JSON.parse(row.subtasks).map(s => s.checked), [true, false], 'no cascade under setting OFF')
  await undo()
  assert.equal(row.complete, false)
  assert.deepEqual(JSON.parse(row.subtasks).map(s => s.checked), [true, false], 'subtasks untouched by both directions')
})
