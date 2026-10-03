/**
 * D4 views-and-core-interaction round (2026-10-02) — behavior regression batch.
 *
 * Covers:
 *  1. EpSubtasks inline rename IME guard: the Enter that ends a pinyin composition
 *     (keydown, isComposing / keyCode 229) used to commit the half-converted pinyin
 *     because commitRename was bound directly to @keydown.enter with no guard — the
 *     exact gap its sibling onSubEnter already guarded. Fix: onRenameEnter guard.
 *  2. QuickAdd multi-line paste: a pasted newline-separated list used to fold into
 *     ONE space-joined task (plain <input> strips newlines, no paste handler). Fix:
 *     @paste intercepts multi-line clipboard text and creates one task per line.
 *  3. TodoItem arrow-key list navigation: plain ArrowUp/ArrowDown now moves focus
 *     between rows (roving focus) instead of doing nothing; the pure neighbor lookup
 *     lives in utils/taskRow.js neighborInList.
 *  4. CalendarView first-paint trim: fcEvents falls back to today's cursor when
 *     cursorTs is not yet set, so the very first month-grid render no longer hands
 *     FullCalendar the whole corpus (source-shape assertion).
 *
 * SFC <script> blocks are loaded with the same extract+strip convention as
 * tomato-abandon-modal-ime.test.mjs; QuickAdd's imports are provided via a deps bag.
 *
 * Run: node --test tests/unit/components/d4-views-interaction-round.test.mjs
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
const read = p => fs.readFileSync(p, 'utf8')
const EP_SFC = path.join(ROOT, 'renderer/js/components/edit-panel/EpSubtasks.vue')
const QA_SFC = path.join(ROOT, 'renderer/js/components/QuickAdd.vue')
const TI_SFC = path.join(ROOT, 'renderer/js/components/TodoItem.vue')
const CAL_SFC = path.join(ROOT, 'renderer/js/views/CalendarView.vue')

let cleanupGlobals = () => {}

function loadScript (sfcPath, deps) {
  const src = read(sfcPath)
  const m = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  assert.ok(m, sfcPath + ': <script> block not found')
  const code = m[1]
    .replace(/^\s*import\s+[^]+?$/gm, '') // strip every import line; deps bag provides them
    .replace(/\bas\s+any\b/g, '')
    .replace(/:\s*any(?=[\s,)\]=;])/g, '') // TS param/var annotations (`payload: any =`) in lang="ts" SFCs
    .replace(/export\s+default\s*\{/, 'return {')
  const names = Object.keys(deps)
  const prelude = names.map(n => `const ${n} = deps[${JSON.stringify(n)}]`).join('\n')
  return new Function('deps', prelude + '\n' + code)(deps)
}

before(() => {
  const { JSDOM } = require('jsdom')
  const g = globalThis
  // carry over the setup.mjs shims (window.dayjs / pinyinPro / VueI18n) into the jsdom window
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
    for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'CustomEvent', 'KeyboardEvent']) {
      try { delete g[k] } catch { Object.defineProperty(g, k, { value: undefined, configurable: true }) }
    }
    dom.window.close()
  }
})

after(() => { cleanupGlobals() })

function mount (Comp, storeStub) {
  const Vue = require('vue')
  const app = Vue.createApp(Comp)
  const props = {
    $t: (key, params) => key + (params ? ':' + JSON.stringify(params) : ''),
    $announce: () => {},
    $message: { success () {}, error () {}, warning () {} },
    $route: { name: 'today', params: {} }
  }
  for (const [k, v] of Object.entries(props)) app.config.globalProperties[k] = v
  if (storeStub) app.provide('store', storeStub) // components read this.$store via globalProperties
  app.config.globalProperties.$store = storeStub
  const host = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(host)
  const vm = app.mount(host)
  return vm
}

function makeStore (dispatchLog) {
  return {
    state: { todo: { todoList: [] }, settings: {}, ui: {} },
    getters: {},
    dispatch (type, payload) {
      dispatchLog.push([type, payload])
      return Promise.resolve({ taskId: 'x' + dispatchLog.length })
    },
    commit () {}
  }
}

/** jsdom KeyboardEvent with isComposing/keyCode patched on (jsdom's init does not carry them) */
function keyEvt ({ isComposing, keyCode }) {
  const ev = new globalThis.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
  Object.defineProperty(ev, 'isComposing', { value: isComposing })
  Object.defineProperty(ev, 'keyCode', { value: keyCode })
  return ev
}

/* ---- 1. EpSubtasks rename IME guard ---- */

function mountEpSubs (emitted) {
  const Vue = require('vue')
  const Comp = loadScript(EP_SFC, {})
  // Parent-listener mount: onRename lands as a real emits listener (Vue 3 root vm proxies
  // reject overwriting $emit directly, so we capture the emit from the parent side).
  const app = Vue.createApp({
    render () {
      return Vue.h(Comp, {
        subs: [{ _key: 'k1', text: 'old text', checked: false }],
        onRename: (...a) => emitted.push(a),
        ref: 'child'
      })
    }
  })
  app.config.globalProperties.$t = k => k
  const host = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(host)
  const root = app.mount(host)
  return root.$refs.child
}

test('subtask rename: IME composition Enter (229 / isComposing) does NOT commit the rename', () => {
  const emitted = []
  const vm = mountEpSubs(emitted)
  vm.renameIndex = 0
  vm.renameText = 'half-typed pin'
  vm.onRenameEnter(0, keyEvt({ isComposing: true, keyCode: 229 }))
  vm.onRenameEnter(0, keyEvt({ isComposing: false, keyCode: 229 }))
  vm.onRenameEnter(0, keyEvt({ isComposing: true, keyCode: 13 }))
  assert.equal(emitted.length, 0,
    'the Enter ending a pinyin composition must not emit rename with half-converted pinyin')
  assert.equal(vm.renameIndex, 0, 'editor stays open during composition')
})

