/**
 * [win-bind RED] Vuex module `winbind` state machine (rendererContract T8).
 *
 * Drives the REAL module with a hand-rolled action context (namespaced-local
 * commit/dispatch applied against the module's own mutations) and a stubbed
 * window.todoAPI — same seam as d12-store-fixes.
 *
 * Run: node --test --test-force-exit tests/unit/renderer/win-bind/winbind-store.test.mjs
 */
import '../../../setup.mjs'
import { test } from '../../../pilot/runner-shim.mjs'
import assert from 'node:assert/strict'

const mod = (await import('../../../../renderer/js/store/winbind.js')).default

/* The node-test VueI18n shim (tests/setup.mjs) merges shard files as FLAT keys but looks them
 * up by dot-splitting a NESTED tree — flat shard keys (every statsJ.* string) fall back to the
 * raw key. Pre-existing shim limitation. Repoint i18n.global.t at the real flat lexicon so the
 * toast-copy assertions below exercise the ACTUAL zh copy. Same module instance the store uses. */
{
  const i18nMod = await import('../../../../renderer/js/i18n/index.js')
  const interp = (tpl, params) => {
    let s = String(tpl)
    if (params) for (const [k, v] of Object.entries(params)) s = s.replaceAll('{' + k + '}', String(v))
    return s
  }
  i18nMod.default.global.t = (k, p) => interp(i18nMod.lookupMessage(k, 'zh-CN') || k, p)
}

/* ---------- harness: namespaced context + todoAPI/appUI stubs ---------- */

function makeCtx ({ todoList = [], state: stOver = {} } = {}) {
  const state = Object.assign(mod.state(), stOver)
  const commits = []
  const ctx = {
    state,
    rootState: { todo: { todoList } },
    commit (type, payload) {
      const fn = mod.mutations[type]
      if (fn) fn(state, payload)
      commits.push({ type, payload })
    },
    async dispatch () {},
    _commits: commits
  }
  return ctx
}

const ipc = []
const toasts = []
function stubApi (impl = {}) {
  ipc.length = 0; toasts.length = 0
  const rec = (name, dflt) => async (...a) => {
    ipc.push([name, ...a])
    return (impl[name] || dflt)(...a)
  }
  // [QA r1 #1/#6] stub keys mirror the REAL preload surface (src/preload/index.js) — the
  // contract-lock test below fails if this stub ever drifts from the exposed names again.
  globalThis.window.todoAPI = {
    winBindIdentify: rec('identify', async () => null),
    winBindBind: rec('bind', async () => null),
    winBindActivate: rec('activate', async () => null),
    winBindUnbind: rec('unbind', async () => null),
    winBindList: rec('list', async () => null)
  }
  globalThis.window.appUI = {
    $message: {
      success: m => toasts.push(['success', m]),
      error: m => toasts.push(['error', m]),
      info: m => toasts.push(['info', m]),
      warning: m => toasts.push(['warning', m])
    }
  }
}
function dropApi () {
  delete globalThis.window.todoAPI
  delete globalThis.window.appUI
}

const REF = { processName: 'notepad', execPath: 'C:\\Windows\\system32\\notepad.exe', title: '*无标题 - 记事本', pidHint: 45504, hwnd: 723854, boundAt: 0 }

test('initFromList hydrates bindings and filters orphan taskIds (deleted tasks)', async () => {
  stubApi({ list: async () => ({ bindings: [{ taskId: 'a', ref: REF }, { taskId: 'gone', ref: { processName: 'x' } }] }) })
  const ctx = makeCtx({ todoList: [{ taskId: 'a' }, { taskId: 'b' }] })
  await mod.actions.initFromList(ctx)
  assert.deepEqual(Object.keys(ctx.state.bindings), ['a'])
  assert.equal(ctx.state.bindings.a.processName, 'notepad')
})

test('initFromList survives a missing API (feature not wired yet) without touching state', async () => {
  dropApi()
  const ctx = makeCtx({ todoList: [{ taskId: 'a' }] })
  await mod.actions.initFromList(ctx)
  assert.deepEqual(ctx.state.bindings, {})
})

test('releaseOutside: identify -> window -> bind ok = SET_BINDING + bound feedback + success toast', async () => {
  stubApi({
    identify: async () => ({ window: REF, reason: null }),
    bind: async (taskId, ref) => ({ ok: true, binding: { taskId, ref } })
  })
  const ctx = makeCtx({ todoList: [{ taskId: 'a' }] })
  await mod.actions.releaseOutside(ctx, 'a')
  assert.deepEqual(ipc.map(c => c[0]), ['identify', 'bind'], 'identify then bind, zero extra IPC')
  assert.equal(ipc[1][1], 'a'); assert.equal(ipc[1][2], REF, 'ref passed through verbatim (identify returnee)')
  assert.equal(ctx.state.bindings.a, REF)
  assert.deepEqual(ctx.state.lastFeedback, { taskId: 'a', kind: 'bound' })
  assert.equal(ctx.state.identifying, null, 'identifying flag cleared')
  assert.equal(toasts.length, 1); assert.equal(toasts[0][0], 'success')
})

