/**
 * W23 fix agent 1 — settings-page UX alignment + main-window white-noise entry.
 *
 * Task A (settings layout):
 *  [A1] three different top paddings in the settings modal (left nav column 20px / search bar 0 /
 *       tab panels 20px) are unified to var(--space-4) (16px).
 *  [A2] dead rules removed: the old 20px nav padding (overridden by the 6px rule), the 20px
 *       nth-child(2)/last-child compensations (overridden by the 18px rules), the full-width
 *       underline ::after (replaced by the left vertical bar), and the dead 40px tab height
 *       (the .modal--settings 44px !important pair is the only live value).
 *  [A3] template hints use .tip but the wrap rule lived only on .form-item__tip — hints sat
 *       squeezed beside the control instead of wrapping to a full row; .form-item__control .tip
 *       now carries the wrap behavior.
 *  [A4] empty-label rows (dev hint / open-panel button / privacy note) get .form-item--bare:
 *       no label slot, control left-aligned instead of dangling at the right edge.
 *
 * Task B (TomatoBar noise entry):
 *  [B1] the full (today-view) bar renders a ♪ noise toggle; the slim variant does not.
 *  [B2] clicking the toggle opens the chip popover (none + NOISES from mediaRegistry).
 *  [B3] picking a chip writes settings.whiteNoiseAudio via the settings/update action and closes
 *       the popover; a failed write ({ok:false}) keeps it open (same contract as the float page).
 *  [B4] Escape and outside clicks close the popover.
 *
 * Run: node --test tests/unit/components/w23-settings-ux-and-tomato-noise.test.mjs
 */
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const MODAL = path.join(ROOT, 'renderer/js/components/SettingsModal.vue')
const BAR = path.join(ROOT, 'renderer/js/components/TomatoBar.vue')

const modalSrc = fs.readFileSync(MODAL, 'utf8')
const barSrc = fs.readFileSync(BAR, 'utf8')
const barTemplate = barSrc.match(/<template>([\s\S]*)<\/template>/)[1]

/* ===================== Task A: settings UX (source-level contracts) ===================== */

test('[A1] settings top paddings unified to var(--space-4): search bar, left nav column, tab panels', () => {
  // search bar: top margin 16px (was 0)
  const search = modalSrc.match(/\.settings-search \{[\s\S]*?\}/)
  assert.ok(search, '.settings-search rule found')
  assert.match(search[0], /margin: var\(--space-4\) 0;/)
  assert.ok(!/margin: 0 0 /.test(search[0]), 'search bar no longer starts flush at the modal top')
  // left nav column header (TomatoBar carries the .modal--settings-center layout styles): 16px top
  const header = barSrc.match(/\.modal--settings-center \.modal__header \{[^}]*\}/)
  assert.ok(header, '.modal--settings-center .modal__header rule found')
  assert.match(header[0], /padding: var\(--space-4\) 0 0;/)
  assert.ok(!/padding: 20px 0 0/.test(header[0]), 'left column top padding no longer 20px')
  // tab panels: 16px all around (was 20px top)
  const panel = modalSrc.match(/\.tab-panel \{[^}]*\}/)
  assert.ok(panel, '.tab-panel rule found')
  assert.match(panel[0], /padding: var\(--space-4\)/)
  assert.ok(!/--space-5/.test(panel[0]), 'tab panel top padding no longer the 20px token')
})

test('[A2] dead rules removed: 20px nav padding, 20px nth-child compensation, full-width underline ::after, 40px tab height', () => {
  assert.ok(!/\.setting_tabs \.el-tabs__nav \{ padding-left: 20px !important; \}/.test(modalSrc),
    'old 20px nav padding (overridden by the 6px rule) must go')
  assert.ok(!/\.setting_tabs \.el-tabs__item:nth-child\(2\) \{ padding-left: 20px !important; \}/.test(modalSrc),
    'old 20px nth-child(2) compensation (overridden by the 18px rule) must go')
  assert.ok(!/\.setting_tabs \.el-tabs__item:last-child \{ padding-right: 20px !important; \}/.test(modalSrc),
    'old 20px last-child compensation (overridden by the 18px rule) must go')
  assert.ok(!/left: 20px; right: 20px; bottom: 0/.test(modalSrc),
    'old full-width underline ::after (replaced by the left vertical bar) must go')
  // 44px vs 40px conflict: the 44px !important pair is the live value; the 40px twin is gone
  assert.match(modalSrc, /\.modal--settings \.setting_tabs \.el-tabs__item \{ height: 44px !important; line-height: 44px !important; \}/)
  assert.ok(!/height: 40px; line-height: 40px;/.test(modalSrc), 'dead 40px tab height must go')
  // position:relative anchor and the vertical-bar ::after survive
  assert.match(modalSrc, /\.setting_tabs \.el-tabs__item \{ position: relative; \}/)
  assert.match(modalSrc, /\.setting_tabs \.el-tabs__item\.is-active::after \{ left: 0 !important;/)
})

test('[A3] hints: .form-item__control .tip wraps to a full row (flex-basis 100%)', () => {
  const rule = modalSrc.match(/\.form-item__control \.tip \{[^}]*\}/)
  assert.ok(rule, '.form-item__control .tip rule exists')
  assert.match(rule[0], /flex-basis: 100%/)
  assert.match(rule[0], /margin-top: 8px/)
  assert.match(rule[0], /text-align: left/)
})

