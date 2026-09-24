/**
 * EditPanel / renderer behavior regression batch (2026-09-25).
 *
 * The d1-editpanel-knives.test.mjs suite only anchors source shapes — that is exactly how the
 * bugs fixed here slipped through. These tests drive the REAL module code (imported ESM) against
 * mocked DOM/IPC and assert user-visible behavior.
 *
 * Run: node --test tests/unit/components/editpanel-behavior.test.mjs
 */
import '../../setup.mjs'
import { test, mock } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

/* Shared DOM stub (undoToast installs document key listeners when the toast has an $el) */
if (!globalThis.document) {
  globalThis.document = {
    addEventListener () {}, removeEventListener () {},
    querySelector () { return null }, querySelectorAll () { return [] }
  }
}
if (!globalThis.window.Vue) globalThis.window.Vue = {}
globalThis.window.Vue.h = (tag, props) => ({ tag, props })

const ATT = await import('../../../renderer/js/components/edit-panel/attachments.js')
const INTER = await import('../../../renderer/js/components/edit-panel/interactions.js')
const REP = await import('../../../renderer/js/components/edit-panel/repeat.js')
const RMS = await import('../../../renderer/js/utils/editPanelRemoteSync.js')
const ROWEL = await import('../../../renderer/js/utils/todoRowEl.js')
const CONFIRM = await import('../../../renderer/js/utils/confirm.js')
const UI = (await import('../../../renderer/js/store/ui.js')).default
const BACKUP = await import('../../../renderer/js/store/helpers/todoBackup.js')

/* P0-1: paste — DataTransferItemList has no .filter; the old code threw before preventDefault */
function makeItemList (entries) {
  const list = { length: entries.length }
  entries.forEach((en, i) => { list[i] = en })
  return list // deliberately NO array methods — like the real DataTransferItemList
}
function pasteCtx () {
  return {
    e: { taskId: 't1' },
    imgList: [], fileList: [],
    markDirty () {}, queueSave () {},
    scrollImgsIntoView () {},
    $message: { error () {} },
    $t: k => k
  }
}
const pngFile = () => new File(['png-bytes'], 'clip.png', { type: 'image/png' })

test('P0 paste: clipboard image paste no longer throws on DataTransferItemList, preventDefault runs, upload lands', async () => {
  const ctx = pasteCtx()
  let prevented = false
  const uploaded = []
  globalThis.window.todoAPI = { uploadAttachment: async ({ name }) => { uploaded.push(name); return { url: 'att://' + name, size: 9 } } }
  const evt = {
    clipboardData: { items: makeItemList([{ type: 'text/plain' }, { type: 'image/png', getAsFile: pngFile }]) },
    preventDefault: () => { prevented = true }
  }
  await assert.doesNotReject(() => ATT.onDescPaste(ctx, evt), 'the old items.filter TypeError')
  assert.equal(prevented, true, 'preventDefault called (desc textarea must not receive the paste)')
  assert.equal(ctx.imgList.length, 1, 'clipboard image uploaded into the image list')
  assert.equal(uploaded[0], 'clip.png')
})

test('P0 paste: png preferred over coexisting jpeg entries (no duplicate tiles)', async () => {
  const ctx = pasteCtx()
  const mk = t => ({ type: t, getAsFile: () => new File(['x'], 'f.' + t.split('/')[1], { type: t }) })
  globalThis.window.todoAPI = { uploadAttachment: async ({ name }) => ({ url: 'att://' + name, size: 1 }) }
  await ATT.onDescPaste(ctx, {
    clipboardData: { items: makeItemList([mk('image/jpeg'), mk('image/png'), mk('image/bmp')]) },
    preventDefault () {}
  })
  assert.equal(ctx.imgList.length, 1, 'exactly ONE tile from one clipboard image')
  assert.equal(ctx.imgList[0].name, 'f.png', 'png entry wins')
})

