/**
 * [w14 renderer fixes 2026-10-27] statistics layer regression, five live-verified bugs:
 *   1. [P1] ChartCard.vue — only $i18n.locale was watched; a StatisticsView period switch
 *      (上周/本月/自定义) rebuilt the model objects but the canvas stayed frozen on the
 *      mount-time data. Fix: deep-watch `model`, re-render on $nextTick.
 *   2. [P2] chartModels.js buildHeatmap — unguarded dayjs(Number(r.endTime)) minted
 *      'Invalid Date'/1970-01-01 keys for records without endTime; their focus minutes
 *      silently dropped from the heatmap. Fix: focusDayKeyOf guard, same shape as
 *      buildTimelineRows (~L183).
 *   3. [P2] ChartCard.vue listAllZero — modelType 4 dual-axis cards were hidden when the
 *      main chartList was all zero even though overlayList (focus minutes) carried data.
 *      Fix: dual-axis emptiness = BOTH axes empty; single-axis behavior unchanged.
 *   4. [P2] achievements.js — the early-morning focus badge classified by END hour (<9),
 *      so a 23:00->00:30 night-owl session counted as "清晨专注". Fix: classify by the
 *      startedAt embedded in tomatoId (focusStartedAtOf), fall back to endTime.
 *   5. [P2] TodoBoxView.vue _batchDeleteInner — plain rows were pruned from checkedIds
 *      BEFORE deleteTodosMany; a thrown dispatch left the selection desynced (batch bar
 *      vanished, no retry entry). Fix: selection update moves AFTER the dispatch; failed
 *      rows stay checked; undo snapshot still built from the ids the dispatch RETURNED.
 *
 * Harness: f1-stats-fixes pattern for the pure modules (dayjs UMD global) + the j9
 * extract+strip SFC loader for the two components (window.Chart stubbed to a recorder
 * class so renderChart's destroy/new cycle is observable without a canvas backend).
 *
 * Run: node --test tests/unit/components/w14-stats-renderer-fixes.test.mjs
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
const CARD_SFC = path.join(ROOT, 'renderer/js/views/statistics/ChartCard.vue')
const BOX_SFC = path.join(ROOT, 'renderer/js/views/TodoBoxView.vue')

let cleanupGlobals = () => {}

function loadSfcScript (sfcPath, deps, { defaultExportName } = {}) {
  const src = fs.readFileSync(sfcPath, 'utf8')
  const m = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  assert.ok(m, sfcPath + ': <script> block not found')
  let code = m[1]
    .replace(/^\s*import\s+[^]+?$/gm, '')
    .replace(/\bas\s+any\b/g, '')
    .replace(/\bas\s+[A-Za-z_$][\w$]*(?:\.[\w$]+)*\b/g, '')
    .replace(/:\s*any(?=[\s,)\]=;])/g, '')
    .replace(/export\s+default\s*\{/, 'return {')
  if (defaultExportName) code = code.replace(new RegExp('export\\s+default\\s+' + defaultExportName), 'return ' + defaultExportName)
  const names = Object.keys(deps)
  const prelude = names.map(n => `const ${n} = deps[${JSON.stringify(n)}]`).join('\n')
  return new Function('deps', prelude + '\n' + code)(deps)
}

before(async () => {
  const require_ = createRequire(import.meta.url)
  const dayjs = require_('dayjs')
  dayjs.extend(require_('dayjs/plugin/isoWeek'))
  const { JSDOM } = require('jsdom')
  const g = globalThis
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const w = dom.window
  w.dayjs = dayjs
  const setGlobal = (k, v) => {
    try { g[k] = v } catch { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }) }
  }
  for (const [k, v] of Object.entries({
    window: w, document: w.document, navigator: w.navigator,
    HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node, SVGElement: w.SVGElement,
    CustomEvent: w.CustomEvent, KeyboardEvent: w.KeyboardEvent, MutationObserver: w.MutationObserver,
    HTMLCanvasElement: w.HTMLCanvasElement
  })) setGlobal(k, v)
  cleanupGlobals = () => {
    for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'CustomEvent', 'KeyboardEvent', 'MutationObserver', 'HTMLCanvasElement']) {
      try { delete g[k] } catch { Object.defineProperty(g, k, { value: undefined, configurable: true }) }
    }
    dom.window.close()
  }
  await import(pathToFileUrl(path.join(ROOT, 'renderer/js/views/statistics/chartConfigs.js')))
})

function pathToFileUrl (p) { return 'file:///' + p.replace(/\\/g, '/') }

after(() => { cleanupGlobals() })

/* ============ Bug 2: buildHeatmap endTime guard ============ */

const NOW = new Date(2026, 9, 27, 12, 0, 0).getTime()
const { buildHeatmap, focusDayKeyOf } = await import(pathToFileUrl(path.join(ROOT, 'renderer/js/views/statistics/chartModels.js')))

