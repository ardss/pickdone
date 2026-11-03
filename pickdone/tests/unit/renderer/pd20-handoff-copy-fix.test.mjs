/**
 * [pd20 fix] EditPanelWork Copy-Handoff — UI-level regression (mounted component, not pure functions).
 *
 * Independent-reviewer blocking defects reproduced & fixed:
 *   [1] inject chain: EditPanelWork injects `buildHandoff` (default null) but no ancestor provided
 *       it → the copy button never rendered. Fix: EditPanel.vue now provides the REAL
 *       utils/handoff.js buildHandoff (mimicked here by the host provide environment).
 *   [2] copyHandoff called buildHandoff(this.handoffPayload) and String(result)'d it, while the real
 *       signature is buildHandoff(episodes, sources, task) → { text, json } → the clipboard received
 *       literally "[object Object]".
 *   [3] copyHandoff must assemble REAL data: this task's episodes (dbCall queryEpisodesByTask),
 *       its linked sourceRefs (dbCall querySourcesByTask, canonicalUri composed main-side) and the
 *       task record — then copy result.text with user-visible success/failure feedback.
 *
 * These tests mount the REAL EditPanelWork.vue SFC through the vue runtime in jsdom (same
 * loadScript+mount paradigm as w32-quickadd-pending-fixes.test.mjs), stub the clipboard and
 * todoAPI, CLICK the copy button and assert on the clipboard payload.
 *
 * Run: node --test tests/unit/renderer/pd20-handoff-copy-fix.test.mjs
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
const WORK_SFC = path.join(ROOT, 'renderer/js/components/editpanel/EditPanelWork.vue')

const I18N = {
  'statsJ.EditPanel.workEpisodeTitle': '继续工作',
  'statsJ.EditPanel.workEpisodeCurrent': '现状',
  'statsJ.EditPanel.workEpisodeHistory': '工作历程',
  'statsJ.EditPanel.workEpisodeResources': '关联资源',
  'statsJ.EditPanel.workEpisodeHandoff': '继续工作',
  'statsJ.EditPanel.workEpisodeCopyHandoff': '复制 Handoff',
  'statsJ.EditPanel.workEpisodeEmpty': '暂无工作记录',
  'statsJ.EditPanel.workEpisodeCopyOk': '已复制到剪贴板',
  'statsJ.EditPanel.workEpisodeCopyFail': '复制失败'
}

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
    HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node, CustomEvent: w.CustomEvent, KeyboardEvent: w.KeyboardEvent, SVGElement: w.SVGElement
  })) setGlobal(k, v)
  cleanupGlobals = () => {
    for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'CustomEvent', 'KeyboardEvent', 'SVGElement']) {
      try { delete g[k] } catch { Object.defineProperty(g, k, { value: undefined, configurable: true }) }
    }
    dom.window.close()
  }
})

after(() => { cleanupGlobals() })

/* Real fixture data — as the db layer returns it (view model shapes). */
const EPISODES = [
  { episodeId: 'ep-1', startedAt: 1700000000000, endedAt: 1700003600000, summary: '白天写了渲染层', resources: ['spec.md'] },
  { episodeId: 'ep-2', startedAt: 1700086400000, endedAt: 1700090000000, summary: '晚上补了回归', resources: [] }
]
const SOURCES = [
  { level: 'L0', canonicalUri: 'jira://PD-20', title: 'handoff spec' },
  { level: 'L0', canonicalUri: 'github://pd20/slice', title: 'slice PR' }
]
const TASK = { taskId: 42, title: '写周报' }

function templateOf (sfcPath) {
  const src = fs.readFileSync(sfcPath, 'utf8')
  const start = src.indexOf('<template>')
  const end = src.lastIndexOf('</template>')
  assert.ok(start >= 0 && end > start, sfcPath + ': <template> block not found')
  return src.slice(start + '<template>'.length, end)
}