/* P0-2: openEdit snapshot fields — single source with the fingerprint vocabulary */
test('P0 snapshot: openEdit carries deadlineTs/priority/important (deadline row + fingerprint vocabulary)', () => {
  const s = UI.state()
  UI.mutations.openEdit(s, {
    taskId: 't2', taskContent: 'a', taskDescribe: 'b', todoTime: 111, reminderTime: 222,
    deadlineTs: 3333333, priority: 3, important: 1, categoryId: 5, repeatId: 'r',
    reminderOffsets: [1], reminderExtra: [2],
    subtasks: '[{"text":"s","checked":false}]', image: '["i1"]', files: '["f1"]'
  })
  const e = s.rightSidebarTodoEdit
  assert.equal(e.deadlineTs, 3333333, 'deadline pill / clear button used to be dead (v-if on e.deadlineTs)')
  assert.equal(e.priority, 3, 'prio buttons read task.priority')
  assert.equal(e.important, 1, 'quadrant importance ledger')
  // the actual P0: own-save-echo fingerprint parity — panel snapshot and live row must agree
  const row = { taskContent: 'a', taskDescribe: 'b', todoTime: 111, reminderTime: 222, deadlineTs: 3333333, priority: 3, important: 1, categoryId: 5 }
  assert.equal(RMS.contentFingerprint(e), RMS.contentFingerprint(row),
    'panel-side fingerprint must equal the DB-row-side fingerprint, or shouldRefreshRemote cry-wolves')
})

test('P0 snapshot shape: openEdit keys ⊇ fingerprint keys ∪ every e.* field EditPanel reads', () => {
  const s = UI.state()
  UI.mutations.openEdit(s, { taskId: 'x' })
  const snapKeys = Object.keys(s.rightSidebarTodoEdit)
  for (const k of RMS.FINGERPRINT_PANEL_KEYS) assert.ok(snapKeys.includes(k), 'fingerprint key missing from snapshot: ' + k)
  // every e.<field> the component consumes (template + methods) must exist in the snapshot vocabulary
  const src = read('renderer/js/components/EditPanel.vue')
  const consumed = new Set()
  for (const m of src.matchAll(/\be\.([A-Za-z_$][\w$]*)/g)) consumed.add(m[1])
  // event-parameter fields and post-hydration-only fields are not snapshot vocabulary
  const whitelist = new Set(['target', 'clipboardData', 'dataTransfer', 'preventDefault', 'predecessors', 'key', 'message']) // message: catch-block e.message
  const missing = [...consumed].filter(k => !whitelist.has(k) && !snapKeys.includes(k))
  assert.deepEqual(missing, [], 'EditPanel reads e.* fields the openEdit snapshot never provides')
})

/* P1-3: attachment disk deletion must respect the hover-paused undo toast */
function toastHost () {
  const listeners = {}
  const el = { addEventListener: (t, fn) => { listeners[t] = fn }, removeEventListener () {}, setAttribute () {} }
  let closeCalls = 0
  const msg = {
    $el: el,
    close () { closeCalls++ },
    get closeCalls () { return closeCalls }
  }
  const vm = { $message (opts) { msg.opts = opts; return msg } }
  return { msg, listeners, vm }
}
const clickUndo = msg => {
  const link = msg.opts.message.props.find(c => c && c.props && c.props.onClick)
  link.props.onClick()
}

test('P1 disk-delete: deletion fires only after the toast closes; hover past the old 5.5s deadline still undoes losslessly', async () => {
  const t = mock.timers
  t.enable({ apis: ['setTimeout'] })
  try {
    let deleted = 0
    const { msg, listeners, vm } = toastHost()
    let undone = false
    CONFIRM.removeWithUndo(vm,
      () => {},
      () => { undone = true },
      { onDismiss: () => { if (!undone) deleted++ } })
    // user hovers the toast (timer paused) for a long time — past the old 5.5s disk deadline
    t.tick(2000)
    listeners.mouseenter()
    t.tick(10_000)
    // clicks 撤销 while still hovering, then leaves
    clickUndo(msg)
    assert.equal(undone, true, 'undo callback ran')
    listeners.mouseleave()
    t.tick(5_000) // toast finally expires — onDismiss fires but the undone flag guards the disk
    assert.equal(deleted, 0, 'hover >5.5s then undo must NOT lose the file (old bug: fixed 5.5s setTimeout already deleted it)')
  } finally { t.reset() }
})