test('subtask rename: a plain (non-IME) Enter still commits the rename', () => {
  const emitted = []
  const vm = mountEpSubs(emitted)
  vm.renameIndex = 0
  vm.renameText = 'renamed text'
  vm.onRenameEnter(0, keyEvt({ isComposing: false, keyCode: 13 }))
  assert.equal(emitted.length, 1, 'plain Enter emits rename exactly once')
  assert.deepEqual(emitted[0], [0, 'renamed text'])
})

test('subtask rename: template binds the guarded handler (wiring check)', () => {
  const src = read(EP_SFC)
  assert.match(src, /@keydown\.enter\.prevent\.stop="onRenameEnter\(i, \$event\)"/,
    'rename input must bind onRenameEnter (the guarded handler), not commitRename directly')
})

/* ---- 2. QuickAdd multi-line paste ---- */

const PASTE_TEXT = 'buy milk\nwalk dog\r\ncall alice'

function makePasteEvent (text) {
  const calls = { prevented: 0 }
  return {
    calls,
    clipboardData: { getData: () => text },
    preventDefault () { calls.prevented++ }
  }
}

async function mountQuickAdd (dispatchLog) {
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
    roleButtonActivate: rbk.roleButtonActivate // [A9] date-chip key handler now uses the shared factory
  })
  const vm = mount(Comp, makeStore(dispatchLog))
  return vm
}

test('quick-add: multi-line paste creates one task per line and clears the draft', async () => {
  const dispatchLog = []
  const vm = await mountQuickAdd(dispatchLog)
  const ev = makePasteEvent(PASTE_TEXT)
  await vm.onPaste(ev)
  assert.equal(ev.calls.prevented, 1, 'native (fold-into-one-input) paste must be intercepted')
  assert.equal(dispatchLog.length, 3, 'one addTodo per pasted line, not one joined task')
  assert.deepEqual(dispatchLog.map(d => d[1].todoContent), ['buy milk', 'walk dog', 'call alice'])
  assert.equal(vm.text, '', 'draft is cleared after the bulk create')
})

test('quick-add: multi-line paste keeps the tag-page context on every line', async () => {
  const dispatchLog = []
  const vm = await mountQuickAdd(dispatchLog)
  vm.$route.name = 'todo-list-tag'
  vm.$route.params = { id: 'java' }
  const ev = makePasteEvent('alpha\n#java beta')
  await vm.onPaste(ev)
  assert.deepEqual(dispatchLog.map(d => d[1].todoContent), ['alpha #java', '#java beta'],
    'tag appended when missing; an exact existing tag token is not doubled (word-boundary rule)')
})

test('quick-add: single-line paste keeps native input behavior (no interception)', async () => {
  const dispatchLog = []
  const vm = await mountQuickAdd(dispatchLog)
  const ev = makePasteEvent('just one line')
  await vm.onPaste(ev)
  assert.equal(ev.calls.prevented, 0)
  assert.equal(dispatchLog.length, 0, 'no task is created by a plain paste')
})

test('splitPasteLines: CRLF/CR/LF aware, trims, drops empties', async () => {
  const qap = await import('../../../renderer/js/utils/quickAddPaste.js')
  assert.deepEqual(qap.splitPasteLines('a\r\nb\rc\n\n  d  '), ['a', 'b', 'c', 'd'])
  assert.deepEqual(qap.splitPasteLines('single line'), ['single line'])
  assert.deepEqual(qap.splitPasteLines(''), [])
  assert.deepEqual(qap.splitPasteLines(null), [])
})

/* ---- 3. TodoItem arrow-key roving focus ---- */

test('neighborInList: returns the adjacent row and null at the edges / for a foreign element', async () => {
  const { neighborInList } = await import('../../../renderer/js/utils/taskRow.js')
  const a = { id: 'a' }; const b = { id: 'b' }; const c = { id: 'c' }
  const rows = [a, b, c]
  assert.equal(neighborInList(rows, a, 1), b, 'ArrowDown from the first row lands on the second')
  assert.equal(neighborInList(rows, b, -1), a, 'ArrowUp moves back')
  assert.equal(neighborInList(rows, c, 1), null, 'no wrap-around past the last row')
  assert.equal(neighborInList(rows, a, -1), null, 'no wrap-around before the first row')
  assert.equal(neighborInList(rows, { id: 'zz' }, 1), null, 'an element outside the list has no neighbor')
})

test('todo-item: template binds plain ArrowUp/Down to focusRow and the method uses neighborInList (wiring check)', () => {
  const src = read(TI_SFC)
  assert.match(src, /@keydown\.up\.prevent="focusRow\(-1\)"/)
  assert.match(src, /@keydown\.down\.prevent="focusRow\(1\)"/)
  assert.match(src, /neighborInList\(rows, this\.\$el, dir\)/)
})

/* ---- 4. CalendarView first-paint event trim ---- */

test('calendar: fcEvents falls back to today when cursorTs is not yet set (first paint trim)', () => {
  const src = read(CAL_SFC)
  assert.match(src, /inCursorWindow\(t\.dayStart, this\.cursorTs \|\| today0\(\)\)/,
    'the initial render must not hand FullCalendar the untrimmed whole corpus')
})