test('w2 focusDayKeyOf: missing/0 endTime yields empty key (no Invalid Date / 1970 bucket)', () => {
  assert.equal(focusDayKeyOf({ endTime: undefined }), '')
  assert.equal(focusDayKeyOf({}), '')
  assert.equal(focusDayKeyOf({ endTime: 0 }), '')
  assert.equal(focusDayKeyOf({ endTime: NOW }), require('dayjs')(NOW).format('YYYY-MM-DD'))
})

test('w2 buildHeatmap: a success record without endTime is skipped, not crashed / not 1970-keyed', () => {
  const hm = buildHeatmap({
    todos: [],
    records: [
      { succeed: true, endTime: 0, focusDuration: 25 },
      { succeed: true, endTime: undefined, focusDuration: 25 }
    ],
    weeks: 4,
    nowTick: NOW
  })
  assert.ok(hm.cells.every(c => c.focus === 0), 'unguarded records must not contribute focus anywhere')
  assert.ok(hm.cells.every(c => /\d{4}-\d{2}-\d{2}/.test(c.key)), 'no Invalid Date key leaked into cells')
})

test('w2 buildHeatmap: a valid endTime still counts focus minutes (guard skips ONLY bad rows)', () => {
  const hm = buildHeatmap({
    todos: [{ taskId: 'a', complete: true, delete: false, completedAt: NOW, updateTime: NOW }],
    records: [{ succeed: true, endTime: NOW, focusDuration: 25 }],
    weeks: 4,
    nowTick: NOW
  })
  const today = hm.cells.find(c => c.key === require('dayjs')(NOW).format('YYYY-MM-DD'))
  assert.equal(today.focus, 25)
})

/* ============ Bug 4: achievements early-morning badge by session start ============ */

const { buildAchievements } = await import(pathToFileUrl(path.join(ROOT, 'renderer/js/views/statistics/achievements.js')))

const rec = (tomatoId, endTime, extra = {}) => ({ tomatoId, endTime, focusDuration: 25, succeed: true, ...extra })

test('w4 early badge: a 23:00->00:30 night-owl session (ends hour 0) is NOT an early-morning focus', () => {
  // started 23:00 on Oct 26, ended 00:30 on Oct 27 (end hour 0 — old code counted this as early)
  const start = new Date(2026, 9, 26, 23, 0, 0).getTime()
  const end = new Date(2026, 9, 27, 0, 30, 0).getTime()
  const id = 'tmt_f_' + start // mintTomatoId('tmt_f_', startedAt) shape, no salt
  const res = buildAchievements({ todos: [], records: [rec(id, end)] })
  assert.equal(res.families.find(f => f.id === 'early').cur, 0, 'old code counted the END hour 0 here')
})

test('w4 early badge: an 08:00->09:30 session IS early (started before 9, old end-hour code missed it)', () => {
  const start = new Date(2026, 9, 27, 8, 0, 0).getTime()
  const end = new Date(2026, 9, 27, 9, 30, 0).getTime()
  const id = 'tmt_f_' + start
  const res = buildAchievements({ todos: [], records: [rec(id, end)] })
  assert.equal(res.families.find(f => f.id === 'early').cur, 1)
})

test('w4 early badge: legacy record without a parsable tomatoId falls back to the endTime basis', () => {
  const earlyEnd = new Date(2026, 9, 27, 7, 0, 0).getTime()
  const lateEnd = new Date(2026, 9, 27, 14, 0, 0).getTime()
  const res = buildAchievements({ todos: [], records: [rec('', earlyEnd), rec('', lateEnd)] })
  assert.equal(res.families.find(f => f.id === 'early').cur, 1, 'fallback keeps the old end-hour semantics')
})

test('w4 early badge: give-up records (succeed=false) still never count', () => {
  const start = new Date(2026, 9, 27, 8, 0, 0).getTime()
  const id = 'tmt_f_' + start
  const res = buildAchievements({ todos: [], records: [rec(id, start + 1000, { succeed: false })] })
  assert.equal(res.families.find(f => f.id === 'early').cur, 0)
})

/* ============ Bugs 1+3: ChartCard (watch model / dual-axis listAllZero) ============ */

const chartConfigs = await import(pathToFileUrl(path.join(ROOT, 'renderer/js/views/statistics/chartConfigs.js')))

function makeChartStub () {
  const created = []
  class ChartStub {
    constructor (el, cfg) { this.el = el; this.cfg = cfg; this.destroyed = false; created.push(this) }
    destroy () { this.destroyed = true }
  }
  return { ChartStub, created }
}

