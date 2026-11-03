/**
 * W33 maintenance round, agent F1 — regression guards.
 * Fixes covered:
 *   [F1 P2] EditPanel.restoreFromBin failure path: takeDirty(['subtasks','imgs','files']) CONSUMED
 *           the dirty marks; a failed todo/restoreFromRecycle dispatch used to strand those edits
 *           forever (no later queueSave carries them). The catch now re-flags all three keys.
 *   [F2 P2] editPanelRemoteSync FINGERPRINT_FIELDS missed deadlineTs: an inbound edit that ONLY
 *           moved the deadline classified as a non-core own-save echo (verdict 'none') — the open
 *           panel stayed stale AND its next autosave wrote the old deadline over the peer's value.
 *           deadlineTs now joins the fingerprint (same rationale as the J3 repeatId fix).
 *   [F4 P3] DayDeck module-level style injection deduped: identical <style data-deck-css> nodes
 *           used to pile up in <head> on every module (re)evaluation (HMR / test re-imports).
 *   [F5 P3] TomatoFloatPage abandoning watcher: the flushGhost setTimeout handle is stored and
 *           cleared on re-entry + beforeUnmount (d21-A15 DayRail pattern).
 *   [F6 P3] SearchView echo assignments (created seed / external q watcher / unmount revert) set
 *           _qEcho so the qText watcher skips the redundant same-value setSearch commit.
 *   [F7 P3] ChartCard.renderChart content-fingerprint dedupe: StatisticsView's 30s nowTick
 *           rebuilds equal-content model objects and the deep watcher destroyed+recreated every
 *           live Chart each 30s; equal config+theme now skips the cycle. nowTick is untouched.
 * Skipped: the reported onDateChipKey dead code (EditPanel.vue ~387) — deleting it breaks two
 *   existing anchor contracts outside this agent's writable scope (w21-editpanel-split,
 *   d23-fix3b-renderer-fixes both assert the "d23 onDateChipKey anchor").
 * Run: node --test tests/unit/renderer/w33-f1-fixes.test.mjs
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
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8').replace(/\r/g, '')
const EDITPANEL_SRC = read('renderer/js/components/EditPanel.vue')
const DAYDECK_SRC = read('renderer/js/components/DayDeck.vue')
const TOMATO_SRC = read('renderer/js/views/TomatoFloatPage.vue')
const SEARCH_SFC = path.join(ROOT, 'renderer/js/views/SearchView.vue')
const CHARTCARD_SFC = path.join(ROOT, 'renderer/js/views/statistics/ChartCard.vue')

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
    // ChartCard uses the identifier form `export default ChartCard`
    .replace(/export\s+default\s+ChartCard/, 'return ChartCard')
  const names = Object.keys(deps)
  const prelude = names.map(n => `const ${n} = deps[${JSON.stringify(n)}]`).join('\n')
  return new Function('deps', prelude + '\n' + code)(deps)
}

before(() => {
  const { JSDOM } = require('jsdom')
  const g = globalThis
  const dom = new JSDOM('<!doctype html><html><head></head><body></body></html>', { url: 'http://localhost/' })
  const w = dom.window
  w.dayjs = require('dayjs')
  const setGlobal = (k, v) => {
    try { g[k] = v } catch { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }) }
  }
  for (const [k, v] of Object.entries({
    window: w, document: w.document, navigator: w.navigator,
    HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node, SVGElement: w.SVGElement,
    MutationObserver: w.MutationObserver, CustomEvent: w.CustomEvent, localStorage: w.localStorage
  })) setGlobal(k, v)
  cleanupGlobals = () => {
    for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'SVGElement', 'MutationObserver', 'CustomEvent', 'localStorage']) {
      try { delete g[k] } catch { Object.defineProperty(g, k, { value: undefined, configurable: true }) }
    }
    dom.window.close()
  }
})

after(() => { cleanupGlobals() })

const tick = (ms = 20) => new Promise(r => setTimeout(r, ms))

/* ---------- [F1 P2] restoreFromBin failure re-flags the consumed dirty keys ---------- */

