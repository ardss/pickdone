/**
 * W32 maintenance round, agent F1 (quick-add pending/draft fixes) — regression guards.
 * Fixes covered:
 *   [F1 P2] QuickAdd.onEnter drain path: a draft typed during the busy window must survive
 *           the queued-lines drain — createLines() unconditionally cleared text/pickedDate
 *           on success, silently dropping the user's not-yet-created draft.
 *   [F2 P2] QuickAddPage: the 250ms auto-hide must not fire while _pendingLines are queued,
 *           and the queue is persisted (quickAddPending) / restored across window destroys.
 *   [F3 P2] QuickAddPage Esc is a FULL cancel: it routes through qa.onCancel() (drops
 *           _pendingLines / pickedDate / failed) before hiding.
 *   [F4 P3] QuickAdd.onEnter toasts the date snapshotted BEFORE the dispatch (pre-loop
 *           snapshot parity with createLines).
 *   [F5 P3] QuickAddPage.restoreDraft resets qa.failed so a re-summon never inherits qa-error.
 *   [F6 P3] app-root.vue: the pd:backup-degraded listener is a named handler removed in
 *           beforeUnmount (was an anonymous listener leaked per mount).
 * Run: node --test tests/unit/renderer/w32-quickadd-pending-fixes.test.mjs
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
const QA_SFC = path.join(ROOT, 'renderer/js/components/QuickAdd.vue')
const QAPAGE_SFC = path.join(ROOT, 'renderer/js/views/QuickAddPage.vue')
const QA_SRC = read('renderer/js/components/QuickAdd.vue').replace(/\r/g, '')
const QAPAGE_SRC = read('renderer/js/views/QuickAddPage.vue').replace(/\r/g, '')
const APPROOT_SRC = read('renderer/js/app-root.vue').replace(/\r/g, '')

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

/** The stripped QuickAdd has no template, so $refs.inp never exists and focusInput's nextTick
 *  calls would reject after the test ends. Focus behavior is not under test here — guard it. */
function shimQuickAdd (Comp) {
  Comp.methods.focusInput = function () {
    const i = this.$refs && this.$refs.inp
    if (i && i.focus) i.focus()
  }
  return Comp
}

before(() => {
  const { JSDOM } = require('jsdom')
  const g = globalThis
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const w = dom.window
  // the jsdom window replaces setup.mjs's plain {} window — re-inject the UMD globals the
  // renderer utils read from window (dayjs/pinyinPro), like d-wave-ui-20261014.test.mjs does
  w.dayjs = require('dayjs')
  w.pinyinPro = require('pinyin-pro')
  const setGlobal = (k, v) => {
    try { g[k] = v } catch { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }) }
  }
  for (const [k, v] of Object.entries({
    window: w, document: w.document, navigator: w.navigator,
    HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node, SVGElement: w.SVGElement,
    CustomEvent: w.CustomEvent, KeyboardEvent: w.KeyboardEvent,
    // the components call bare `localStorage` — expose the jsdom one on globalThis too
    localStorage: w.localStorage
  })) setGlobal(k, v)
  cleanupGlobals = () => {
    for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'SVGElement', 'CustomEvent', 'KeyboardEvent', 'localStorage']) {
      try { delete g[k] } catch { Object.defineProperty(g, k, { value: undefined, configurable: true }) }
    }
    dom.window.close()
  }
})

after(() => { cleanupGlobals() })

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
    TITLE_MAX: (await import('../../../shared/sanitize-text.mjs')).TEXT_MAX_LEN
  })
  shimQuickAdd(Comp)
  const Vue = require('vue')
  const app = Vue.createApp({ render () { return Vue.h(Comp, { ...props, ref: 'child' }) } })
  app.config.globalProperties.$t = (key, params) => key + (params ? ':' + JSON.stringify(params) : '')
  app.config.globalProperties.$announce = () => {}
  app.config.globalProperties.$message = { success () {}, error () {}, warning () {} }
  app.config.globalProperties.$route = { name: 'today', params: {} }
  app.config.globalProperties.$store = { state: {}, dispatch: dispatchStub, commit () {} }
  const host = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(host)
  return app.mount(host).$refs.child
}

