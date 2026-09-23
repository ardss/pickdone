/**
 * Domain 4 maintenance round (maint/dw wave 2026-09-23) — shortcut pipeline + UI reachability.
 * Behavior tests for F-D1 (sync dispatched via the inApp before-input-event table), F-D3
 * (capture-suppression flag suspends dispatch while recording) and unit tests for F-D7
 * (moveWithUndo observes apply/revert rejections). F-D2/F-D5/F-D6 are pinned as source-shape
 * assertions (the guard lives inline in the renderer bootstrap, which has no unit harness).
 * Run: node --test tests/unit/main/dw4-shortcut-pipeline.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
/** Source with comment-only lines stripped — assertions on CODE shape, not prose. */
const code = p => read(p).split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n')

/** Build a shortcuts module + fake window, and hand back the captured before-input-event handler. */
function setupShortcuts () {
  const require_ = createRequire(import.meta.url)
  const sent = []
  const prevented = []
  let beforeInput = null
  const ipcHandlers = {}
  const electronStub = {
    globalShortcut: { register: () => true, unregisterAll: () => {} },
    ipcMain: { on: (ch, h) => { ipcHandlers[ch] = h } }
  }
  const Module = require_('module')
  const resolved = require_.resolve(path.join(ROOT, 'src/main/shortcuts.js'))
  delete require_.cache[resolved]
  const origLoad = Module._load
  Module._load = function (request, parent, isMain) {
    if (request === 'electron') return electronStub
    return origLoad.call(this, request, parent, isMain)
  }
  let mod
  try {
    mod = require_(resolved)
  } finally { Module._load = origLoad }
  const webContents = {
    on: (ev, h) => { if (ev === 'before-input-event') beforeInput = h },
    removeAllListeners: () => {},
    send: (ch, payload) => sent.push([ch, payload])
  }
  const win = { isDestroyed: () => false, webContents }
  const api = mod.createShortcuts({
    getMainWindow: () => win,
    showMainOrLock: () => {},
    quickAdd: { toggle: () => {} },
    i18n: { mt: k => k },
    log: { warn: () => {} }
  })
  api.applyShortcuts({
    sync: 'ctrl+s', deleteEvent: 'ctrl+d', addEvent: 'ctrl+n', toggleMainWindow: '', quickAddGlobal: ''
  })
  return {
    api, sent, ipcHandlers,
    fire (input) {
      const e = { preventDefault: () => prevented.push(true) }
      beforeInput(e, input)
    },
    get prevented () { return prevented.length }
  }
}

test('F-D1: sync is a dispatched in-app shortcut — ctrl+s reaches the renderer as shortcut-action', () => {
  const s = setupShortcuts()
  s.fire({ type: 'keyboard', control: true, key: 's' })
  assert.deepEqual(s.sent, [['shortcut-action', 'sync']], 'ctrl+s must dispatch the sync action over the same pipeline as the other nine shortcuts')
  assert.equal(s.prevented, 1, 'the combo is consumed (prevents the browser save dialog)')
})

test('F-D1: the renderer no longer hardcodes the Ctrl+S sync branch in its keydown handler', () => {
  const src = code('renderer/js/main.js')
  assert.doesNotMatch(src, /key\.toLowerCase\(\) === 's'/, 'the hardcoded ctrl+s keydown branch is gone; case \'sync\' consumes shortcut-action instead')
  assert.match(src, /case 'sync': runSync\(\)/, 'onShortcutAction dispatches sync through the shared runSync shape')
})

test('F-D2: the deleteEvent dispatch guards against input focus before deleting', () => {
  const src = code('renderer/js/main.js')
  const idx = src.indexOf("case 'deleteEvent'")
  const body = src.slice(idx, src.indexOf("case 'pinEvent'"))
  assert.match(body, /isContentEditable/, 'deleteEvent must compute the inEditor exemption before deleteWithUndo')
  assert.ok(body.indexOf('inEditor') < body.indexOf('deleteWithUndo'), 'the guard precedes the delete')
})

