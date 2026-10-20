/**
 * d-wave UI fixes (2026-10-14, agent F3 组件/视图域) — regression guards.
 * 1. RecycleBinView row keyboard "open edit" passed the KeyboardEvent itself into
 *    openEdit -> ui/openEdit committed a task with taskId: undefined (keyboard users
 *    could never edit a recycled task). Fix: the key handler captures the row task;
 *    openEdit also got a type guard.
 * 2. RecycleBinView pickDate lacked restore()'s _restoringId re-entrancy guard: a
 *    double-fire dispatched restoreFromRecycle twice and double-toasted.
 * 3. QuickAdd quiet mode: a PURE date input ("明天") returned with zero feedback (no
 *    toast, no qa-error). Fix: quiet mode sets failed=true (inline qa-error), same
 *    contract as the dispatch-failure paths.
 * 4. QuickAdd multi-line partial failure: the remainder was joined with '\n' into the
 *    single-line input, so the next Enter created one space-folded junk task. Fix: the
 *    remainder is kept in a _pendingLines queue and drained by onEnter via createLines;
 *    a paste landing while a submit is in flight is queued too (native fold prevented).
 * 5. TodayView filter chips (li[tabindex] with @keydown.enter) had no role, so the
 *    app-wide main.js Space-activation contract skipped them. Fix: role="button".
 *
 * SFC <script> blocks are loaded with the extract+strip convention from
 * d4-views-interaction-round.test.mjs.
 * Run: node --test tests/unit/components/d-wave-ui-20261014.test.mjs
 */
import '../../setup.mjs'
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const RB_SFC = path.join(ROOT, 'renderer/js/views/RecycleBinView.vue')
const QA_SFC = path.join(ROOT, 'renderer/js/components/QuickAdd.vue')
const TODAY_SRC = read('renderer/js/views/TodayView.vue')

let cleanupGlobals = () => {}

function loadScript (sfcPath, deps) {
  const src = fs.readFileSync(sfcPath, 'utf8')
  const m = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  assert.ok(m, sfcPath + ': <script> block not found')
  const code = m[1]
    .replace(/^\s*import\s+[^]+?$/gm, '')
    .replace(/\bas\s+any\b/g, '')
    .replace(/:\s*any(?=[\s,)\]=;])/g, '')
    .replace(/export\s+default\s*\{/, 'return {')
  const names = Object.keys(deps)
  const prelude = names.map(n => `const ${n} = deps[${JSON.stringify(n)}]`).join('\n')
  return new Function('deps', prelude + '\n' + code)(deps)
}

before(() => {
  const { JSDOM } = require('jsdom')
  const g = globalThis
  const prev = g.window || {}
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const w = dom.window
  for (const k of ['dayjs', 'pinyinPro', 'VueI18n', 'localStorage']) {
    if (prev[k] != null) { try { w[k] = prev[k] } catch { /* read-only on the dom window */ } }
  }
  const setGlobal = (k, v) => {
    try { g[k] = v } catch { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }) }
  }
  for (const [k, v] of Object.entries({
    window: w, document: w.document, navigator: w.navigator,
    HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node, SVGElement: w.SVGElement,
    CustomEvent: w.CustomEvent, KeyboardEvent: w.KeyboardEvent
  })) setGlobal(k, v)
  cleanupGlobals = () => {
    for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'SVGElement', 'CustomEvent', 'KeyboardEvent']) {
      try { delete g[k] } catch { Object.defineProperty(g, k, { value: undefined, configurable: true }) }
    }
    dom.window.close()
  }
})

after(() => { cleanupGlobals() })

/** jsdom KeyboardEvent (Enter), like d4's keyEvt */
function keyEvt () {
  return new globalThis.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
}

function makeMounter () {
  return function mount (Comp, storeStub, props = {}) {
    const Vue = require('vue')
    const app = Vue.createApp({ render () { return Vue.h(Comp, { ...props, ref: 'child' }) } })
    app.config.globalProperties.$t = (key, params) => key + (params ? ':' + JSON.stringify(params) : '')
    app.config.globalProperties.$announce = () => {}
    app.config.globalProperties.$message = { success () {}, error () {}, warning () {} }
    app.config.globalProperties.$route = { name: 'today', params: {} }
    app.config.globalProperties.$store = storeStub
    const host = globalThis.document.createElement('div')
    globalThis.document.body.appendChild(host)
    const root = app.mount(host)
    return root.$refs.child // the component vm, not the wrapper
  }
}

/* ---- 1. RecycleBinView keyboard edit passes the TASK, not the event ---- */