test('P1 disk-delete: without undo, onDismiss fires exactly once when the toast auto-dismisses', async () => {
  const t = mock.timers
  t.enable({ apis: ['setTimeout'] })
  try {
    let dismissed = 0
    const { msg, vm } = toastHost()
    CONFIRM.removeWithUndo(vm, () => {}, () => {}, { onDismiss: () => { dismissed++ } })
    t.tick(5_000)
    assert.equal(dismissed, 1, 'deletion happens after the toast closes (not on a parallel fixed timer)')
    assert.equal(msg.closeCalls >= 0, true)
    t.tick(60_000)
    assert.equal(dismissed, 1, 'never twice')
  } finally { t.reset() }
})

/* P1-4: refocusRow locator — Vue3 channel + data attribute */
test('P1 refocus: findTaskRowEl resolves rows via __vueParentComponent (Vue3) and data-task-id', () => {
  const row = { __vue__: null, __vueParentComponent: { ctx: { todo: { taskId: 't9' } } } }
  globalThis.document.querySelector = sel => (sel.includes('data-task-id="t9"') ? null : null) // fast path misses
  globalThis.document.querySelectorAll = () => [row]
  assert.equal(ROWEL.findTaskRowEl('t9'), row, 'Vue2-only __vue__ probe used to miss — Vue3 channel must find it')
  // data-attribute fast path
  const direct = { focus () {} }
  globalThis.document.querySelector = sel => (sel.includes('data-task-id="t7"') ? direct : null)
  assert.equal(ROWEL.findTaskRowEl('t7'), direct)
  assert.equal(ROWEL.findTaskRowEl(null), null)
  assert.equal(ROWEL.findTaskRowEl('nope'), null, 'unknown id falls through to the scroll-container fallback')
})

/* P2 batch */
test('P2 cat dropdown: clicking the header row closes the pop (mousedown-close no longer re-toggles)', () => {
  const header = { contains: t => t === 'header-target' }
  const ctxOpen = { $el: { querySelector: sel => sel === '.ep-cat-row' ? header : null }, catOpen: true }
  INTER.catOutsideClose(ctxOpen, { target: 'header-target' })
  assert.equal(ctxOpen.catOpen, true, 'header click is NOT an outside close; the row click toggle owns it')
  INTER.catOutsideClose(ctxOpen, { target: 'elsewhere' })
  assert.equal(ctxOpen.catOpen, false, 'genuine outside clicks still close')
  const ctxClosed = { $el: { querySelector: () => header }, catOpen: false }
  INTER.catOutsideClose(ctxClosed, { target: 'header-target' })
  assert.equal(ctxClosed.catOpen, false, 'closed pop stays closed on header hover-mousedown')
})

test('P2 repeat: failed group query resets repeatCount to 0 (no stale count from the previous task) and warns', async () => {
  const warns = []
  const origWarn = console.warn
  console.warn = (...a) => warns.push(a.join(' '))
  globalThis.window.todoAPI = { dbCall: async () => { throw new Error('ipc down') } }
  const ctx = { e: { taskId: 't1', repeatId: 'r1' }, repeatCount: 7 }
  try { await REP.repeatGroupInfo(ctx) } finally { console.warn = origWarn }
  assert.equal(ctx.repeatCount, 0, 'old silent catch kept the previous task count visible')
  assert.ok(warns.length === 1 && /repeatGroupInfo/.test(warns[0]), 'failure is no longer silent')
})