function mountCard (initialModel) {
  const { ChartStub, created } = makeChartStub()
  globalThis.window.Chart = ChartStub
  const deps = {
    chartCConfig: chartConfigs.chartCConfig,
    chartEConfig: chartConfigs.chartEConfig,
    chartFConfig: chartConfigs.chartFConfig,
    chartGConfig: chartConfigs.chartGConfig,
    isDarkTheme: chartConfigs.isDarkTheme,
    loadScript: () => new Promise(() => {}), // never reached: window.Chart is stubbed
    VENDOR: { chart: 'chart.umd.js' }
  }
  const Card = loadSfcScript(CARD_SFC, deps, { defaultExportName: 'ChartCard' })
  // the SFC <template> block must be handed to the full Vue build explicitly (the extract+strip
  // loader only returns the script object; without render/template the canvas never mounts)
  Card.template = fs.readFileSync(CARD_SFC, 'utf8').match(/<template>([\s\S]*?)<\/template>/)[1]
  const Vue = require('vue')
  // wrapper owns the (reactive) model — ChartCard's `model` prop is readonly, StatisticsView
  // swaps the objects the same way (period switch rebuilds the model objects)
  const Wrapper = {
    components: { Card },
    data () { return { model: initialModel } },
    render () { return Vue.h(Card, { model: this.model, ref: 'card' }) }
  }
  const app = Vue.createApp(Wrapper)
  app.config.globalProperties.$t = (key) => key
  app.config.globalProperties.$message = { warning () {} }
  app.config.globalProperties.$i18n = { locale: 'zh-CN' }
  const host = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(host)
  const vm = app.mount(host)
  return { vm, created, card: vm.$refs.card }
}

const ticks = async vm => { await vm.$nextTick(); await vm.$nextTick() }

test('w3 listAllZero: single-axis (no overlayList) keeps the old all-zero -> empty behavior', async () => {
  const { vm, card } = mountCard({ modelType: 3, chartList: [{ label: 'a', value: 0 }] })
  assert.equal(card.listAllZero, true)
  vm.model = { modelType: 3, chartList: [{ label: 'a', value: 3 }] }
  await vm.$nextTick() // props propagate on the parent's re-render
  assert.equal(card.listAllZero, false)
})

test('w3 listAllZero: dual-axis hides only when BOTH chartList and overlayList are empty', async () => {
  const { vm, card } = mountCard({ modelType: 4, chartList: [{ label: 'a', value: 0 }], overlayList: [{ label: 'a', value: 45 }] })
  // main axis all zero but overlayList (focus minutes) carries data -> must NOT be judged empty
  assert.equal(card.listAllZero, false, 'old code returned true here and swallowed the card')
  vm.model = { modelType: 4, chartList: [{ label: 'a', value: 0 }], overlayList: [{ label: 'a', value: 0 }] }
  await vm.$nextTick()
  assert.equal(card.listAllZero, true)
})

test('w1 watch model: an in-place chartList update re-renders the chart with the new data', async () => {
  const { vm, card, created } = mountCard({ modelType: 3, chartList: [{ label: 'a', value: 1 }, { label: 'b', value: 2 }] })
  await ticks(vm)
  assert.equal(created.length, 1, 'mounted: one chart instance')
  vm.model.chartList[0].value = 99
  vm.model.chartList.push({ label: 'c', value: 3 })
  await ticks(vm)
  assert.equal(created.length, 2, 'old code never re-rendered here: canvas stayed on mount-time data')
  assert.equal(created[0].destroyed, true, 'Chart.js instance is destroyed, not leaked on re-render')
  const data = created[1].cfg.data
  const values = (data.datasets || []).flatMap(d => d.data)
  assert.ok(values.includes(99) && values.includes(3), 'new instance carries the updated values')
})

test('w1 watch model: model swap (period switch) re-renders with the new period data', async () => {
  const { vm, card, created } = mountCard({ modelType: 3, chartList: [{ label: 'a', value: 1 }] })
  await ticks(vm)
  assert.equal(created.length, 1)
  vm.model = { modelType: 3, chartList: [{ label: 'x', value: 42 }] } // StatisticsView period switch
  await ticks(vm)
  assert.equal(created.length, 2, 'old code kept the mount-time chart under the new title')
  const values = (created[1].cfg.data.datasets || []).flatMap(d => d.data)
  assert.ok(values.includes(42))
})

test('w1 watch model: canvas <-> empty branch swap still re-renders when data appears', async () => {
  const { vm, card, created } = mountCard({ modelType: 3, chartList: [] }) // empty -> chart-empty branch, no canvas mounted
  await ticks(vm)
  assert.equal(created.length, 0)
  vm.model = { modelType: 3, chartList: [{ label: 'a', value: 5 }] }
  await ticks(vm)
  assert.equal(created.length, 1, 'data appearing must mount a canvas AND draw (needed $nextTick)')
})

/* ============ Bug 5: TodoBoxView batchDelete selection-after-dispatch ============ */

