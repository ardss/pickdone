/**
 * W26 renderer fixes — layout.vue orphan outside-click listener + leftovers markAsked ordering.
 *
 * Fix 3 (P3): layout.vue's `editVisible` watcher scheduled a 0ms setTimeout to attach the
 * document mousedown listener. Fast open→close left the close branch's removeEventListener a
 * no-op (not yet attached) while the timer still fired and mounted the listener — an orphan
 * that stayed forever (only cleaned on unmount). Now the close branch clears the pending timer
 * AND the attach callback re-checks `editVisible` before attaching.
 *
 * Fix 4 (P3): maybeAskLeftovers wrote the asked flag (LS + meta) BEFORE the move dispatch loop.
 * A dispatch throwing mid-loop was swallowed by the outer catch → yesterday's batch was neither
 * moved nor asked about again that day. The flag is now written only after the loop succeeds.
 *
 * Run: node --test tests/unit/renderer/w26-layout-timer-leftovers-flag.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

/* ===================== Fix 3: layout.vue attach timer ===================== */

const LAYOUT_SRC = readFileSync(path.join(ROOT, 'renderer/js/layout.vue'), 'utf8')

/** Build a driveable watcher: evaluates the REAL $watch callback body from layout.vue against a
 *  fake `this` + instrumented document/setTimeout/clearTimeout. */
function makeLayoutWatcher () {
  const m = LAYOUT_SRC.match(/this\.\$watch\('editVisible', \(v\) => \{([\s\S]*?)\n {4}\},\s*\{ immediate: true \}\)/)
  assert.ok(m, 'editVisible $watch callback not found in layout.vue')
  const state = { editVisible: true, attached: 0, detached: 0, cleared: [] }
  const pending = [] // pending timer callbacks
  const host = {
    get editVisible () { return state.editVisible },
    _attachTimer: null,
    _onDocClick () {}
  }
  const fakeSetTimeout = (fn) => { pending.push(fn); return pending.length }
  const fakeClearTimeout = (id) => { state.cleared.push(id); pending.length = 0 }
  const fakeDoc = { addEventListener: () => { state.attached++ }, removeEventListener: () => { state.detached++ } }
  // eslint-disable-next-line no-new-func
  const cb = new Function('v', 'setTimeout', 'clearTimeout', 'document', `'use strict';\n${m[1]}`)
  const fire = (val) => cb.call(host, val, fakeSetTimeout, fakeClearTimeout, fakeDoc)
  return {
    state, fire,
    runPendingTimer () { assert.ok(pending.length, 'no pending timer'); const fns = pending.splice(0); for (const f of fns) f() },
    pendingTimers () { return pending.length }
  }
}

test('w26 fix3: 秒开秒关 — close 分支 clearTimeout,孤儿 mousedown 监听不再被挂上', () => {
  const w = makeLayoutWatcher()
  w.fire(true) // open: schedules the 0ms attach timer
  assert.equal(w.pendingTimers(), 1, 'the attach timer is pending')
  w.state.editVisible = false
  w.fire(false) // close BEFORE the timer fires
  assert.equal(w.pendingTimers(), 0, 'the pending attach timer was cleared (was: fired later and leaked)')
  assert.ok(w.state.cleared.length >= 1, 'clearTimeout was invoked by the close branch')
  // the cleared timer never runs; even if it DID fire late (old-bug simulation), the callback must not attach
  const late = makeLayoutWatcher()
  late.fire(true)
  late.state.editVisible = false
  late.runPendingTimer() // timer fired despite the close (worst case)
  assert.equal(late.state.attached, 0, 'the attach callback re-checks editVisible and refuses to attach')
})

test('w26 fix3: 正常打开路径不受影响 — 定时器到点且面板仍可见时监听照常挂上', () => {
  const w = makeLayoutWatcher()
  w.fire(true)
  w.runPendingTimer() // panel still open at timer fire
  assert.equal(w.state.attached, 1, 'the outside-click listener is attached as before')
  w.state.editVisible = false
  w.fire(false)
  assert.equal(w.state.detached >= 1, true, 'the normal close still detaches')
})

/* ===================== Fix 4: leftovers.js markAsked ordering ===================== */

async function makeLeftoversHarness ({ failOnTaskId }) {
  const { maybeAskLeftovers } = await import(pathToFileURL(path.join(ROOT, 'renderer/js/utils/leftovers.js')).href)
  const { dayjs } = await import(pathToFileURL(path.join(ROOT, 'renderer/js/utils/core.js')).href)
  const today = +dayjs().startOf('day')
  const yesterday = today - 86400000
  const t1 = { taskId: 't1', taskContent: 'one', delete: false, complete: false, repeatId: null, dayStart: yesterday, todoTime: yesterday + 3600000 }
  const t2 = { taskId: 't2', taskContent: 'two', delete: false, complete: false, repeatId: null, dayStart: yesterday, todoTime: yesterday + 7200000 }
  const metaWrites = []
  const dispatches = []
  const store = {
    state: { todo: { todoList: [t1, t2] } },
    dispatch (type, payload) {
      dispatches.push([type, payload])
      if (type === 'todo/updateTodoFields') {
        if (payload.taskId === failOnTaskId) return Promise.reject(new Error('simulated dispatch failure'))
        return Promise.resolve()
      }
      return Promise.resolve()
    }
  }
  globalThis.window.appUI = {
    $confirm: async () => {}, // user picks "move to today"
    $message: Object.assign(() => {}, { success () {}, error () {}, closeAll () {} })
  }
  const prevAPI = globalThis.window.todoAPI
  globalThis.window.todoAPI = {
    dbCall: async (op, args) => {
      if (op === 'getMeta') return null // not asked yet
      if (op === 'setMeta') metaWrites.push(args)
      return null
    }
  }
  const prevLS = globalThis.localStorage
  const ls = {}
  globalThis.localStorage = { getItem: k => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v) } }
  try { await maybeAskLeftovers(store) } catch (e) { assert.fail('outer catch must swallow: ' + e.message) }
  globalThis.window.todoAPI = prevAPI
  globalThis.localStorage = prevLS
  return { metaWrites, dispatches, today }
}

test('w26 fix4: 搬移循环中 dispatch 抛错 — 不写 asked 标记(明天仍会询问)', async () => {
  const h = await makeLeftoversHarness({ failOnTaskId: 't2' })
  assert.equal(h.dispatches.filter(d => d[0] === 'todo/updateTodoFields').length >= 1, true, 'the first move attempt happened')
  assert.equal(h.metaWrites.length, 0, 'setMeta(leftoverAskDate) is NOT written when the move loop fails')
})

test('w26 fix4: 搬移全部成功 — asked 标记在搬移之后照常写入(行为不回归)', async () => {
  const h = await makeLeftoversHarness({ failOnTaskId: null })
  const moves = h.dispatches.filter(d => d[0] === 'todo/updateTodoFields')
  assert.equal(moves.length, 2, 'both tasks were dispatched')
  assert.equal(h.metaWrites.length, 1, 'setMeta(leftoverAskDate) written exactly once after success')
  assert.equal(h.metaWrites[0][1], dayjsStr(h.today), 'flag value is today YYYY-MM-DD')
  function dayjsStr (day0) {
    const d = new Date(day0)
    const p = n => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  }
})