test('[A4] empty-label rows use .form-item--bare (label hidden, control left-aligned); empty label spans are gone', () => {
  const labelRule = modalSrc.match(/\.form-item--bare \.form-item__label \{[^}]*\}/)
  const ctlRule = modalSrc.match(/\.form-item--bare \.form-item__control \{[^}]*\}/)
  assert.ok(labelRule && ctlRule, '.form-item--bare variant rules exist')
  assert.match(labelRule[0], /display: none/)
  assert.match(ctlRule[0], /margin-left: 0/)
  assert.match(ctlRule[0], /justify-content: flex-start/)
  // the three bare rows carry the class and no empty label span remains anywhere
  const bareRows = modalSrc.match(/class="form-item form-item--bare"/g) || []
  assert.ok(bareRows.length >= 3, 'dev hint / open-panel button / privacy note rows are bare')
  assert.ok(!/form-item__label"><\/span>/.test(modalSrc), 'no empty form-item__label spans left')
})

/* ===================== Task B: TomatoBar noise entry (behavior) ===================== */

let cleanupGlobals = () => {}

before(() => {
  const { JSDOM } = require('jsdom')
  const dom = new JSDOM('<!doctype html><html><body></body></body></html>'.replace('</body></body>', '</body></html>'), { url: 'http://localhost/' })
  const w = dom.window
  const g = globalThis
  const setGlobal = (k, v) => {
    try { g[k] = v } catch { Object.defineProperty(g, k, { value: v, configurable: true, writable: true }) }
  }
  for (const [k, v] of Object.entries({
    window: w, document: w.document, navigator: w.navigator,
    HTMLElement: w.HTMLElement, Element: w.Element, Node: w.Node, SVGElement: w.SVGElement,
    CustomEvent: w.CustomEvent, KeyboardEvent: w.KeyboardEvent, Event: w.Event
  })) setGlobal(k, v)
  cleanupGlobals = () => {
    for (const k of ['window', 'document', 'navigator', 'HTMLElement', 'Element', 'Node', 'SVGElement', 'CustomEvent', 'KeyboardEvent', 'Event']) {
      try { delete g[k] } catch { Object.defineProperty(g, k, { value: undefined, configurable: true }) }
    }
    dom.window.close()
  }
})

after(() => { cleanupGlobals() })