test('F-D6: pin/unpin awaits the dispatch and only toasts success on it; failures get the P3-7 toast', () => {
  const src = code('renderer/js/main.js')
  const idx = src.indexOf('const pinning')
  const body = src.slice(idx, idx + 900)
  assert.match(body, /\.then\(\(\) =>[\s\S]*?\$message\.success/, 'success toast moved inside the then of the dispatch')
  assert.match(body, /\.catch\(e =>[\s\S]*?\$message\.error/, 'a failed upsert shows the honest failure toast')
})

test('F-D3: entering capture mode suppresses shortcut dispatch — no preventDefault, no action, key reaches the recorder', () => {
  const s = setupShortcuts()
  assert.equal(typeof s.ipcHandlers['shortcut-capturing'], 'function', 'main exposes the shortcut-capturing channel')
  s.ipcHandlers['shortcut-capturing']({}, true)
  s.fire({ type: 'keyboard', control: true, key: 'd' })
  assert.equal(s.sent.length, 0, 'no shortcut-action fires while recording (recording ctrl+d must NOT delete the task)')
  assert.equal(s.prevented, 0, 'the combo falls through so the renderer capture listener can record it')
  s.ipcHandlers['shortcut-capturing']({}, false)
  s.fire({ type: 'keyboard', control: true, key: 'd' })
  assert.deepEqual(s.sent, [['shortcut-action', 'deleteEvent']], 'dispatch resumes after recording ends')
})

test('F-D3: the settings tab toggles suppression on capture start/stop', () => {
  const src = code('renderer/js/components/settings/SettingsShortcutsTab.vue')
  assert.match(src, /setShortcutCapturing\(true\)/)
  assert.match(src, /setShortcutCapturing\(false\)/)
})

test('F-D7: moveWithUndo surfaces an apply() rejection instead of faking the moved toast path', async () => {
  global.window = {}
  const { moveWithUndo } = await import('../../../renderer/js/utils/confirm.js')
  const errs = []
  const toasts = []
  const vm = {
    $message: Object.assign(msg => toasts.push(msg), {
      error: m => toasts.push(['error', m]),
      success: m => toasts.push(['success', m]),
      closeAll: () => {}
    })
  }
  const origErr = console.error
  console.error = (...a) => errs.push(a)
  try {
    moveWithUndo(vm, { label: 'moved', apply: () => Promise.reject(new Error('dep-cycle')), revert: () => {} })
    await new Promise(r => setTimeout(r, 10))
    assert.ok(toasts.some(t => Array.isArray(t) && t[0] === 'error' && /dep-cycle/.test(t[1])), 'a rejected apply shows the failure toast instead of being swallowed')
  } finally { console.error = origErr }
})

test('F-D7: a revert() rejection on the undo click gets the failure toast, not an unhandled rejection', async () => {
  global.window = {}
  const { moveWithUndo } = await import('../../../renderer/js/utils/confirm.js')
  const toasts = []
  const vm = {
    $message: Object.assign(() => {}, {
      error: m => toasts.push(['error', m]),
      closeAll: () => {}
    })
  }
  let undoClick = null
  const origCE = console.error
  console.error = () => {}
  // capture the undo link's onClick by stubbing Vue.h
  const origVue = global.window.Vue
  global.window.Vue = { h: (tag, props) => { if (props && props.onClick) undoClick = props.onClick; return { tag, props } } }
  try {
    moveWithUndo(vm, { label: 'moved', apply: () => {}, revert: () => { throw new Error('write-time cycle') } })
    undoClick()
    await new Promise(r => setTimeout(r, 10))
    assert.ok(toasts.some(t => Array.isArray(t) && t[0] === 'error' && /write-time cycle/.test(t[1])), 'revert failure surfaces honestly')
  } finally { console.error = origCE; global.window.Vue = origVue }
})

test('F-D4: the six hint-q marks no longer carry fake-button semantics', () => {
  for (const f of ['renderer/js/components/RepeatModal.vue', 'renderer/js/components/EditPanel.vue', 'renderer/js/components/edit-panel/EpTomato.vue']) {
    const src = read(f)
    assert.doesNotMatch(src, /class="hint-q" role="button"/, `${f} must not advertise role=button with zero activation`)
    if (f !== 'renderer/js/components/EditPanel.vue') assert.match(src, /class="hint-q" role="img"/, `${f} hint-q demoted to role=img`)
  }
  assert.equal(read('renderer/js/components/RepeatModal.vue').match(/hint-q" role="img"/g).length, 4, 'all four RepeatModal marks demoted')
})

test('F-D5: the EditPanel focus guard also fires when activation came from a todo row', () => {
  const src = code('renderer/js/components/EditPanel.vue')
  assert.match(src, /closest\('\.td-item'\)/, 'the keyboard-entry path (focus on a .td-item row) must focus the title')
})