function buildBoxHarness () {
  const state = {
    todo: { todoList: [] },
    settings: { todoBoxSortMethod: 'created', todoBoxSortOrder: 'desc', todoBoxCategoryId: -1 },
    ui: { rightSidebarTodoEdit: false },
    category: { list: [] }
  }
  const captured = { undo: [], warnings: [] }
  const deps = {
    taskContextMenu: () => {},
    DEFAULT_CAT_COLOR: '#bfbfbf',
    toggleCompleteWithUndo: () => {},
    batchMoveWithUndo: (vm, opts) => { captured.undo.push(opts) },
    isRepeatTask: row => Boolean(row && row.repeatId),
    getEstimate: () => 0,
    estimateTier: () => 0,
    EmptyState: { render: () => null },
    roleButtonActivate: fn => fn,
    roleCheckboxActivate: fn => fn
  }
  return { state, captured, deps }
}

async function mountBox ({ state, deps, deleteBehavior, captured }) {
  const Comp = loadSfcScript(BOX_SFC, deps)
  const Vue = require('vue')
  const store = {
    state,
    getters: { 'category/byId': () => () => null },
    async dispatch (type, payload) {
      if (type === 'todo/deleteTodosMany') return deleteBehavior(payload)
      return null
    },
    commit () {}
  }
  const app = Vue.createApp(Comp)
  const props = {
    $t: (key, params) => key + (params ? ':' + JSON.stringify(params) : ''),
    $announce: () => {},
    $confirm: () => Promise.resolve(),
    $message: {
      closeAll () {},
      warning (msg) { captured.warnings.push(msg) },
      success () {}, error () {}
    },
    $route: { name: 'todo-list-todo-box', params: {} },
    $store: store
  }
  for (const [k, v] of Object.entries(props)) app.config.globalProperties[k] = v
  const host = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(host)
  return app.mount(host)
}

const seedBox = state => {
  state.todo.todoList.push(
    { taskId: 't1', taskContent: '甲', complete: false, delete: false },
    { taskId: 't2', taskContent: '乙', complete: false, delete: false }
  )
}

test('w5 batchDelete success: deleted ids leave the selection, undo snapshot = returned ids', async () => {
  const h = buildBoxHarness()
  h.deps // isRepeatTask from deps: t2 is recurring below? here both plain
  const vm = await mountBox({ ...h, deleteBehavior: async payload => payload.map(t => t.taskId) })
  seedBox(h.state)
  vm.checkedIds = ['t1', 't2']
  await vm.batchDelete()
  assert.deepEqual(vm.checkedIds, [], 'plain rows cleared after a SUCCESSFUL delete')
  assert.equal(h.captured.undo.length, 1)
  assert.deepEqual(h.captured.undo[0].snap.map(s => s.id), ['t1', 't2'], 'undo snapshot = dispatch-returned ids')
  assert.deepEqual(h.captured.warnings, [])
})

test('w5 batchDelete failure: plain rows STAY checked (retry entry kept) and no phantom undo entry', async () => {
  const h = buildBoxHarness()
  const vm = await mountBox({ ...h, deleteBehavior: async () => { throw new Error('dead row') } })
  seedBox(h.state)
  vm.checkedIds = ['t1', 't2']
  await vm.batchDelete()
  assert.deepEqual(vm.checkedIds, ['t1', 't2'], 'old code pruned checkedIds BEFORE the dispatch: selection lost with no retry')
  assert.equal(h.captured.undo.length, 0, 'a total failure must not produce an undo toast')
  assert.equal(h.captured.warnings.length, 1, 'failure surfaces via msgPartialFail')
})

test('w5 batchDelete mixed: repeat pass-over stays checked on success, plain rows cleared', async () => {
  const h = buildBoxHarness()
  // r1 is the first recurring instance -> repeatAsk (ui commit); r2 pass-over; t1 plain.
  const vm = await mountBox({ ...h, deleteBehavior: async payload => payload.map(t => t.taskId) })
  h.state.todo.todoList = [
    { taskId: 't1', taskContent: '甲', complete: false, delete: false },
    { taskId: 'r1', taskContent: '重复甲', repeatId: 'rp_1', complete: false, delete: false },
    { taskId: 'r2', taskContent: '重复乙', repeatId: 'rp_2', complete: false, delete: false }
  ]
  vm.checkedIds = ['t1', 'r1', 'r2']
  const commits = []
  vm.$store.commit = (type, payload) => commits.push([type, payload])
  await vm.batchDelete()
  assert.deepEqual(vm.checkedIds, ['r2'], 'first repeat group asked; remaining repeats stay checked (old behavior kept)')
  assert.deepEqual(commits, [['ui/askRepeatDelete', 'r1']])
  assert.deepEqual(h.captured.undo[0].snap.map(s => s.id), ['t1'], 'undo snapshot only for the plain success subset')
})
