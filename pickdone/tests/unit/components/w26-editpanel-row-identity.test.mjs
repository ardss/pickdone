/**
 * W26 renderer fixes — row identity in EditPanel subtasks + reminder rows.
 *
 * Fix 1 (P2): EpSubtasks inline rename/delete/move used to pass a captured INDEX across events.
 * While the rename editor was open, an earlier row could be removed (✕) or drag-moved
 * (subtaskOps Sortable onEnd splice) or the whole list re-hydrated (LAN echo rebuild) — the
 * index then pointed at a DIFFERENT row and the committed text landed on the wrong subtask.
 * Now every op carries the row object and the parent resolves it by the stable `_key`
 * (minted by EditPanel on hydrate/add); the v-for fell back to `text + '_' + i` and now uses
 * pure `_key`.
 *
 * Fix 2 (P3): EpReminders v-for used `:key="i"` while rows host stateful el-date/el-time
 * pickers — removing a middle row shifted the indexes and Vue reused picker instances across
 * rows, showing the wrong row's value. Rows now carry an auto-increment `_id` used as the key
 * (EpSubtasks `_key` pattern).
 *
 * Both tests drive the REAL method bodies extracted from the SFC sources (w24 precedent).
 *
 * Run: node --test tests/unit/components/w26-editpanel-row-identity.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const SUB_SRC = readFileSync(path.join(ROOT, 'renderer/js/components/edit-panel/EpSubtasks.vue'), 'utf8')
const PANEL_SRC = readFileSync(path.join(ROOT, 'renderer/js/components/EditPanel.vue'), 'utf8')
const REMIND_SRC = readFileSync(path.join(ROOT, 'renderer/js/components/edit-panel/EpReminders.vue'), 'utf8')

/** Extract a method body from an SFC <script> source. Handles one-liners
 *  (`delSub (s) { ... },`) AND multi-line methods (closing `    },` at 4-space indent):
 *  alt 1 = same-line `},` before any newline; alt 2 = a lone `    },` line. Nested 6+-space
 *  `},` lines inside extracted bodies (EditPanel delSub's undo callbacks) don't match alt 2. */
function extractMethod (src, name, sig, inject = []) {
  const m = src.match(new RegExp('    ' + name + ' \\(([^)]*)\\) \\{(?:([^\\n]*?)\\},\\r?\\n|([\\s\\S]*?)\\r?\\n    \\},)'))
  assert.ok(m, `method ${name} not found in source`)
  assert.equal(m[1].trim(), sig.join(', '), `signature drift on ${name}`)
  // eslint-disable-next-line no-new-func
  return new Function(...sig, ...inject, m[2] != null ? m[2] : m[3])
}

const K = (id, text, checked = false) => ({ _key: id, text, checked })

/** Fake EditPanel host: the extracted handlers run against this `this`. */
function makePanelHost (subs) {
  const patches = []
  const undoCalls = []
  const removeWithUndo = (self, doRemove, undo) => { undoCalls.push(undo); doRemove() }
  const host = {
    subList: subs,
    $t: k => k,
    $announce: null,
    markDirty () {},
    queueSave (p) { patches.push(p) }
  }
  const fns = {
    _subIndexByKey: extractMethod(PANEL_SRC, '_subIndexByKey', ['sub']),
    delSub: extractMethod(PANEL_SRC, 'delSub', ['sub'], ['removeWithUndo']),
    moveSub: extractMethod(PANEL_SRC, 'moveSub', ['sub', 'dir']),
    renameSub: extractMethod(PANEL_SRC, 'renameSub', ['sub', 'text'])
  }
  const hostWithHelpers = host
  hostWithHelpers._subIndexByKey = fns._subIndexByKey
  return {
    host, patches, undoCalls,
    delSub (s) { fns.delSub.call(host, s, removeWithUndo) },
    undoLast () { const u = undoCalls[undoCalls.length - 1]; assert.ok(u, 'no undo captured'); u.call(host) },
    moveSub (s, d) { fns.moveSub.call(host, s, d) },
    renameSub (s, t) { fns.renameSub.call(host, s, t) }
  }
}

