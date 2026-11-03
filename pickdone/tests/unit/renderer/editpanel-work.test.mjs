/**
 * [pd20 S3] EditPanel '继续工作' (Continue-work / work-episode) folded section — RED-first pins.
 *
 * User-visible contract:
 *  - The section is gated by the INDEPENDENT settings switch workEpisode.enabled (experiment
 *    boundary: default OFF, never exposed to daily users). Switch OFF (default) → the panel
 *    renders exactly as today: no section, and zero extra dbCall('queryEpisodesByTask').
 *  - Switch ON → the section shows the four blocks (现状 / 工作历程 / 关联资源 / 继续工作) and its
 *    data arrives via globalThis.window.todoAPI.dbCall('queryEpisodesByTask', taskId).
 *  - Clicking '复制 Handoff' writes buildHandoff's output (the S2 pure function, injected here as
 *    a mock) to the clipboard — the clipboard payload IS the pure function's return value.
 *
 * NOTE on the runner: the ask names @vue/test-utils, but @vue/test-utils is NOT a declared
 * dependency of pickdone/package.json (adding it would touch package.json — outside this
 * slice's allowed paths). The repo's unit layer runs node --test; this file mounts the REAL
 * EditPanel.vue / EditPanelWork.vue SFCs (compiled with the installed @vue/compiler-sfc)
 * through the vue runtime in jsdom, which exercises the same user-visible render path.
 *
 * Run: node --test tests/unit/renderer/editpanel-work.test.mjs
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
const PANEL_SFC = path.join(ROOT, 'renderer/js/components/EditPanel.vue')
const WORK_SFC = path.join(ROOT, 'renderer/js/components/editpanel/EditPanelWork.vue')

const I18N = {
  'statsJ.EditPanel.workEpisodeTitle': '继续工作',
  'statsJ.EditPanel.workEpisodeCurrent': '现状',
  'statsJ.EditPanel.workEpisodeHistory': '工作历程',
  'statsJ.EditPanel.workEpisodeResources': '关联资源',
  'statsJ.EditPanel.workEpisodeHandoff': '继续工作',
  'statsJ.EditPanel.workEpisodeCopyHandoff': '复制 Handoff',
  'statsJ.EditPanel.workEpisodeEmpty': '暂无工作记录'
}

let cleanupGlobals = () => {}
const mountedApps = [] // drained in after(): leftover transition timers must not outlive the jsdom window
const pendingTimers = new Set() // pd20 fix: tracked node timers cleared in after() — the panel's persist-probe/save-queue retries used to fire after cleanupGlobals and hit "window is not defined" (file-level async leak)

/* Strip the SFC <script> block's imports + TS type annotations, keep the option object.
 * Same convention as tests/unit/components/j4-tag-title-dedup.test.mjs. */
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

function templateOf (sfcPath) {
  const src = fs.readFileSync(sfcPath, 'utf8')
  const start = src.indexOf('<template>')
  const end = src.lastIndexOf('</template>')
  assert.ok(start >= 0 && end > start, sfcPath + ': <template> block not found')
  // lastIndexOf: SFC templates may contain nested <template v-if> tags — slicing to the FIRST
  // closing tag truncates the render tree (EditPanel.vue does).
  return src.slice(start + '<template>'.length, end)
}

before(async () => {
  const { JSDOM } = require('jsdom')
  const g = globalThis
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
  const w = dom.window
  const core = await import('../../../renderer/js/utils/core.js')
  w.dayjs = core.dayjs
  const setGlobal = (k, v) => {
    try { g[k] = v } catch { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }) }
  }
  for (const [k, v] of Object.entries({
    window: w, document: w.document, navigator: w.navigator,
    HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node, CustomEvent: w.CustomEvent, KeyboardEvent: w.KeyboardEvent, SVGElement: w.SVGElement, requestAnimationFrame: (cb) => setTimeout(() => cb(Date.now()), 0), cancelAnimationFrame: (id) => clearTimeout(id)
  })) setGlobal(k, v)
  // Track every timer scheduled while the jsdom window is installed so after() can cancel the
  // stragglers (persist probe backoff, save-queue retries) BEFORE window is torn down.
  const rawSetTimeout = g.setTimeout
  const rawSetInterval = g.setInterval
  const wrappedSetTimeout = (fn, ms, ...rest) => {
    const h = rawSetTimeout((...a) => { pendingTimers.delete(h); return fn(...a) }, ms, ...rest)
    pendingTimers.add(h)
    return h
  }
  const wrappedSetInterval = (fn, ms, ...rest) => {
    const h = rawSetInterval(fn, ms, ...rest)
    pendingTimers.add(h)
    return h
  }
  setGlobal('setTimeout', wrappedSetTimeout)
  setGlobal('setInterval', wrappedSetInterval)
  cleanupGlobals = () => {
    for (const h of pendingTimers) { try { clearTimeout(h) } catch { /* already fired */ } }
    pendingTimers.clear()
    setGlobal('setTimeout', rawSetTimeout)
    setGlobal('setInterval', rawSetInterval)
    for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'CustomEvent', 'KeyboardEvent']) {
      try { delete g[k] } catch { Object.defineProperty(g, k, { value: undefined, configurable: true }) }
    }
    dom.window.close()
  }
})