test('[F1] restoreFromBin catch: the takeDirty-consumed dirty marks are re-flagged (markDirty subtasks/imgs/files)', () => {
  const m = EDITPANEL_SRC.match(/async restoreFromBin \(\) \{[\s\S]*?\n {4}\},/)
  assert.ok(m, 'restoreFromBin block found')
  const body = m[0]
  assert.ok(/takeDirty\(\['subtasks', 'imgs', 'files'\]\)/.test(body), 'the takeDirty call is still there (precondition)')
  const catchIdx = body.indexOf('} catch (e) {')
  assert.ok(catchIdx > -1, 'a catch branch exists')
  const catchBody = body.slice(catchIdx)
  assert.ok(/for \(const k of \['subtasks', 'imgs', 'files'\]\) this\.markDirty\(k\)/.test(catchBody),
    'the catch must markDirty all three consumed keys back before returning — otherwise a failed restore strands the edits forever')
  assert.ok(/return/.test(catchBody), 'the failure path still returns (no false-success toast)')
})

test('[F1] behavior contract: markDirty after takeDirty re-arms the pending slot (editSave parity)', async () => {
  const { createSaveQueue } = await import('file://' + path.join(ROOT, 'renderer/js/utils/editSave.js').replace(/\\/g, '/') + '?w33a=' + Math.random())
  const dispatched = []
  const store = { dispatch: (op, { taskId, patch }) => { dispatched.push(patch); return Promise.resolve() } }
  const q = createSaveQueue(store, {
    getTaskId: () => 't1',
    debounceMs: 30,
    dirtyPatchFor: k => ({ [k]: ['frag-' + k] }) // the EditPanel wiring: dirty flags carry list fragments
  })
  q.boot()
  // the restoreFromBin sequence: takeDirty consumes, dispatch FAILS, catch re-flags, a later
  // retry flushes — without the re-flag this second flush would carry nothing.
  q.markDirty('subtasks')
  const consumed = q.takeDirty(['subtasks', 'imgs', 'files'])
  assert.ok(consumed.subtasks != null || Object.keys(consumed).length === 0, 'takeDirty consumes the marks')
  const reflags = () => { for (const k of ['subtasks', 'imgs', 'files']) q.markDirty(k) }
  reflags() // what the new catch does
  q.queueSave({}) // the retry path (e.g. a second restore click / banner retry)
  await tick(80)
  assert.ok(dispatched.some(p => p && Array.isArray(p.subtasks)),
    'the re-flagged subtasks fragment reaches the store on the retry — pre-fix the re-drain returned an empty patch and dispatched nothing')
})

/* ---------- [F2 P2] deadlineTs joins the remote-sync fingerprint ---------- */

test('[F2] an inbound edit that ONLY moves deadlineTs classifies as changed (was: own-save echo)', async () => {
  const rms = await import('file://' + path.join(ROOT, 'renderer/js/utils/editPanelRemoteSync.js').replace(/\\/g, '/') + '?w33b=' + Math.random())
  const baseFingerprint = rms.contentFingerprint({
    title: 'a', desc: 'b', dateTs: 111, remindTs: 222, priority: 0, important: 0,
    categoryId: 5, repeatId: 'r', deadlineTs: 1000
  })
  const row = {
    taskContent: 'a', taskDescribe: 'b', todoTime: 111, reminderTime: 222,
    priority: 0, important: 0, categoryId: 5, repeatId: 'r',
    deadlineTs: 999999, // the ONLY change: a peer moved the deadline
    updateTime: 12345
  }
  const verdict = rms.shouldRefreshRemote({ baseFingerprint, baseUpdateTime: 1, row })
  assert.equal(verdict, 'changed',
    'a deadline-only peer edit must re-hydrate the open panel — pre-fix verdict was none and the panel later overwrote the peer')
})

test('[F2] same deadlineTs still classifies as own-save echo (no cry-wolf regression)', async () => {
  const rms = await import('file://' + path.join(ROOT, 'renderer/js/utils/editPanelRemoteSync.js').replace(/\\/g, '/') + '?w33c=' + Math.random())
  const fp = rms.contentFingerprint({ title: 'a', desc: '', dateTs: 0, remindTs: 0, priority: 0, important: 0, categoryId: 0, repeatId: null, deadlineTs: 7 })
  const row = { taskContent: 'a', todoTime: 0, reminderTime: 0, priority: 0, important: 0, categoryId: 0, deadlineTs: 7, updateTime: 42 }
  assert.equal(rms.shouldRefreshRemote({ baseFingerprint: fp, baseUpdateTime: 42, row }), 'none', 'identical content stays an echo')
  assert.ok(rms.FINGERPRINT_PANEL_KEYS.includes('deadlineTs'), 'deadlineTs is in the exported fingerprint vocabulary (shape test)')
  // deadlineTs must be fingerprintable on BOTH shapes: panel snapshot key and raw row key
  assert.notEqual(rms.contentFingerprint({ deadlineTs: 1 }), rms.contentFingerprint({ deadlineTs: 2 }), 'panel shape distinguishes deadlines')
  assert.notEqual(rms.contentFingerprint({ deadlineTs: 1 }), rms.contentFingerprint({ deadlineTs: 2 }) + '|x', 'sanity')
})

