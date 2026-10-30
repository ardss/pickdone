/**
 * [J4 2026-10-22] TodoItem title vs tag-chip duplication — RED-first pins.
 *
 * Live finding (journey-audit J4): a task titled `周报 #工作` renders the tag token in the
 * title AND an identical `#工作` chip right below it — the same information twice on one row.
 * Fix: strip the tag tokens from the DISPLAYED title (store content stays the single source;
 * chips stay); a title made only of tags falls back to the raw content so the row never goes
 * blank. The hover tooltip (:title) and aria-label keep the full raw content.
 *
 * Run: node --test tests/unit/components/j4-tag-title-dedup.test.mjs
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
const TI_SFC = path.join(ROOT, 'renderer/js/components/TodoItem.vue')

let cleanupGlobals = () => {}

function loadScript (sfcPath, deps) {
  const src = fs.readFileSync(sfcPath, 'utf8')
  const m = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  assert.ok(m, sfcPath + ': <script> block not found')
  const code = m[1]
    .replace(/^\s*import\s+[^]+?$/gm, '')
    .replace(/\bas\s+any\b/g, '')
    .replace(/\bas\s+[A-Za-z_$][\w$]*(?:\.[\w$]+)*\b/g, '')
    .replace(/:\s*any(?=[\s,)\]=;])/g, '')
    .replace(/export\s+default\s*\{/, 'return {')
  const names = Object.keys(deps)
  const prelude = names.map(n => `const ${n} = deps[${JSON.stringify(n)}]`).join('\n')
  return new Function('deps', prelude + '\n' + code)(deps)
}

before(async () => {
  const { JSDOM } = require('jsdom')
  const g = globalThis
  const prev = g.window || {}
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const w = dom.window
  const core = await import('../../../renderer/js/utils/core.js')
  for (const k of ['pinyinPro', 'VueI18n', 'localStorage']) {
    if (prev[k] != null) { try { w[k] = prev[k] } catch { /* read-only on the dom window */ } }
  }
  w.dayjs = core.dayjs
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

async function mountItem (taskContent, query = '') {
  const search = await import('../../../renderer/js/utils/search.js')
  const taskRow = await import('../../../renderer/js/utils/taskRow.js')
  const tomato = await import('../../../renderer/js/utils/tomatoEstimate.js')
  const sortMode = await import('../../../renderer/js/utils/sortMode.js')
  const sortCore = await import('../../../shared/sort-core.mjs')
  const crossDay = await import('../../../renderer/js/utils/crossDayMove.js')
  const descLines = await import('../../../renderer/js/utils/descLines.js')
  const roleKey = await import('../../../renderer/js/utils/roleButtonKey.js')
  const deps = {
    extractTags: search.extractTags,
    highlightHTML: search.highlightHTML,
    stripTagTokens: search.stripTagTokens,
    deleteWithUndo: () => {},
    moveWithUndo: () => {},
    toggleCompleteWithUndo: () => {},
    chkColor: taskRow.chkColor,
    neighborInList: taskRow.neighborInList,
    getEstimate: tomato.getEstimate,
    ensureEstimate: tomato.ensureEstimate,
    normalizeSortMode: sortMode.normalizeSortMode,
    reorderScale: sortCore.reorderScale,
    crossDayMovePatch: crossDay.crossDayMovePatch,
    crossDayRevertPatch: crossDay.crossDayRevertPatch,
    taskContextMenu: () => {},
    descLineClampStyle: descLines.descLineClampStyle,
    roleButtonActivate: roleKey.roleButtonActivate,
    roleCheckboxActivate: roleKey.roleCheckboxActivate,
    // [win-bind T8] TodoItem locally registers WinBindBadge; the import-stripping harness needs
    // the name defined — stub component (this harness never renders the template block)
    WinBindBadge: { name: 'WinBindBadge', render: () => null },
    isReleaseOutsideViewport: () => false
  }
  const Comp = loadScript(TI_SFC, deps)
  const Vue = require('vue')
  // parent-wrapper mount (d4 pattern): props must arrive as real props — they are readonly on
  // the instance proxy, so tests swap the whole reactive props object instead of assigning
  const reactiveProps = Vue.reactive({
    todo: { taskContent, dayStart: 0, todoTime: 0, complete: false, subtasks: '[]', reminderTime: 0 },
    query,
    groupKey: '',
    showDateBadge: false
  })
  const app = Vue.createApp({
    render () { return Vue.h(Comp, { ...reactiveProps, ref: 'child' }) }
  })
  const props = {
    $t: (key, params) => key + (params ? ':' + JSON.stringify(params) : ''),
    $announce: () => {},
    $message: { success () {}, error () {}, warning () {}, closeAll () {} },
    $route: { name: 'today', params: {} },
    $store: {
      state: { settings: {}, todo: { todoList: [] }, category: { list: [] }, ui: {} },
      getters: {},
      async dispatch () { return null },
      commit () {}
    }
  }
  for (const [k, v] of Object.entries(props)) app.config.globalProperties[k] = v
  const host = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(host)
  const root = app.mount(host)
  const vm = root.$refs.child
  vm.__props = reactiveProps // tests can swap vm.__props.todo / vm.__props.query
  return vm
}

test('j4: stripTagTokens removes tag tokens with the exact extractTags contract', async () => {
  const { stripTagTokens } = await import('../../../renderer/js/utils/search.js')
  assert.equal(stripTagTokens('周报 #工作 整理纪要'), '周报 整理纪要')
  assert.equal(stripTagTokens('买牛奶 #生活 周末去爬山'), '买牛奶 周末去爬山', 'inner tags collapse to one space')
  assert.equal(stripTagTokens('任务#工作'), '任务', 'a token glued to text still strips (extractTags sees it too)')
  assert.equal(stripTagTokens('#工作'), '', 'an only-tag title strips to empty — caller must fall back')
  assert.equal(stripTagTokens(''), '')
  assert.equal(stripTagTokens(null), '')
  assert.equal(stripTagTokens('C#开发 待办'), 'C 待办', 'same match set as extractTags (chip 开发 exists), title drops it once')
})

test('j4: displayTitle strips tag tokens; an only-tag title falls back to the raw content', async () => {
  const vm = await mountItem('周报 #工作 整理纪要')
  assert.equal(vm.displayTitle, '周报 整理纪要', 'the title must not repeat what the chips already show')
  const only = await mountItem('#工作')
  assert.equal(only.displayTitle, '#工作', 'fallback: a row must never go blank')
  const plain = await mountItem('无标签任务')
  assert.equal(plain.displayTitle, '无标签任务')
})

test('j4: highlightedTitle highlights the STRIPPED title (no tag token echoed back)', async () => {
  const vm = await mountItem('周报 #工作 整理纪要', '周报')
  assert.ok(vm.highlightedTitle.includes('周报'), 'the matching term stays highlighted')
  assert.ok(!vm.highlightedTitle.includes('#工作'), 'the stripped tag token must not re-enter the title')
  assert.ok(vm.highlightedTitle.includes('span'), 'highlight markup present')
})

test('j4: the template renders displayTitle (wiring check)', async () => {
  const src = fs.readFileSync(TI_SFC, 'utf8')
  assert.match(src, /\{\{ displayTitle \}\}/, 'the plain-title branch must render the stripped displayTitle')
  assert.match(src, /highlightHTML\(this\.displayTitle/, 'the query branch must highlight the stripped title')
})