/** Fake EpSubtasks vm whose emits route into the REAL panel host handlers (exactly the EditPanel
 *  template wiring: @remove="delSub" @move="moveSub" @rename="renameSub"). */
function makeSubtasksHarness (subs) {
  const panel = makePanelHost(subs)
  const roleButtonActivate = (fn) => (e) => { e.preventDefault(); fn() }
  const emitted = []
  const vm = {
    subs: panel.host.subList,
    renameKey: -1,
    renameText: '',
    $el: null,
    $nextTick (fn) { fn() },
    $emit (ev, ...args) {
      emitted.push([ev, ...args])
      if (ev === 'remove') panel.delSub(args[0])
      else if (ev === 'move') panel.moveSub(args[0], args[1])
      else if (ev === 'rename') panel.renameSub(args[0], args[1])
    }
  }
  const fns = {
    startRename: extractMethod(SUB_SRC, 'startRename', ['s']),
    commitRename: extractMethod(SUB_SRC, 'commitRename', ['s']),
    delSub: extractMethod(SUB_SRC, 'delSub', ['s']),
    moveSub: extractMethod(SUB_SRC, 'moveSub', ['s', 'dir']),
    onTextKey: extractMethod(SUB_SRC, 'onTextKey', ['s', 'e'], ['roleButtonActivate'])
  }
  return {
    vm, panel, emitted,
    startRename (s) { fns.startRename.call(vm, s) },
    commitRename (s) { fns.commitRename.call(vm, s) },
    delSub (s) { fns.delSub.call(vm, s) },
    moveSub (s, d) { fns.moveSub.call(vm, s, d) },
    onTextKey (s, e) { fns.onTextKey.call(vm, s, e, roleButtonActivate) },
    renameHost: panel
  }
}

test('w26 fix1: 重命名期间上方行被删除 — commitRename 按 _key 落在正确行(不再串行)', () => {
  const a = K(1, 'alpha'); const b = K(2, 'beta'); const c = K(3, 'gamma')
  const h = makeSubtasksHarness([a, b, c])
  h.startRename(b) // editor open on "beta"
  assert.equal(h.vm.renameKey, 2, 'the editor tracks the row by _key')
  assert.equal(h.vm.renameText, 'beta')
  h.delSub(a) // an earlier row is removed mid-edit — the old index-based code would now target a
  h.vm.renameText = 'beta-renamed'
  h.commitRename(b)
  assert.equal(h.vm.subs[0].text, 'beta-renamed', 'the rename lands on the SAME row (now row 0)')
  assert.equal(h.vm.subs[0]._key, 2, 'identity preserved: it is the beta row')
  assert.ok(!h.emitted.some(e => e[0] === 'rename' && typeof e[1] === 'number'), 'rename emit carries the row object, never an index')
})

test('w26 fix1: 重命名期间整表 re-hydrate(LAN echo,行对象全部换新)— 按 _key 仍写中新行', () => {
  const a = K(1, 'alpha'); const b = K(2, 'beta')
  const h = makeSubtasksHarness([a, b])
  h.startRename(b)
  // hydrate(true) deep-copies the store list: same _keys, brand-new row objects
  const b2 = K(2, 'beta')
  h.panel.host.subList = [K(1, 'alpha'), b2]
  h.vm.subs = h.panel.host.subList
  h.vm.renameText = 'beta-v2'
  h.commitRename(b) // the OLD (pre-hydrate) row object — only its _key is still meaningful
  assert.equal(h.panel.host.subList[1].text, 'beta-v2', 'the new row object gets the text')
  assert.equal(h.panel.host.subList[1]._key, 2)
})