async function mountRecycleBin (storeStub) {
  const core = await import('../../../renderer/js/utils/core.js')
  const cdm = await import('../../../renderer/js/utils/crossDayMove.js')
  const tb = await import('../../../renderer/js/utils/todayBounds.js')
  const rbk = await import('../../../renderer/js/utils/roleButtonKey.js')
  const Comp = loadScript(RB_SFC, {
    dayjs: core.dayjs,
    FMT: core.FMT,
    crossDayMovePatch: cdm.crossDayMovePatch,
    dayStart: tb.dayStart,
    taskContextMenu: () => {},
    toggleCompleteWithUndo: () => {},
    EmptyState: { name: 'EmptyState', template: '<div/>' },
    roleCheckboxActivate: rbk.roleCheckboxActivate,
    roleButtonActivate: rbk.roleButtonActivate,
  })
  return makeMounter()(Comp, storeStub)
}

test('recycle bin: Enter on a row opens the edit panel with the row TASK (not the KeyboardEvent)', async () => {
  const commits = []
  const store = {
    state: { todo: { views: { recycleBin: [] } } },
    dispatch () { return Promise.resolve() },
    commit (type, payload) { commits.push([type, payload]) }
  }
  const vm = await mountRecycleBin(store)
  const task = { taskId: 5, taskContent: 'recycled thing', complete: false }
  vm.onEditKey(task, keyEvt())
  assert.equal(commits.length, 1, 'exactly one ui/openEdit commit')
  assert.equal(commits[0][0], 'ui/openEdit')
  assert.equal(commits[0][1], task, 'the row task object must reach ui/openEdit, never the key event')
  assert.equal(commits[0][1].taskId, 5)
})

test('recycle bin: openEdit is a no-op on a non-task argument (type guard)', async () => {
  const commits = []
  const store = {
    state: { todo: { views: { recycleBin: [] } } },
    dispatch () { return Promise.resolve() },
    commit (type, payload) { commits.push([type, payload]) }
  }
  const vm = await mountRecycleBin(store)
  vm.openEdit(keyEvt()) // the old bug shape: an event object instead of a task
  vm.openEdit(null)
  vm.openEdit({ taskContent: 'no id' })
  assert.equal(commits.length, 0, 'a task-less argument must never open a broken edit panel')
})