async function mountQuickAddPage (todoAPIStub) {
  const nlDate = await import('../../../renderer/js/utils/nlDate.js')
  const core = await import('../../../renderer/js/utils/core.js')
  const qad = await import('../../../renderer/js/utils/quickAddDate.js')
  const qap = await import('../../../renderer/js/utils/quickAddPaste.js')
  const rbk = await import('../../../renderer/js/utils/roleButtonKey.js')
  const elUtil = await import('../../../renderer/js/utils/el.js')
  const qaComp = loadScript(QA_SFC, {
    parseNaturalDate: nlDate.parseNaturalDate,
    dayjs: core.dayjs,
    FMT: core.FMT,
    resolveQuickAddDate: qad.resolveQuickAddDate,
    splitPasteLines: qap.splitPasteLines,
    ensureTagSuffix: qap.ensureTagSuffix,
    $elOf: elUtil.$elOf,
    roleButtonActivate: rbk.roleButtonActivate,
    TITLE_MAX: (await import('../../../shared/sanitize-text.mjs')).TEXT_MAX_LEN
  })
  shimQuickAdd(qaComp)
  const pageComp = loadScript(QAPAGE_SFC, { QuickAdd: qaComp })
  // loadScript yields a template-less component object; reproduce the SFC template
  // (`<quick-add ref="qa" quiet @created="onCreated"/>`) as a render function
  const Vue = require('vue')
  pageComp.render = function () { return Vue.h(qaComp, { ref: 'qa', quiet: true, onCreated: this.onCreated }) }
  const app = Vue.createApp({
    render () { return Vue.h(pageComp, { ref: 'page' }) }
  })
  app.component('quick-add', qaComp)
  app.config.globalProperties.$t = (key, params) => key + (params ? ':' + JSON.stringify(params) : '')
  app.config.globalProperties.$route = { name: '__quick-add', params: {} }
  app.config.globalProperties.$router = { push () { return Promise.resolve() } }
  globalThis.window.todoAPI = todoAPIStub
  const host = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(host)
  return app.mount(host).$refs.page
}

const freshLocalStorage = () => {
  globalThis.window.localStorage.clear()
}

/* ---------- [F1] drain path keeps the busy-window draft ---------- */

test('[F1] onEnter drain: a draft typed during the busy window survives createLines clearing', async () => {
  freshLocalStorage()
  const dispatched = []
  let resolveFirst
  const vm = await mountQuickAdd((type, payload) => {
    dispatched.push(payload.todoContent)
    if (dispatched.length === 1) return new Promise(r => { resolveFirst = r }) // lines drain slowly
    return Promise.resolve()
  })
  // busy-window state: a multi-line paste queued while a submit was in flight, plus a draft
  // and a picked date the user typed/picked while waiting
  vm._pendingLines = ['line-a', 'line-b']
  vm.text = 'typed during busy'
  vm.pickedDate = 1700000000000
  const p = vm.onEnter()
  assert.equal(dispatched.length, 1, 'the first queued line is dispatched; the draft submit is deferred')
  assert.equal(dispatched[0], 'line-a')
  assert.equal(vm.text, 'typed during busy', 'draft intact while the queue drains')
  resolveFirst()
  await p
  assert.deepEqual(dispatched, ['line-a', 'line-b'], 'both queued lines created')
  assert.equal(vm.text, 'typed during busy', 'the busy-window draft must be restored, not silently dropped')
  assert.equal(vm.pickedDate, 1700000000000, 'the date picked for the draft is restored too')
  assert.equal(vm._pendingLines, null, 'the queue is fully drained')
})

test('[F1] onEnter drain: no phantom restore when the user had typed nothing', async () => {
  freshLocalStorage()
  const dispatched = []
  const vm = await mountQuickAdd((type, payload) => {
    dispatched.push(payload.todoContent)
    return Promise.resolve()
  })
  vm._pendingLines = ['only-queue']
  await vm.onEnter()
  assert.deepEqual(dispatched, ['only-queue'])
  assert.equal(vm.text, '', 'no phantom text restored when the draft was empty')
  assert.equal(vm.pickedDate, null, 'pickedDate stays cleared after a plain drain')
})

test('[F1] onEnter drain: the seeded queue-head mirror is NOT restored as a draft (d-wave parity)', async () => {
  freshLocalStorage()
  const dispatched = []
  const failOn = n => n === 2 // second dispatch ever rejects
  let n = 0
  const vm = await mountQuickAdd((type, payload) => {
    n++
    dispatched.push(payload.todoContent)
    return failOn(n) ? Promise.reject(new Error('ipc down')) : Promise.resolve()
  })
  await vm.onPaste({ clipboardData: { getData: () => 'buy milk\nwalk dog\ncall alice' }, preventDefault () {} })
  assert.equal(vm.text, 'walk dog', 'the queue-head mirror is seeded as the visible draft')
  await vm.onEnter() // retry drains the remaining 2 lines
  assert.deepEqual(dispatched, ['buy milk', 'walk dog', 'walk dog', 'call alice'])
  assert.equal(vm.text, '', 'the seeded mirror must be cleared, not restored as a phantom draft')
})

/* ---------- [F2] page: auto-hide waits for the queue; queue persists across destroys ---------- */

const apiStub = (hides) => ({
  onQuickAddFocus: cb => { /* no focus push in the test */ return () => {} },
  quickAddHide: () => { hides.push(1) }
})