after(async () => {
  for (const app of mountedApps) { try { app.unmount() } catch { /* already gone */ } }
  await new Promise(r => setTimeout(r, 30)) // let scheduled transition rAF/timers settle while window is alive
  cleanupGlobals()
})

const EPISODES = [
  { episodeId: 1, summary: '白天写了渲染层', resources: ['spec.md'] },
  { episodeId: 2, summary: '晚上补了回归', resources: [] }
]

function mountPanel ({ settings = {}, episodes = EPISODES } = {}) {
  // The S2 pure function arrives via EditPanel's provide (deps-injected here as a mock; production
  // wires the real one from utils/handoff.js). Real signature: buildHandoff(episodes, sources, task)
  // → { text, json } — the clipboard gets `.text`.
  const handoffCalls = []
  const buildHandoff = (eps, srcs, task) => {
    handoffCalls.push({ episodes: eps, sources: srcs, task })
    return { text: 'HANDOFF:' + task.title + ':' + eps.length, json: {} }
  }
  const dbCalls = []
  globalThis.window.todoAPI = {
    dbCall: (op, params) => {
      dbCalls.push({ op, params })
      if (op === 'queryEpisodesByTask') return Promise.resolve(JSON.parse(JSON.stringify(episodes)))
      return Promise.resolve([])
    }
  }
  const clipboardWrites = []
  Object.defineProperty(globalThis.window.navigator, 'clipboard', {
    value: { writeText: (t) => { clipboardWrites.push(t); return Promise.resolve() } },
    configurable: true
  })

  return (async () => {
    const Vue = await import('vue')
    const search = await import('../../../renderer/js/utils/search.js')
    const roleKey = await import('../../../renderer/js/utils/roleButtonKey.js')
    const ddMenu = await import('../../../renderer/js/utils/dd-menu.js')
    const core = await import('../../../renderer/js/utils/core.js')
    const remote = await import('../../../renderer/js/utils/editPanelRemoteSync.js')
    const sanitize = await import('../../../shared/sanitize-text.mjs')
    const editSave = await import('../../../renderer/js/utils/editSave.js')

    // The work-episode child component (RED phase: file missing → this load throws and the whole file runs red)
    const workOption = loadScript(WORK_SFC, {})
    workOption.template = templateOf(WORK_SFC)

    // Host helpers: the interactive/mechanical ones are stubbed (drag/tour/DB retry plumbing);
    // the pure ones are the REAL modules.
    const stubs = {
      EpReminders: { name: 'EpReminders', template: '<div class="stub-reminders"/>' },
      EpSubtasks: { name: 'EpSubtasks', template: '<div class="stub-subtasks"/>' },
      EpAttachments: { name: 'EpAttachments', template: '<div class="stub-attachments"/>' },
      EpDependencies: { name: 'EpDependencies', template: '<div class="stub-deps"/>' },
      EpTomato: { name: 'EpTomato', template: '<div class="stub-tomato"/>' },
      EpTags: { name: 'EpTags', template: '<div class="stub-tags"/>' },
      attachments: { pickFiles () {}, onDescPaste () {}, onDescDrop () {}, uploadOne () {} },
      repeat: { repeatGroupInfo () { return Promise.resolve() }, askRepeatEdit () {}, askRepeatDelete () {} },
      subtaskOps: { initSubSortable () {}, toggleSub () {} },
      panelSetup: { runEditpanelTour () {}, disableSpellcheck () {}, dynamicSpellcheckGuard () { return null } },
      reminderOps: { onRemindersCommit () {}, onRemindersClear () {}, onRemindersOffsets () {} },
      deleteWithUndo: () => Promise.resolve(true),
      removeWithUndo: () => true,
      toggleCompleteWithUndo: () => Promise.resolve(),
      pendingUpserts: { someQ: [] },
      buildEditSnapshot (live) {
        // Faithful shallow shape of store/ui.js buildEditSnapshot for the fields hydrate consumes
        return Object.assign({}, live, {
          sublist: JSON.parse(live.subtasks || '[]'),
          todoImageList: [], fileList: []
        })
      }
    }

    const panelOption = loadScript(PANEL_SFC, {
      dayjs: core.dayjs, FMT: core.FMT, reportError: () => {},
      getLocale: () => 'zh-CN',
      extractTags: search.extractTags,
      isRenderableAttachmentUrl: core.isRenderableAttachmentUrl,
      createSaveQueue: editSave.createSaveQueue,
      createPersistProbe: editSave.createPersistProbe,
      contentFingerprint: remote.contentFingerprint,
      shouldRefreshRemote: remote.shouldRefreshRemote,
      taskAbsentIn: remote.taskAbsentIn,
      getEstimate: () => 0, setEstimate: () => {}, ensureEstimate: () => {},
      findTaskRowEl: () => null, $elOf: () => null,
      roleButtonActivate: roleKey.roleButtonActivate,
      roleCheckboxActivate: roleKey.roleCheckboxActivate,
      ddMenuKey: ddMenu.ddMenuKey,
      catOutsideClose: () => {}, FIELD_MAP: { title: 'title', desc: 'describe', priority: 'priority', categoryId: 'categoryId', deadlineTs: 'deadlineTs' },
      DESC_MAX: sanitize.TEXT_MAX_LEN,
      EpDateChips: { name: 'EpDateChips', props: ['dateTs', 'today0'], emits: ['set', 'pick'], template: '<div class="stub-datechips"/>' },
      EpBinBanner: { name: 'EpBinBanner', emits: ['restore'], template: '<div class="stub-binbanner"/>' },
      EpSaveHint: { name: 'EpSaveHint', props: ['show'], emits: ['retry'], template: '<div class="stub-savehint"/>' },
      EpWork: workOption,
      buildHandoff, // pd20 fix: EditPanel provides the injected formatter to EpWork
      ...stubs
    })
    panelOption.template = templateOf(PANEL_SFC)

    const { reactive, nextTick } = Vue
    const state = reactive({
      settings,
      todo: { todoList: [{ taskId: 42, title: '写周报', subtasks: '[]', image: '[]', files: '[]', updateTime: 1, deleted: 0 }], recycleList: [], todayTimestamp: 1700000000000 },
      ui: { rightSidebarTodoEdit: { visible: false, taskId: 42, collapsed: false } }
    })
    const store = {
      state,
      getters: { 'tomato/actualCountByTask': new Map(), 'category/sortedAll': [] },
      commit () {}, dispatch () {}
    }

    const app = Vue.createApp(panelOption)
    app.config.globalProperties.$store = store
    app.config.globalProperties.$t = (k) => I18N[k] || k
    app.config.globalProperties.$message = { success () {}, error () {} }
    app.config.globalProperties.$announce = () => {}
    app.component('el-input', { props: ['modelValue', 'type', 'placeholder', 'autosize', 'maxlength'], emits: ['input', 'update:modelValue'], template: '<textarea class="stub-el-input"/>' })
    app.component('el-date-picker', { template: '<div class="stub-el-date-picker"/>' })
    app.component('app-icon', { props: ['name', 'size'], template: '<i class="stub-app-icon"/>' })
    app.directive('click-outside', {}) // no-op in the harness (panel cat-pop uses it; harness never exercises it)
    mountedApps.push(app)
    const root = globalThis.document.createElement('div')
    globalThis.document.body.appendChild(root)
    app.mount(root)
    // Open the panel on task 42 (the immediate visible-watcher runs hydrate)
    state.ui.rightSidebarTodoEdit.visible = true
    await nextTick()
    await nextTick()
    await Promise.resolve()
    await nextTick()

    return {
      root, state, dbCalls, clipboardWrites, handoffCalls,
      copyBtn: () => root.querySelector('.ep-work-copy'),
      section: () => root.querySelector('.ep-work-section')
    }
  })()
}