test('releaseOutside: bind !ok = bind-failed feedback with reason (never silent)', async () => {
  stubApi({
    identify: async () => ({ window: REF, reason: null }),
    bind: async () => ({ ok: false, reason: 'STALE_REF' })
  })
  const ctx = makeCtx({ todoList: [{ taskId: 'a' }] })
  await mod.actions.releaseOutside(ctx, 'a')
  assert.equal(ctx.state.bindings.a, undefined, 'no binding written on failure')
  assert.deepEqual(ctx.state.lastFeedback, { taskId: 'a', kind: 'bind-failed', reason: 'STALE_REF' })
  assert.equal(toasts[0][0], 'error')
})

test('releaseOutside: window=null across ALL cancel reasons = silent, bind never sent', async () => {
  for (const reason of ['BUTTON_DOWN', 'NO_WINDOW', 'DESKTOP', 'OWN_WINDOW', 'ADAPTER_ERROR', 'TIMEOUT']) {
    stubApi({ identify: async () => ({ window: null, reason }) })
    const ctx = makeCtx({ todoList: [{ taskId: 'a' }] })
    await mod.actions.releaseOutside(ctx, 'a')
    assert.deepEqual(ipc.map(c => c[0]), ['identify'], reason + ': identify only, no bind')
    assert.equal(ctx.state.lastFeedback, null, reason + ': no feedback (silent cancel)')
    assert.equal(toasts.length, 0, reason + ': no toast')
    assert.equal(ctx.state.identifying, null)
  }
})

test('releaseOutside: identify rejection surfaces as bind-failed (F8 doctrine: no silent swallow)', async () => {
  stubApi({ identify: async () => { throw new Error('ipc broken') } })
  const ctx = makeCtx({ todoList: [{ taskId: 'a' }] })
  await mod.actions.releaseOutside(ctx, 'a')
  assert.equal(ctx.state.lastFeedback.kind, 'bind-failed')
  assert.equal(toasts[0][0], 'error')
  assert.equal(ctx.state.identifying, null)
})

test('releaseOutside: missing API = feature off, zero IPC, zero feedback', async () => {
  dropApi()
  const ctx = makeCtx({ todoList: [{ taskId: 'a' }] })
  await mod.actions.releaseOutside(ctx, 'a')
  assert.equal(ctx.state.lastFeedback, null)
  assert.equal(ctx.state.identifying, null)
})

test('activate: ok = activated feedback + success toast', async () => {
  stubApi({ activate: async () => ({ ok: true }) })
  const ctx = makeCtx()
  await mod.actions.activate(ctx, 'a')
  assert.deepEqual(ctx.state.lastFeedback, { taskId: 'a', kind: 'activated' })
  assert.equal(toasts[0][0], 'success')
  assert.equal(ctx.state.activating, null)
})

test('activate: NOT_FOUND and NO_BINDING map to the window-gone copy', async () => {
  for (const reason of ['NOT_FOUND', 'NO_BINDING']) {
    stubApi({ activate: async () => ({ ok: false, reason }) })
    const ctx = makeCtx()
    await mod.actions.activate(ctx, 'a')
    assert.equal(ctx.state.lastFeedback.kind, 'activate-failed')
    assert.equal(ctx.state.lastFeedback.reason, reason)
    assert.equal(toasts[0][0], 'error')
    assert.match(toasts[0][1], /窗口|window/i, reason + ': window-gone copy')
  }
})

test('activate: AMBIGUOUS interpolates the candidate count N', async () => {
  stubApi({ activate: async () => ({ ok: false, reason: 'AMBIGUOUS', candidates: [REF, REF, REF] }) })
  const ctx = makeCtx()
  await mod.actions.activate(ctx, 'a')
  assert.match(toasts[0][1], /3/, 'copy mentions 3 candidates')
})

test('activate: ACTIVATE_FAILED flashes the taskbar copy only when flashed=true', async () => {
  stubApi({ activate: async () => ({ ok: false, reason: 'ACTIVATE_FAILED', flashed: true }) })
  let ctx = makeCtx()
  await mod.actions.activate(ctx, 'a')
  assert.match(toasts[0][1], /闪烁|flash/i)
  stubApi({ activate: async () => ({ ok: false, reason: 'ACTIVATE_FAILED' }) })
  ctx = makeCtx()
  await mod.actions.activate(ctx, 'a')
  assert.match(toasts[0][1], /激活失败|activate/i)
  assert.doesNotMatch(toasts[0][1], /闪烁|flash/i, 'plain failure copy must not mention flashing')
})