async function mountWork ({ withProvider = true } = {}) {
  const { buildHandoff } = await import('../../../renderer/js/utils/handoff.js')
  const Comp = loadScript(WORK_SFC, {})
  Comp.template = templateOf(WORK_SFC) // loadScript yields a template-less option — attach the real SFC template
  const Vue = require('vue')

  const dbCalls = []
  globalThis.window.todoAPI = {
    dbCall: (op, params) => {
      dbCalls.push({ op, params })
      if (op === 'queryEpisodesByTask') return Promise.resolve(JSON.parse(JSON.stringify(EPISODES)))
      if (op === 'querySourcesByTask') return Promise.resolve(JSON.parse(JSON.stringify(SOURCES)))
      return Promise.resolve([])
    }
  }
  const clipboardWrites = []
  let clipboardFail = false
  Object.defineProperty(globalThis.window.navigator, 'clipboard', {
    value: {
      writeText: (t) => {
        if (clipboardFail) return Promise.reject(new Error('clipboard unavailable'))
        clipboardWrites.push(t); return Promise.resolve()
      }
    },
    configurable: true
  })

  const Host = {
    // Mimics the fixed EditPanel.vue provider: provide the REAL S2 pure function (no mock).
    provide: withProvider ? { buildHandoff } : {},
    render () { return Vue.h(Comp, { taskId: TASK.taskId, taskTitle: TASK.title }) }
  }
  const app = Vue.createApp(Host)
  app.config.globalProperties.$t = (k) => I18N[k] || k
  const root = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(root)
  app.mount(root)
  await new Promise(r => setTimeout(r, 0)) // let the immediate taskId watcher's load() settle
  await Vue.nextTick()

  return {
    root, dbCalls, clipboardWrites,
    setClipboardFail: v => { clipboardFail = v },
    copyBtn: () => root.querySelector('.ep-work-copy'),
    section: () => root.querySelector('.ep-work-section'),
    copyState: () => root.querySelector('.ep-work-copy-state'),
    unmount: () => { try { app.unmount() } catch { /* gone */ } }
  }
}

test('[pd20][UI] clicking 复制 Handoff writes the REAL buildHandoff(episodes, sources, task).text to the clipboard — not "[object Object]"', async () => {
  const { buildHandoff } = await import('../../../renderer/js/utils/handoff.js')
  const h = await mountWork({ withProvider: true })
  try {
    const btn = h.copyBtn()
    assert.ok(btn, 'the copy button renders — the inject chain (host provide) must be complete')
    btn.click()
    await new Promise(r => setTimeout(r, 0))
    await Promise.resolve()

    assert.equal(h.clipboardWrites.length, 1, 'exactly one clipboard write')
    const written = h.clipboardWrites[0]
    assert.ok(!written.includes('[object Object]'), 'clipboard must never contain "[object Object]"')
    assert.equal(h.dbCalls.some(c => c.op === 'querySourcesByTask'), true,
      'the linked sourceRefs are read via dbCall(querySourcesByTask)')

    const expected = buildHandoff(
      EPISODES.map(ep => ({
        startedAt: new Date(ep.startedAt).toISOString(), role: 'human',
        goal: ep.summary, outcome: '', nextAction: ''
      })),
      SOURCES, { id: TASK.taskId, title: TASK.title }
    ).text
    assert.equal(written, expected, 'clipboard content === buildHandoff(episodes, sources, task).text')
    assert.ok(written.includes('白天写了渲染层') && written.includes('晚上补了回归'),
      'the text carries the real episode goals')
    assert.ok(written.includes('jira://PD-20') && written.includes('github://pd20/slice'),
      'the text carries the real canonicalUris from the linked sourceRefs')
    assert.ok(written.includes('写周报') && written.includes('[42]'), 'the task record is in the text')

    const state = h.copyState()
    assert.ok(state && state.textContent.includes('已复制到剪贴板'), 'user-visible success feedback shown')
  } finally { h.unmount() }
})

test('[pd20][UI] clipboard failure shows a user-visible failure message (no silent swallow)', async () => {
  const h = await mountWork({ withProvider: true })
  try {
    h.setClipboardFail(true)
    const btn = h.copyBtn()
    assert.ok(btn, 'copy button renders')
    btn.click()
    await new Promise(r => setTimeout(r, 0))
    await Promise.resolve()
    assert.equal(h.clipboardWrites.length, 0, 'nothing written when the clipboard rejects')
    const state = h.copyState()
    assert.ok(state && state.textContent.includes('复制失败'), 'user-visible failure feedback shown')
  } finally { h.unmount() }
})

test('[pd20][UI] fallback: no provider → no white screen, the copy button stays hidden, copyHandoff is a safe no-op', async () => {
  const h = await mountWork({ withProvider: false })
  try {
    assert.ok(h.section(), 'the section itself still renders (no white screen without the provider)')
    assert.equal(h.copyBtn(), null, 'without a buildHandoff provider the copy button stays hidden (no guessed format)')
    assert.equal(h.copyState(), null, 'no stray feedback line in the fallback state')
  } finally { h.unmount() }
})