test('w26 fix1: 行内删除/移动按 _key 定位;undo 亦按 _key 归位', () => {
  const a = K(1, 'alpha'); const b = K(2, 'beta'); const c = K(3, 'gamma')
  const h = makeSubtasksHarness([a, b, c])
  h.moveSub(c, -1) // move gamma up: [alpha, gamma, beta]
  assert.deepEqual(h.panel.host.subList.map(s => s._key), [1, 3, 2], 'move resolves the row by _key')
  h.delSub(h.panel.host.subList[1]) // delete the middle (gamma)
  assert.deepEqual(h.panel.host.subList.map(s => s._key), [1, 2], 'delete splices the right row')
  h.panel.undoLast() // gamma's _key is no longer in the list → re-inserted at the clamped end (P2 precedent)
  assert.deepEqual(h.panel.host.subList.map(s => s._key), [1, 2, 3], 'undo restores the deleted row object')
  assert.equal(h.panel.host.subList[2], c, 'the re-inserted row is the SAME object (its _id/_key identity survives)')
})

test('w26 fix1: 不存在的 _key 是安全 no-op;v-for 使用纯 _key(索引回退已移除)', () => {
  const h = makeSubtasksHarness([K(1, 'alpha')])
  h.panel.renameSub(K(999, 'ghost'), 'nope') // stale row whose _key vanished from the list
  assert.equal(h.panel.host.subList[0].text, 'alpha', 'ghost rename does not touch any row')
  h.moveSub(K(999, 'ghost'), -1)
  assert.equal(h.panel.host.subList.length, 1, 'ghost move is a no-op')
  // template contract: pure `_key` key, no `text + '_' + i` fallback
  assert.match(SUB_SRC, /:key="s\._key"/)
  assert.ok(!SUB_SRC.includes("s.text + '_' + i"), 'the text+index fallback key is gone')
  assert.ok(!SUB_SRC.includes('renameIndex'), 'rename state is keyed by _key, not index')
})

test('w26 fix2: 提醒行铸造自增 _id 作 v-for key(中间删行不再复用 picker 实例)', async () => {
  // template contract
  assert.match(REMIND_SRC, /:key="r\._id"/)
  assert.ok(!/:key="i"/.test(REMIND_SRC), 'the bare index key is gone')
  // real minting paths
  const core = await import(pathToFileURL(path.join(ROOT, 'renderer/js/utils/core.js')).href)
  const dayjs = core.dayjs; const FMT = core.FMT
  const DAY = dayjs().add(1, 'day').startOf('day').valueOf()
  const vm = {
    remindRowSeq: 0,
    task: { taskId: 't1', dateTs: DAY, remindTs: 0, reminderExtra: [] },
    today0: dayjs().startOf('day').valueOf(),
    defaultRemindTime () { return '09:00' },
    remindOpen: false,
    remindRows: []
  }
  const toggle = extractMethod(REMIND_SRC, 'toggleRemind', [])
  const addRow = extractMethod(REMIND_SRC, 'addRemindRow', [], ['mmToHHmm'])
  const mmToHHmm = m => m // one-liner shim: already 'HH:mm' in this fixture
  toggle.call(vm) // no persisted reminders: one default row minted
  assert.equal(vm.remindRows.length, 1)
  assert.equal(typeof vm.remindRows[0]._id, 'number', 'the default row carries a minted _id')
  addRow.call(vm, mmToHHmm); addRow.call(vm, mmToHHmm)
  const ids = vm.remindRows.map(r => r._id)
  assert.equal(new Set(ids).size, 3, 'every row has a UNIQUE minted _id')
  // undo re-insert keeps the row object (and its _id) — key stability across undo
  vm.remindRows.splice(1, 1)
  addRow.call(vm, mmToHHmm)
  assert.equal(vm.remindRows[2]._id, ids[2] + 1, 'new rows keep the monotonic seq (no id reuse)')
  // _id is render-only: commit output carries pure timestamps
  const commit = extractMethod(REMIND_SRC, 'commitReminders', [], ['dayjs', 'FMT'])
  const out = []
  vm.$emit = (ev, a, b) => { if (ev === 'commit') out.push([a, b]) }
  commit.call(vm, dayjs, FMT)
  assert.equal(out.length, 1)
  assert.equal(typeof out[0][0], 'number', 'the main reminder timestamp is a pure number')
  assert.ok(out[0][1].every(ts => typeof ts === 'number'), 'the extra reminders are pure timestamps (no _id leak)')
  void FMT
})