test('activate: ADAPTER_ERROR maps to the detection-unavailable copy', async () => {
  stubApi({ activate: async () => ({ ok: false, reason: 'ADAPTER_ERROR' }) })
  const ctx = makeCtx()
  await mod.actions.activate(ctx, 'a')
  assert.match(toasts[0][1], /探测|detection/i)
})

test('unbind: removes the binding, unbound feedback, idempotent when absent', async () => {
  stubApi({ unbind: async () => ({ ok: true, removed: true }) })
  const ctx = makeCtx({ state: { bindings: { a: REF } } })
  await mod.actions.unbind(ctx, 'a')
  assert.equal(ctx.state.bindings.a, undefined)
  assert.deepEqual(ctx.state.lastFeedback, { taskId: 'a', kind: 'unbound' })
  assert.equal(toasts[0][0], 'success')
  // idempotent path: store says removed=false, still ok, still clears local state
  stubApi({ unbind: async () => ({ ok: true, removed: false }) })
  const ctx2 = makeCtx({ state: { bindings: { b: REF } } })
  await mod.actions.unbind(ctx2, 'b')
  assert.equal(ctx2.state.bindings.b, undefined)
  assert.equal(ctx2.state.lastFeedback.kind, 'unbound')
})

test('mutations: PATCH_STATUS drives identifying/activating; SET_FEEDBACK replaces', () => {
  const s = mod.state()
  mod.mutations.PATCH_STATUS(s, { key: 'identifying', value: 'a' })
  assert.equal(s.identifying, 'a')
  mod.mutations.SET_FEEDBACK(s, { taskId: 'a', kind: 'bound' })
  assert.deepEqual(s.lastFeedback, { taskId: 'a', kind: 'bound' })
  mod.mutations.SET_FEEDBACK(s, null)
  assert.equal(s.lastFeedback, null)
})

test('module shape: namespaced, contract state fields present', () => {
  assert.equal(mod.namespaced, true)
  const s = mod.state()
  assert.deepEqual(Object.keys(s).sort(), ['activating', 'bindings', 'identifying', 'lastFeedback'])
  for (const m of ['SET_BINDINGS', 'SET_BINDING', 'REMOVE_BINDING', 'PATCH_STATUS', 'SET_FEEDBACK']) assert.ok(mod.mutations[m], 'mutation ' + m)
  for (const a of ['initFromList', 'releaseOutside', 'activate', 'unbind']) assert.ok(mod.actions[a], 'action ' + a)
})

test('store/index.js registers the winbind module', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../../../../renderer/js/store/index.js', import.meta.url), 'utf8')
  assert.match(src, /import winbind from '\.\/winbind\.js'/)
  assert.match(src, /modules:\s*\{[^}]*\bwinbind\b/)
})

/* [QA r1 #1/#6] Contract lock: the stub above once spelled winBindIdentifyUnderCursor — same
 * wrong name as the store, so 26 cases stayed green while the real preload exposed winBindIdentify
 * and the whole feature was dead in the live app. Lock BOTH sides to the frozen preload surface:
 *   1) preload source actually exposes the six frozen keys;
 *   2) every winBind-family key (incl. onWinBindChanged) the store module calls exists on that surface
 *      (a renamed key in either file fails here instead of shipping a silent outage). */
test('contract lock: store win-bind key usage matches the preload exposed surface', async () => {
  const fs = await import('node:fs')
  const preloadSrc = fs.readFileSync(new URL('../../../../src/preload/index.js', import.meta.url), 'utf8')
  const FROZEN = ['winBindIdentify', 'winBindBind', 'winBindActivate', 'winBindUnbind', 'winBindList', 'onWinBindChanged']
  for (const k of FROZEN) {
    assert.match(preloadSrc, new RegExp('\\b' + k + '\\s*:'), 'preload must expose ' + k + ' (frozen contract)')
  }
  const storeSrc = fs.readFileSync(new URL('../../../../renderer/js/store/winbind.js', import.meta.url), 'utf8')
  const used = new Set()
  for (const m of storeSrc.matchAll(/\ba\.(winBind[A-Za-z]+|onWinBindChanged)\b/g)) used.add(m[1])
  assert.ok(used.size >= 5, 'store references the five IPC keys, saw: ' + [...used].join(','))
  for (const k of used) {
    assert.ok(FROZEN.includes(k), 'store calls ' + k + ' which is NOT in the frozen preload surface (stale or invented key)')
  }
})