test('recycle bin: template binds the row task into onEditKey (wiring check)', () => {
  const src = fs.readFileSync(RB_SFC, 'utf8')
  assert.match(src, /@keydown="onEditKey\(t, \$event\)"/,
    'the keydown binding must forward the row task, not rely on the event alone')
  assert.match(src, /roleButtonActivate\(\(\) => this\.openEdit\(t\)/,
    'the activation closure must capture the row task')
})

/* ---- 2. RecycleBinView pickDate re-entrancy guard ---- */

test('recycle bin: pickDate double-fire dispatches restoreFromRecycle once (restore() guard parity)', async () => {
  const dispatched = []
  const store = {
    state: { todo: { views: { recycleBin: [] } } },
    dispatch (type, payload) {
      dispatched.push([type, payload])
      return new Promise(resolve => setTimeout(resolve, 0))
    },
    commit () {}
  }
  const vm = await mountRecycleBin(store)
  const t = { taskId: 9, taskContent: 'double dated', dayStart: null }
  const ts = Date.now()
  const p1 = vm.pickDate(t, ts)
  const p2 = vm.pickDate(t, ts) // second fire lands while the first await is in flight
  await Promise.all([p1, p2])
  assert.equal(dispatched.length, 1, 'only one restoreFromRecycle may be dispatched')
  assert.equal(dispatched[0][0], 'todo/restoreFromRecycle')
  assert.equal(vm._restoringId, null, 'the guard is released after completion')
})

/* ---- 3. QuickAdd quiet mode: pure-date input gets inline failure feedback ---- */

async function mountQuickAdd (dispatchStub, props = {}) {
  const nlDate = await import('../../../renderer/js/utils/nlDate.js')
  const core = await import('../../../renderer/js/utils/core.js')
  const qad = await import('../../../renderer/js/utils/quickAddDate.js')
  const qap = await import('../../../renderer/js/utils/quickAddPaste.js')
  const rbk = await import('../../../renderer/js/utils/roleButtonKey.js')
  const elUtil = await import('../../../renderer/js/utils/el.js')
  const Comp = loadScript(QA_SFC, {
    parseNaturalDate: nlDate.parseNaturalDate,
    dayjs: core.dayjs,
    FMT: core.FMT,
    resolveQuickAddDate: qad.resolveQuickAddDate,
    splitPasteLines: qap.splitPasteLines,
    ensureTagSuffix: qap.ensureTagSuffix,
    $elOf: elUtil.$elOf,
    roleButtonActivate: rbk.roleButtonActivate,
    TITLE_MAX: (await import('../../../shared/sanitize-text.mjs')).TEXT_MAX_LEN // [F7 P3] deps bag: loadScript strips QuickAdd imports
  })
  return makeMounter()(Comp, { state: {}, dispatch: dispatchStub, commit () {} }, props)
}

test('quick-add: quiet mode + pure-date input ("明天") sets failed=true instead of silence', async () => {
  const log = []
  const vm = await mountQuickAdd((type, payload) => { log.push([type, payload]); return Promise.resolve() }, { quiet: true })
  vm.text = '明天'
  await vm.onEnter()
  assert.equal(log.length, 0, 'a date-only input must not create a task')
  assert.equal(vm.failed, true, 'quiet mode must surface the refusal inline (qa-error / shake)')
  assert.equal(vm.text, '明天', 'the draft is kept for the retry')
})

/* ---- 4. QuickAdd partial multi-line failure keeps the remainder un-folded ---- */

function makePasteEvent (text) {
  const calls = { prevented: 0 }
  return {
    calls,
    clipboardData: { getData: () => text },
    preventDefault () { calls.prevented++ }
  }
}

const LINES = ['buy milk', 'walk dog', 'call alice']

test('quick-add: 3-line paste failing on line 2 keeps the remainder per-line in _pendingLines; next Enter submits exactly the 2 missing lines', async () => {
  const log = []
  const failNext = true // line 2's dispatch rejects (the retry's dispatches hit log.length 3-4, so they resolve)
  const vm = await mountQuickAdd((type, payload) => {
    log.push([type, payload])
    if (failNext && log.length === 2) return Promise.reject(new Error('ipc down'))
    return Promise.resolve()
  })
  await vm.onPaste(makePasteEvent(LINES.join('\n')))
  assert.equal(log.length, 2, 'lines 1-2 were attempted before the failure')
  assert.deepEqual(vm._pendingLines, ['walk dog', 'call alice'],
    'the unsent remainder must be queued per-line, never space-folded into the draft')
  assert.equal(vm.text, 'walk dog', 'the input shows the FIRST pending line as the visible draft')
  // retry
  await vm.onEnter()
  assert.deepEqual(log.map(l => l[1].todoContent),
    ['buy milk', 'walk dog', 'walk dog', 'call alice'],
    '4 dispatches = 2 initial (line 2 failed) + 2 retries; exactly the 2 missing lines are ' +
    'resubmitted — no space-folded junk task, no duplicate of the succeeded line 1')
  assert.equal(vm._pendingLines, null, 'the queue is drained after success')
  assert.equal(vm.text, '', 'the draft is cleared after the retry succeeds')
})

test('quick-add: a multi-line paste landing while a submit is in flight is queued (native fold prevented)', async () => {
  const log = []
  const vm = await mountQuickAdd((type, payload) => { log.push([type, payload]); return Promise.resolve() })
  vm._submitting = true
  const ev = makePasteEvent('queued a\nqueued b')
  await vm.onPaste(ev)
  assert.equal(ev.calls.prevented, 1, 'the busy paste must be prevented, not folded into the draft')
  assert.deepEqual(vm._pendingLines, ['queued a', 'queued b'])
  assert.equal(log.length, 0, 'nothing is dispatched while busy')
  vm._submitting = false
  await vm.onEnter()
  assert.deepEqual(log.map(l => l[1].todoContent), ['queued a', 'queued b'],
    'the queued lines are drained by the next Enter')
})

/* ---- 5. TodayView filter chips are role=button (Space via the main.js contract) ---- */

test('today view: filter chips carry role="button" so main.js Space activation reaches them', () => {
  assert.match(TODAY_SRC, /<li role="button" :class="\{ on: !projFilter \}"/,
    'the "all" chip must be role=button')
  assert.match(TODAY_SRC, /<li v-for="p in projects" :key="p\.categoryId" role="button"/,
    'the per-project chips must be role=button')
  assert.match(TODAY_SRC, /@keydown\.enter\.prevent="setProjFilter/,
    'Enter activation must stay bound on the chips')
  // no unrole'd focusable filter chips left in the file
  const bare = [...TODAY_SRC.matchAll(/<li(?![^>]*role=)[^>]*tabindex/g)]
  assert.equal(bare.length, 0, 'every focusable li in TodayView must carry a role: ' + bare.map(m => m[0]).join(' | '))
})