test('P2 pickFiles: multiple selection uploads strictly in order (await between uploadOne calls)', async () => {
  const events = []
  globalThis.window.todoAPI = {
    uploadAttachment: async ({ name }) => {
      events.push('start:' + name)
      await new Promise(r => setTimeout(r, 5))
      events.push('end:' + name)
      return { url: 'att://' + name, size: 1 }
    }
  }
  try {
    const fakeInput = { type: '', multiple: false, files: [new File(['1'], 'a.png', { type: 'image/png' }), new File(['2'], 'b.png', { type: 'image/png' })], click () {} }
    const origCreate = globalThis.document.createElement
    globalThis.document.createElement = tag => tag === 'input' ? fakeInput : origCreate.call(globalThis.document, tag)
    try {
      const ctx = pasteCtx()
      const p = ATT.pickFiles(ctx, 'img')
      await fakeInput.onchange()
      await p
    } finally { globalThis.document.createElement = origCreate }
    assert.deepEqual(events, ['start:a.png', 'end:a.png', 'start:b.png', 'end:b.png'],
      'the old fire-and-forget loop raced both uploads out of pick order')
  } finally { /* real timers */ }
})

test('P2 drop: non-image files land in the file list instead of being silently swallowed', async () => {
  const ctx = pasteCtx()
  globalThis.window.todoAPI = { uploadAttachment: async ({ name }) => ({ url: 'att://' + name, size: 1 }) }
  const png = new File(['p'], 'pic.png', { type: 'image/png' })
  const txt = new File(['t'], 'notes.txt', { type: 'text/plain' })
  await ATT.onDescDrop(ctx, { dataTransfer: { files: [png, txt] } })
  assert.equal(ctx.imgList.length, 1)
  assert.equal(ctx.fileList.length, 1, 'txt file used to vanish without a word')
  assert.equal(ctx.fileList[0].name, 'notes.txt')
})

test('P2 undo placement: delSub/removeFile undo relocates by item reference (indexOf), not a captured index', () => {
  const src = read('renderer/js/components/EditPanel.vue')
  const delSub = src.slice(src.indexOf('delSub (i)'), src.indexOf('moveSub (i, dir)'))
  assert.match(delSub, /this\.subList\.indexOf\(sub\)/, 'undo must locate the row by reference')
  assert.ok(!/splice\(i,/.test(delSub), 'captured index splices misplace out-of-order undos')
  const rm = src.slice(src.indexOf('removeFile (arrName, idx)'), src.indexOf('delTask ()'))
  assert.match(rm, /this\[arrName\]\.indexOf\(item\)/, 'attachment undo must locate by reference too')
})

test('P2 hydrate dedup: same taskId+visible skips the second hydrate; close clears the key; internal refresh forces', () => {
  const src = read('renderer/js/components/EditPanel.vue')
  assert.match(src, /hydrate \(force\) \{[\s\S]*?if \(!force && this\._hydKey === key\) return/, 'dedup guard present')
  assert.match(src, /this\._hydKey = null/, 'panel close forgets the key (reopen re-hydrates)')
  assert.match(src, /refreshFromStore \(\) \{[\s\S]*?this\.hydrate\(true\)/, 'manual refresh forces past the dedup')
  assert.match(src, /this\.hydrate\(true\) \/\/ pristine/, 'silent peer-adoption hydrate forces past the dedup')
})

test('P2 FilterView: filter deletion failure surfaces $message.error and does not navigate away', () => {
  const src = read('renderer/js/views/FilterView.vue')
  const fn = src.slice(src.indexOf('async delFilter ()'), src.indexOf('saved (id)'))
  assert.match(fn, /try \{[\s\S]*?filters\/remove[\s\S]*?\} catch \(e\) \{[\s\S]*?\$message\.error/)
  assert.match(fn, /return\s*\}\s*this\.\$router\.replace/, 'navigation only on success')
})

test('P2 todoBackup: degraded host (no todoAPI) reports ok=false instead of a bare undefined', async () => {
  const saved = globalThis.window.todoAPI
  delete globalThis.window.todoAPI
  try {
    const r = await BACKUP.writeAutoBackupCore({}, { state: {}, rootState: { settings: {} } })
    assert.equal(r, false, 'SettingsDataTab branches on ok === false — undefined read as success')
  } finally { globalThis.window.todoAPI = saved }
})

test('P2 template wiring: cat pop uses the guarded outside handler; locator import present', () => {
  const src = read('renderer/js/components/EditPanel.vue')
  assert.match(src, /v-click-outside="onCatOutside"/)
  assert.match(src, /import \{ findTaskRowEl \} from '\.\.\/utils\/todoRowEl\.js'/)
})