test('TodoItem.onDragEnd dispatches winbind/releaseOutside only through the geometry gate', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../../../../renderer/js/components/TodoItem.vue', import.meta.url), 'utf8')
  assert.match(src, /import \{ isReleaseOutsideViewport \} from '\.\.\/utils\/winbindGeometry\.js'/, 'gate imported')
  assert.match(src, /isReleaseOutsideViewport\(e,\s*window\)[^\n]*winbind\/releaseOutside/, 'gated dispatch on the same line')
  // scope freeze: the reorder path must stay untouched
  assert.match(src, /async onDrop \(e\)/, 'onDrop still present')
  assert.match(src, /_writeSort \(list\)/, '_writeSort still present')
})

test('TodoItem mounts WinBindBadge in the meta strip and passes winbind caps to the context menu', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../../../../renderer/js/components/TodoItem.vue', import.meta.url), 'utf8')
  assert.match(src, /import WinBindBadge from '\.\/WinBindBadge\.vue'/)
  assert.match(src, /<WinBindBadge[^>]*:task-id="todo\.taskId"/)
  assert.match(src, /taskContextMenu\([^\n]*winbind:\s*true/, 'ctxMenu opts into winbind menu rows')
})

test('taskMenu buildTaskMenu: window rows only for bound tasks under the winbind cap', async () => {
  globalThis.window.dayjs = globalThis.window.dayjs || (await import('dayjs')).default
  const { buildTaskMenu } = await import('../../../../renderer/js/utils/taskMenu.js')
  const REFb = { processName: 'notepad', execPath: 'x', title: 't', pidHint: 1, hwnd: 2, boundAt: 0 }
  const vm = {
    $t: (k, p) => k + (p ? ':' + JSON.stringify(p) : ''),
    $store: { state: { todo: { todoList: [{ taskId: 'a' }] }, winbind: { bindings: { a: REFb } } }, getters: {} },
    $message: { success () {}, error () {}, info () {}, warning () {} },
    $announce () {}, $prompt: async () => ({ value: '5' })
  }
  const items = buildTaskMenu(vm, { taskId: 'a' }, { winbind: true })
  const labels = items.map(i => i.label || 'sep')
  assert.ok(labels.some(l => /^statsJ\.winbind\.activateMenu/.test(l)), 'activate row present')
  assert.ok(labels.some(l => l === 'statsJ.winbind.unbindMenu'), 'unbind row present')
  // unbound task under the same cap: no winbind rows
  const items2 = buildTaskMenu(vm, { taskId: 'zzz' }, { winbind: true })
  assert.equal(items2.filter(i => i.label && i.label.startsWith('statsJ.winbind')).length, 0)
  // cap off (default, other views): never any winbind rows even when bound
  const items3 = buildTaskMenu(vm, { taskId: 'a' }, {})
  assert.equal(items3.filter(i => i.label && i.label.startsWith('statsJ.winbind')).length, 0)
  // module absent entirely (older stub stores in tests): must not throw
  const vm2 = { ...vm, $store: { state: { todo: { todoList: [{ taskId: 'a' }] } }, getters: {} } }
  assert.doesNotThrow(() => buildTaskMenu(vm2, { taskId: 'a' }, { winbind: true }))
})

test('i18n: statsJ.winbind keys exist paired in zh and en shards', async () => {
  const { lookupMessage } = await import('../../../../renderer/js/i18n/index.js')
  const KEYS = [
    'statsJ.winbind.bound', 'statsJ.winbind.boundFailed', 'statsJ.winbind.activated',
    'statsJ.winbind.notFound', 'statsJ.winbind.ambiguous', 'statsJ.winbind.activateFailed',
    'statsJ.winbind.flashed', 'statsJ.winbind.unbound', 'statsJ.winbind.identifyFailed',
    'statsJ.winbind.adapterUnavailable', 'statsJ.winbind.activateMenu', 'statsJ.winbind.unbindMenu',
    'statsJ.winbind.badgeTip', 'statsJ.winbind.unbindTip'
  ]
  for (const k of KEYS) {
    const zh = lookupMessage(k, 'zh-CN')
    const en = lookupMessage(k, 'en-US')
    assert.ok(typeof zh === 'string' && zh && zh !== k, k + ' missing in zh shard')
    assert.ok(typeof en === 'string' && en && en !== k, k + ' missing in en shard')
  }
})

test('WinBindBadge.vue: click activates, close-x unbinds, renders processName', async () => {
  const fs = await import('node:fs')
  const src = fs.readFileSync(new URL('../../../../renderer/js/components/WinBindBadge.vue', import.meta.url), 'utf8')
  assert.match(src, /ref\.processName/, 'shows processName')
  assert.match(src, /winbind\/activate/, 'click = activate')
  assert.match(src, /winbind\/unbind/, 'x = unbind')
  assert.match(src, /close-x/, 'x reuses the close-x system')
})