test('[F2] page: the 250ms auto-hide is skipped while _pendingLines are queued', async () => {
  freshLocalStorage()
  const hides = []
  const page = await mountQuickAddPage(apiStub(hides))
  const qa = page.$refs.qa
  qa._pendingLines = ['queued-1']
  page.onCreated()
  assert.ok(page._hideTimer, 'hide timer armed')
  await new Promise(r => setTimeout(r, 320))
  assert.equal(hides.length, 0, 'window must NOT hide while queued lines await their Enter drain')
  // cleanup: drain and let a plain onCreated hide
  qa._pendingLines = null
  page.onCreated()
  await new Promise(r => setTimeout(r, 320))
  assert.equal(hides.length, 1, 'with the queue empty the auto-hide proceeds')
})

test('[F2] page: persistDraft writes and restoreDraft restores the quickAddPending queue', async () => {
  freshLocalStorage()
  const page = await mountQuickAddPage(apiStub([]))
  const qa = page.$refs.qa
  qa._pendingLines = [{ content: 'q1' }, { content: 'q2' }]
  qa.text = 'draft-x'
  page.persistDraft()
  assert.equal(globalThis.window.localStorage.getItem('quickAddPending'), JSON.stringify([{ content: 'q1' }, { content: 'q2' }]),
    'the pending queue is persisted alongside the draft')
  // simulate a fresh window: empty queue, then restore
  qa._pendingLines = null
  qa.text = ''
  page.restoreDraft()
  assert.deepEqual(qa._pendingLines, [{ content: 'q1' }, { content: 'q2' }],
    'a re-mounted window must inherit the queued lines')
  assert.equal(qa.text, 'draft-x', 'the draft still restores as before')
})

test('[F2] page: a drained queue clears the stale quickAddPending key on created', async () => {
  freshLocalStorage()
  const page = await mountQuickAddPage(apiStub([]))
  globalThis.window.localStorage.setItem('quickAddPending', JSON.stringify(['stale']))
  page.onCreated()
  assert.equal(globalThis.window.localStorage.getItem('quickAddPending'), null,
    'onCreated (queue consumed) must not leave a stale queue on disk')
  await new Promise(r => setTimeout(r, 320)) // let the armed hide timer fire before teardown
})

/* ---------- [F3] Esc is a full cancel (queue + date + failed state) ---------- */

test('[F3] page Esc: routes through qa.onCancel so pending/date/failed are dropped, then hides', async () => {
  freshLocalStorage()
  const hides = []
  const page = await mountQuickAddPage(apiStub(hides))
  const qa = page.$refs.qa
  qa._pendingLines = ['user-cancelled-queue']
  qa.text = 'user-cancelled-draft'
  qa.pickedDate = 1700000000000
  qa.failed = true
  const e = new globalThis.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  page.onKey(e)
  assert.equal(qa.text, '', 'draft discarded')
  assert.equal(qa._pendingLines, null, 'queued lines discarded — the cancelled queue must never be created later')
  assert.equal(qa.pickedDate, null, 'date chip discarded')
  assert.equal(qa.failed, false, 'failure mark cleared')
  assert.equal(globalThis.window.localStorage.getItem('quickAddPending'), null, 'persisted queue discarded too')
  assert.equal(hides.length, 1, 'window still hides')
})

/* ---------- [F4] onEnter toasts the pre-dispatch date snapshot ---------- */

test('[F4] onEnter: effDate is snapshotted BEFORE the addTodo dispatch (createLines parity)', () => {
  const fn = QA_SRC.slice(QA_SRC.indexOf('async onEnter ()'))
  const dispatchIdx = fn.indexOf("await this.$store.dispatch('todo/addTodo', payload)")
  const snapIdx = fn.search(/let d = this\.effDate|const d = this\.effDate/)
  assert.ok(snapIdx > -1, 'a d snapshot still exists')
  assert.ok(snapIdx < dispatchIdx,
    'the toast date must be snapshotted before the await, not read as a live computed afterwards')
})

/* ---------- [F5] restoreDraft resets failed ---------- */

test('[F5] page restoreDraft: qa.failed is reset so a re-summon inherits no qa-error', async () => {
  freshLocalStorage()
  const page = await mountQuickAddPage(apiStub([]))
  const qa = page.$refs.qa
  qa.failed = true
  page.restoreDraft()
  assert.equal(qa.failed, false, 'the stale failure mark must not survive a re-summon')
})

/* ---------- [F6] app-root: named backup-degraded handler removed on unmount ---------- */

test('[F6] app-root: pd:backup-degraded uses a named handler removed in beforeUnmount', () => {
  assert.match(APPROOT_SRC, /this\._onBackupDegraded = /, 'the handler is stored on the instance (named, not anonymous)')
  assert.match(APPROOT_SRC, /addEventListener\('pd:backup-degraded', this\._onBackupDegraded\)/)
  assert.match(APPROOT_SRC, /beforeUnmount \(\) \{[\s\S]*?removeEventListener\('pd:backup-degraded', this\._onBackupDegraded\)/,
    'beforeUnmount must remove the exact handler that was added')
  assert.ok(!/addEventListener\('pd:backup-degraded', \(e/.test(APPROOT_SRC), 'no anonymous listener left behind')
})