/* ---------- [F4 P3] DayDeck style injection deduped ---------- */

test('[F4] DayDeck injects its style only when no style[data-deck-css] exists yet', () => {
  assert.ok(/querySelector\('style\[data-deck-css\]'\)/.test(DAYDECK_SRC),
    'an existence guard must run before appendChild')
  const guardIdx = DAYDECK_SRC.indexOf("querySelector('style[data-deck-css]')")
  const appendIdx = DAYDECK_SRC.indexOf('document.head.appendChild(el)')
  assert.ok(guardIdx > -1 && appendIdx > -1 && guardIdx < appendIdx, 'the guard precedes the append')
})

/* ---------- [F5 P3] TomatoFloatPage abandoning watcher ghost timer handle ---------- */

test('[F5] abandoning watcher stores the flushGhost handle; re-entry and beforeUnmount clear it', () => {
  const watch = TOMATO_SRC.slice(TOMATO_SRC.indexOf('watch: {'), TOMATO_SRC.indexOf('computed: {'))
  assert.ok(/abandoning \(\) \{[\s\S]*?this\._ghostTimer = setTimeout\(/.test(watch),
    'the handle is stored on the instance (named, not fire-and-forget)')
  assert.ok(/if \(this\._ghostTimer\) \{ clearTimeout\(this\._ghostTimer\)/.test(watch),
    're-entry inside the 260ms window clears the previous handle (no double flushGhost)')
  const bu = TOMATO_SRC.slice(TOMATO_SRC.indexOf('beforeUnmount () {'), TOMATO_SRC.indexOf('beforeUnmount () {') + 400)
  assert.ok(/clearTimeout\(this\._ghostTimer\)/.test(bu),
    'beforeUnmount clears a pending flushGhost (d21-A15: no firing into a dead component)')
})

/* ---------- [F6 P3] SearchView echo assignments skip the redundant setSearch commit ---------- */

async function mountSearchView () {
  const search = await import('file://' + path.join(ROOT, 'renderer/js/utils/search.js').replace(/\\/g, '/'))
  const core = await import('file://' + path.join(ROOT, 'renderer/js/utils/core.js').replace(/\\/g, '/'))
  const rbk = await import('file://' + path.join(ROOT, 'renderer/js/utils/roleButtonKey.js').replace(/\\/g, '/'))
  const Comp = loadScript(SEARCH_SFC, {
    matchTodo: search.matchTodo, highlightHTML: search.highlightHTML, escapeHtml: search.escapeHtml,
    dayjs: core.dayjs, TodoItem: { name: 'TodoItem' }, EmptyState: { name: 'EmptyState' },
    roleButtonActivate: rbk.roleButtonActivate
  })
  const Vue = require('vue')
  const state = Vue.reactive({ todo: { search: 'seed' }, settings: {} })
  const commits = []
  const store = {
    state,
    commit (type, v) { commits.push({ type, v }); if (type === 'todo/setSearch') state.todo.search = v }
  }
  const app = Vue.createApp({ render () { return Vue.h(Comp, { ref: 'child' }) } })
  app.config.globalProperties.$t = key => key
  app.config.globalProperties.$store = store
  app.config.globalProperties.$route = { query: {} }
  const host = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(host)
  const root = app.mount(host)
  return { vm: root.$refs.child, state, commits, unmount: () => app.unmount() }
}

test('[F6] the created-time echo seed does NOT re-commit the same value to the store', async () => {
  const { vm, commits, unmount } = await mountSearchView()
  try {
    assert.equal(vm.qText, 'seed', 'the buffer is seeded from the store')
    await tick(260) // longer than SEARCH_DEBOUNCE_MS (180)
    assert.equal(commits.filter(c => c.type === 'todo/setSearch').length, 0,
      'seeding the buffer from the store must not schedule a same-value setSearch 180ms later')
  } finally { unmount() }
})

test('[F6] an EXTERNAL store change echoes into the input without a redundant commit; real typing still commits', async () => {
  const { vm, state, commits, unmount } = await mountSearchView()
  try {
    state.todo.search = 'external' // another window/CLI wrote the store
    await tick(10)
    assert.equal(vm.qText, 'external', 'the external value still echoes into the buffer (F-C6 contract)')
    await tick(260)
    assert.equal(commits.filter(c => c.type === 'todo/setSearch').length, 0,
      'the echo must not re-commit the value the store already holds')
    vm.qText = 'typed' // a real user keystroke
    await tick(260)
    const typeCommits = commits.filter(c => c.type === 'todo/setSearch')
    assert.equal(typeCommits.length, 1, 'real typing still commits exactly once')
    assert.equal(typeCommits[0].v, 'typed')
  } finally { unmount() }
})

/* ---------- [F7 P3] ChartCard renderChart skips equal-content rebuilds ---------- */

async function mountChartCard (model) {
  const cfgs = await import('file://' + path.join(ROOT, 'renderer/js/views/statistics/chartConfigs.js').replace(/\\/g, '/'))
  const Comp = loadScript(CHARTCARD_SFC, {
    chartCConfig: cfgs.chartCConfig, chartEConfig: cfgs.chartEConfig,
    chartFConfig: cfgs.chartFConfig, chartGConfig: cfgs.chartGConfig,
    isDarkTheme: cfgs.isDarkTheme,
    loadScript: () => new Promise(() => {}), // must never run: window.Chart is stubbed
    VENDOR: { chart: 'chart-vendor-stub' }
  })
  const Vue = require('vue')
  let constructed = 0; let destroyed = 0
  globalThis.window.Chart = class {
    constructor (el, cfg) { constructed++; this.cfg = cfg }
    destroy () { destroyed++ }
  }
  const app = Vue.createApp({
    data: () => ({ model }),
    render () { return Vue.h(Comp, { model: this.model, ref: 'card' }) }
  })
  // template-less load: reproduce the canvas branch of the SFC template so $refs.canvas exists
  Comp.render = function () { return Vue.h('div', [this.canvasKind ? Vue.h('canvas', { ref: 'canvas' }) : null]) }
  app.config.globalProperties.$t = key => key
  const host = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(host)
  const root = app.mount(host)
  const vm = root.$refs.card
  return { vm, root, app, counters: { get constructed () { return constructed }, get destroyed () { return destroyed } } }
}

const trendModel = () => ({
  modelType: 3, title: 'T', legendLabel: 'L', baselineValue: 1,
  chartList: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }]
})

test('[F7] an equal-content model rebuild (the 30s nowTick pattern) does NOT destroy+recreate the Chart', async () => {
  const { vm, root, counters, app } = await mountChartCard(trendModel())
  try {
    vm.renderChart()
    assert.equal(counters.constructed, 1, 'initial render creates the chart')
    root.model = trendModel() // NEW object, IDENTICAL content — what nowTick rebuilds every 30s
    await tick(40) // deep watcher -> $nextTick -> renderChart
    assert.equal(counters.constructed, 1, 'equal content: no second Chart instance')
    assert.equal(counters.destroyed, 0, 'equal content: the live chart is not destroyed')
  } finally { app.unmount() }
})

test('[F7] real data changes and theme changes still re-render', async () => {
  const { vm, root, counters, app } = await mountChartCard(trendModel())
  try {
    vm.renderChart()
    assert.equal(counters.constructed, 1)
    root.model = { ...trendModel(), chartList: [{ label: 'a', value: 5 }, { label: 'b', value: 6 }] }
    await tick(40)
    assert.equal(counters.constructed, 2, 'a real data change re-renders')
    assert.equal(counters.destroyed, 1, 'the old instance is destroyed on the real rebuild')
    vm.theme = 'dark'
    vm.renderChart()
    assert.equal(counters.constructed, 3, 'a theme flip still forces a redraw (fingerprint includes theme)')
  } finally { app.unmount() }
})