test('S3 OFF (default): switch off renders the panel exactly as today — no 继续工作 section, zero queryEpisodesByTask dbCall', async () => {
  const h = await mountPanel({ settings: {} })
  assert.equal(h.section(), null, 'the work-episode section must not render when workEpisode.enabled is unset (default off)')
  assert.equal(h.dbCalls.filter(c => c.op === 'queryEpisodesByTask').length, 0, 'switch off must not issue any queryEpisodesByTask dbCall')
  // and the rest of the panel is still there (renders as today)
  assert.ok(h.root.querySelector('.ep-title'), 'the edit panel itself still renders')
})

test('S3 ON: the section renders the four blocks (现状/工作历程/关联资源/继续工作) and reads via dbCall(queryEpisodesByTask, taskId)', async () => {
  const h = await mountPanel({ settings: { workEpisode: { enabled: true } } })
  assert.ok(h.section(), 'the work-episode section renders when workEpisode.enabled is on')
  const call = h.dbCalls.find(c => c.op === 'queryEpisodesByTask')
  assert.ok(call, 'section data is read via dbCall("queryEpisodesByTask")')
  assert.equal(call.params, 42, 'the query carries the open task id')
  const labels = Array.from(h.root.querySelectorAll('.ep-work-label')).map(el => el.textContent.trim())
  for (const want of ['现状', '工作历程', '关联资源', '继续工作']) {
    assert.ok(labels.includes(want), `block label 「${want}」 present (got: ${labels.join('/')})`)
  }
  assert.ok(h.section().textContent.includes('晚上补了回归'), 'the work-history block shows episode data from dbCall')
})

test('S3 ON: clicking 复制 Handoff writes buildHandoff(payload) to the clipboard', async () => {
  const h = await mountPanel({ settings: { workEpisode: { enabled: true } } })
  const btn = h.copyBtn()
  assert.ok(btn, 'the copy-Handoff button renders in the handoff block')
  btn.click()
  await Promise.resolve()
  assert.equal(h.clipboardWrites.length, 1, 'one clipboard write')
  assert.equal(h.clipboardWrites[0], 'HANDOFF:写周报:2', 'clipboard content === buildHandoff output (S2 pure function, mocked)')
  assert.equal(h.handoffCalls.length, 1, 'buildHandoff called once with the assembled payload')
})