function loadBarComponent () {
  const m = barSrc.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  assert.ok(m, 'TomatoBar.vue: <script> block not found')
  const code = m[1]
    .replace(/^\s*import\s+[^;]+?from\s+'[^']+'\s*(\/\/[^\n]*)?$/mg, '')
    .replace(/\bas\s+any\b/g, '')
    .replace(/export\s+default\s*\{/, 'return {')
  // stubs for the stripped imports: mediaRegistry.NOISES mirrors the real registry shape
  const NOISES = [
    { id: 'rain', file: 'rain.mp3', labelKey: 'statsH.TomatoBar.noiseRain' },
    { id: 'whitenoise', file: 'whitenoise.ogg', labelKey: 'statsH.TomatoBar.noiseWhitenoise' }
  ]
  const factory = new Function('dayjs', 'FMT', 'formatMMSS', 'NOISES', 'remainingSecOfState', 'store', 'roleButtonActivate', 'observeDispatch', code)
  return factory(
    () => ({ format: () => 0 }), 'date', n => '00:00', NOISES,
    () => 1500, null, fn => fn, () => Promise.resolve({ ok: true })
  )
}

function mountBar ({ routeName = 'todo-list-today', whiteNoiseAudio = '', updateOk = true } = {}) {
  const Vue = require('vue')
  const Vuex = require('vuex')
  const Comp = loadBarComponent()
  Comp.template = barTemplate // full build of vue (compile available) renders the SFC template
  const calls = { updates: [] }
  const store = Vuex.createStore({
    state: {
      tomato: { status: 'default' },
      settings: { whiteNoiseAudio, dailyTomatoTarget: 8 },
      todo: { views: { todayTodoList: [] }, todoList: [] }
    },
    actions: {
      'settings/update' (ctx, patch) {
        calls.updates.push(patch)
        return updateOk ? Promise.resolve({ ok: true }) : Promise.resolve({ ok: false, error: new Error('ipc down') })
      }
    }
  })
  const app = Vue.createApp(Comp)
  app.use(store)
  app.config.globalProperties.$route = { name: routeName }
  app.config.globalProperties.$t = key => key
  app.component('app-icon', { template: '<i/>' })
  const host = globalThis.document.createElement('div')
  globalThis.document.body.appendChild(host)
  const vm = app.mount(host)
  return { vm, calls, host }
}

const q = (vm, sel) => vm.$el.querySelector(sel)

test('[B1] the full (today-view) bar renders the ♪ noise toggle; the slim variant does not', () => {
  const { vm } = mountBar()
  try {
    assert.ok(q(vm, '.tb-noise-toggle'), 'noise toggle rendered on todo-list-today')
    assert.match(q(vm, '.tb-noise-toggle').getAttribute('aria-expanded'), /false/)
  } finally { vm.$.appContext.app.unmount() }
  const slim = mountBar({ routeName: 'stats-view' })
  try {
    assert.equal(q(slim.vm, '.tb-noise-toggle'), null, 'slim variant must not render the noise toggle')
  } finally { slim.vm.$.appContext.app.unmount() }
})

test('[B2] clicking the toggle opens the chip popover: none chip + the NOISES registry entries', async () => {
  const { vm } = mountBar()
  try {
    q(vm, '.tb-noise-toggle').click()
    await vm.$nextTick()
    const pop = q(vm, '.tb-noise-pop')
    assert.ok(pop, 'popover opens on click')
    const chips = [...pop.querySelectorAll('.tb-noise__item')]
    assert.equal(chips.length, 3, 'none + 2 registry noises')
    assert.match(chips[0].textContent, /noiseNone/, 'first chip is the no-playback option')
    assert.match(chips[0].className, /\bon\b/, 'with an empty whiteNoiseAudio the none chip is marked on')
  } finally { vm.$.appContext.app.unmount() }
})

test('[B3] picking a chip writes settings.whiteNoiseAudio and closes; a failed write keeps the popover open', async () => {
  const ok = mountBar()
  try {
    ok.vm.toggleNoise()
    await ok.vm.$nextTick()
    const chips = [...ok.vm.$el.querySelectorAll('.tb-noise__item')]
    chips[1].click() // 'rain'
    await ok.vm.$nextTick()
    await Promise.resolve()
    assert.deepEqual(ok.calls.updates, [{ whiteNoiseAudio: 'rain' }], 'settings/update carries the picked id')
    await ok.vm.$nextTick()
    assert.equal(q(ok.vm, '.tb-noise-pop'), null, 'popover collapses after a successful pick')
  } finally { ok.vm.$.appContext.app.unmount() }

  const fail = mountBar({ updateOk: false })
  try {
    fail.vm.toggleNoise()
    await fail.vm.$nextTick()
    ;[...fail.vm.$el.querySelectorAll('.tb-noise__item')][1].click()
    await Promise.resolve()
    await fail.vm.$nextTick()
    assert.ok(q(fail.vm, '.tb-noise-pop'), 'popover stays open when the write reports {ok:false}')
  } finally { fail.vm.$.appContext.app.unmount() }
})

test('[B4] Escape and outside clicks close the popover; reflect the current whiteNoiseAudio selection', async () => {
  const { vm } = mountBar({ whiteNoiseAudio: 'whitenoise' })
  try {
    vm.toggleNoise()
    await vm.$nextTick()
    assert.ok(q(vm, '.tb-noise__item.on'), 'current selection chip marked on')
    vm.toggleNoise() // close again so the Escape leg exercises a real open→close transition
    await vm.$nextTick()
    globalThis.document.dispatchEvent(new globalThis.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await vm.$nextTick()
    assert.equal(q(vm, '.tb-noise-pop'), null, 'Escape closes the popover')

    vm.toggleNoise()
    await vm.$nextTick()
    globalThis.document.body.dispatchEvent(new globalThis.Event('click', { bubbles: true }))
    await vm.$nextTick()
    assert.equal(q(vm, '.tb-noise-pop'), null, 'outside click closes the popover')

    vm.toggleNoise()
    await vm.$nextTick()
    q(vm, '.tb-noise-pop').dispatchEvent(new globalThis.Event('click', { bubbles: true }))
    await vm.$nextTick()
    assert.ok(q(vm, '.tb-noise-pop'), 'a click inside the popover does not close it')
  } finally { vm.$.appContext.app.unmount() }
})
