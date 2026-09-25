/**
 * Domain-1 renderer interaction/menu wave (2026-09-25).
 *
 * Covers: A1 crossDayMovePatch convergence on both right-click move paths, A2 FilterModal
 * visibility hoisted into the ui store (+ EditPanel Esc whitelist), A4 honest delete-failure
 * toast, A7/C7 renderer-side upload size pre-check (no IPC), A11 tag word-boundary match,
 * A13 view-more pop clamp, A14 over-limit backfill rejection, A16 ctxMenu single source,
 * C3 RepeatDeleteModal double-confirm guard (real behavior via component-method extraction).
 *
 * Run: node --test tests/unit/renderer/maint-0925-domain1.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

/* ---- env mocks (before renderer imports; no electron, no real %APPDATA%) ---- */
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
if (!globalThis.window) globalThis.window = { location: { hash: '' }, todoAPI: {} }

const dayjsMod = await import('dayjs')
const dayjs = dayjsMod.default
// core.js reads the UMD global (window.dayjs); node tests inject it before importing renderer utils
globalThis.dayjs = dayjs
globalThis.window.dayjs = dayjs
const at = (d, h, m = 0) => +dayjs(d).hour(h).minute(m).second(0).millisecond(0)

/* ================= A1: both right-click move paths go through crossDayMovePatch ================= */

test('A1 taskMenu right-click move: patch carries the translated reminderTime (and keeps time-of-day)', async () => {
  const { buildTaskMenu } = await import('../../../renderer/js/utils/taskMenu.js')
  const oldDay = at('2026-09-10', 0)
  const task = {
    taskId: 't1', taskContent: 'x', dayStart: oldDay,
    todoTime: at('2026-09-10', 14, 30), reminderTime: at('2026-09-10', 8), reminderExtra: [at('2026-09-10', 9)]
  }
  const dispatches = []
  const vm = {
    $t: k => k,
    $store: {
      state: { todo: { todoList: [task] } },
      commit () {},
      dispatch (action, payload) { dispatches.push([action, payload]) }
    },
    $message: { success () {}, error () {}, warning () {} }
  }
  const move = buildTaskMenu(vm, task, { tomato: false }).find(i => i.icon === 'clock' && i.label === 'statsE.TodoItem.postponeToTomorrow')
  assert.ok(move, 'postpone item present')
  move.fn()
  assert.equal(dispatches.length, 1, 'apply dispatched exactly once')
  const [action, { patch }] = dispatches[0]
  assert.equal(action, 'todo/updateTodoFields')
  // postpone = at least tomorrow, pushed from the later of (today, due date); expected values are
  // derived the same way so the test does not depend on the calendar date it runs on
  const newDay = Math.max(+dayjs().add(1, 'day').startOf('day'), at('2026-09-11', 0))
  assert.equal(patch.dayStart, newDay)
  assert.equal(patch.todoTime, newDay + (at('2026-09-10', 14, 30) - oldDay), '14:30 schedule survives the move (used to be wiped to 00:00)')
  assert.equal(patch.reminderTime, newDay + (at('2026-09-10', 8) - oldDay), 'reminder is translated onto the new day, not orphaned on the old one')
  assert.deepEqual(patch.reminderExtra, [newDay + (at('2026-09-10', 9) - oldDay)])
})

test('A1 TodoItem.moveDay path: static anchor — moveDay builds its patch via crossDayMovePatch + matching revert', () => {
  const src = read('renderer/js/components/TodoItem.vue')
  const m = src.match(/moveDay \(offset\) \{[\s\S]*?\n {4}\},/)
  assert.ok(m, 'moveDay method found')
  const body = m[0]
  assert.match(body, /crossDayMovePatch\(cur, target, startOf\)/, 'moveDay uses the shared patch builder')
  assert.match(body, /crossDayRevertPatch\(cur, patch\)/, 'revert restores exactly what the patch touched')
  assert.doesNotMatch(body, /patch: \{ todoTime: target/, 'hand-written { todoTime: target } patch is gone')
})

test('A1 taskMenu move path: static anchor — no hand-written todoTime-only patch remains', () => {
  const src = read('renderer/js/utils/taskMenu.js')
  assert.match(src, /crossDayMovePatch\(cur, target, startOf\)/)
  assert.doesNotMatch(src, /patch: \{ todoTime: target/)
})

/* ================= A2: FilterModal visibility in the ui store + Esc whitelist ================= */

test('A2 ui store: showFilterModal state exists and toggleFilterModal flips it (null = toggle)', async () => {
  const UI = (await import('../../../renderer/js/store/ui.js')).default
  const s = UI.state()
  assert.equal(s.showFilterModal, false, 'defaults closed')
  UI.mutations.toggleFilterModal(s, true)
  assert.equal(s.showFilterModal, true)
  UI.mutations.toggleFilterModal(s, null)
  assert.equal(s.showFilterModal, false, 'null toggles')
})

test('A2 EditPanel global Esc guard honors showFilterModal; FilterView no longer keeps local visibility', () => {
  const ep = read('renderer/js/components/EditPanel.vue')
  assert.match(ep, /ui\.showFilterModal/, 'showFilterModal joined the Esc whitelist')
  const fv = read('renderer/js/views/FilterView.vue')
  assert.match(fv, /showFilterModal \(\) \{ return this\.\$store\.state\.ui\.showFilterModal \}/, 'FilterView reads the store')
  assert.doesNotMatch(fv, /data \(\) \{ return \{ editVisible/, 'local editVisible data is gone')
  assert.match(fv, /ui\/toggleFilterModal/, 'open/close go through the store mutation')
  const ui = read('renderer/js/store/ui.js')
  assert.match(ui, /showFilterModal: false/, 'store declares the flag')
})

/* ================= A4: deleteWithUndo failure surfaces an error toast ================= */

test('A4 deleteWithUndo: rejected dispatch → error toast (moveFailToast style) and false, not silence', async () => {
  const { deleteWithUndo } = await import('../../../renderer/js/utils/confirm.js')
  const msgs = []
  const vm = { $message: { success () {}, error: m => msgs.push(['error', m]) } }
  const store = {
    state: { todo: { recycleList: [] } },
    commit () {},
    dispatch: () => Promise.reject(new Error('db write failed'))
  }
  const r = await deleteWithUndo(vm, store, { taskId: 't1', taskContent: 'x' })
  assert.equal(r, false)
  assert.equal(msgs.length, 1, 'the user sees the failure (the old bare catch swallowed it)')
  // tt() resolves the real locale text in node too (flat-table fallback) — match the appended cause
  assert.match(String(msgs[0][1]), /db write failed/)
})

/* ================= A7/C7: renderer-side upload size pre-check (no arrayBuffer, no IPC) ================= */

test('A7/C7 _uploadOne: 65MB file is rejected with a toast and never reaches arrayBuffer/IPC', async () => {
  const ATT = await import('../../../renderer/js/components/edit-panel/attachments.js')
  let readBuf = false
  let ipcCalled = false
  globalThis.window.todoAPI.uploadAttachment = async () => { ipcCalled = true; return { url: 'x', size: 1 } }
  const big = { name: 'huge.png', type: 'image/png', size: 65 * 1024 * 1024, arrayBuffer: async () => { readBuf = true; return new ArrayBuffer(0) } }
  const msgs = []
  const ctx = {
    e: { taskId: 't1' }, imgList: [], fileList: [],
    markDirty () {}, queueSave () {}, scrollImgsIntoView () {},
    $t: k => k, $message: { error: m => msgs.push(m) }
  }
  await ATT.uploadOne(ctx, 'img', big)
  assert.equal(readBuf, false, 'the 65MB payload is never read into memory')
  assert.equal(ipcCalled, false, 'no IPC upload attempt')
  assert.equal(msgs.length, 1, 'user gets an explicit rejection toast')
  assert.equal(ctx.imgList.length, 0, 'nothing lands in the attachment list')
})

/* ================= A11: QuickAdd route-tag word-boundary match ================= */

test('A11 QuickAdd: exact tag token check (substring like #java in #javascript no longer suppresses)', () => {
  const src = read('renderer/js/components/QuickAdd.vue')
  assert.match(src, /new RegExp\('\(\^\|\\\\s\)#' \+ esc/, 'word-boundary regex replaced the includes() substring check')
  assert.doesNotMatch(src, /!content\.includes\('#' \+ tag\)/)
})

/* ================= A13: view-more pop clamped inside the viewport ================= */

test('A13 ViewMoreMenu: left coordinate is clamped to >= 0', () => {
  const src = read('renderer/js/components/ViewMoreMenu.vue')
  assert.match(src, /Math\.max\(0, Math\.min\(e\.clientX - 190, window\.innerWidth - 220\)\)/)
})

/* ================= A14: over-limit manual backfill rejected with a hint; copy says 1–600 ================= */

test('A14 taskMenu backfill: value above FOCUS_MAX_MINUTES gets a warning toast, no record minted', async () => {
  const { buildTaskMenu } = await import('../../../renderer/js/utils/taskMenu.js')
  const commits = []
  const msgs = []
  const vm = {
    $t: k => k,
    $store: { state: { todo: { todoList: [] }, tomato: {} }, commit (t, p) { commits.push([t, p]) }, dispatch () {} },
    $message: { success () {}, error () {}, warning: m => msgs.push(m) },
    $prompt: () => Promise.resolve({ value: '999' })
  }
  const item = buildTaskMenu(vm, { taskId: 't1' }).find(i => i.label === 'statsG.DayRail.manualAdd')
  assert.ok(item, 'manual backfill item present')
  await item.fn()
  assert.deepEqual(commits, [], 'no tomato record minted for 999 min')
  assert.equal(msgs.length, 1, 'explicit hint instead of a silent clamp to 600')
  const zh = read('renderer/js/i18n/locales/zh-CN-G.js')
  assert.match(zh, /manualPrompt: '输入专注分钟数（1–600）：'/)
  assert.match(zh, /manualInvalid: '请输入 1–600 的数字'/)
})

/* ================= A16: TodoItem ctxMenu built by the shared builder ================= */

test('A16 TodoItem ctxMenu goes through taskContextMenu/buildTaskMenu (no hand-copied item list)', () => {
  const src = read('renderer/js/components/TodoItem.vue')
  const m = src.match(/ctxMenu \(e\) \{[\s\S]*?\n {4}\},/)
  assert.ok(m, 'ctxMenu found')
  assert.match(m[0], /taskContextMenu\(this/, 'menu built by the shared builder')
  assert.doesNotMatch(m[0], /openMenu/, 'no direct hand-rolled openMenu payload')
  assert.match(src, /import \{ taskContextMenu \} from '\.\.\/utils\/taskMenu\.js'/)
})

/* ================= C3: RepeatDeleteModal double-confirm guard (real method, extracted) ================= */

test('C3 concurrent confirm() calls dispatch deleteTodosMany exactly once (single undo snapshot)', async () => {
  // Extract the component's <script> body and load it as a module with stubbed imports —
  // drives the REAL confirm() logic without a .vue loader / electron.
  const src = read('renderer/js/components/RepeatDeleteModal.vue')
  let script = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]
  script = script
    .replace(/^import[\s\S]*?from\s+'[^']*'\s*$/gm, '')
    .replace(/const cleanupOrphanRepeatRule[^\n]*/g, '')
  assert.match(script, /export default/)
  // stub the identifiers the removed imports provided
  globalThis.__d1StubCleanup = async () => {}
  const code = script.replace('export default', 'const dialogA11y = {}; const cleanupOrphanRepeatRule = globalThis.__d1StubCleanup;\nexport default')
  const mod = await import('data:text/javascript,' + encodeURIComponent(code))
  const component = mod.default
  assert.match(src, /:loading="busy"/, 'confirm button shows the busy state')
  assert.match(src.replace(script, ''), /busy/, 'data declares busy') // template/data carry the flag

  const dispatches = []
  const group = [{ taskId: 'a', repeatId: 'r1', dayStart: 1 }, { taskId: 'b', repeatId: 'r1', dayStart: 2 }]
  const makeSelf = () => ({
    mode: 'all', busy: false,
    base: { taskId: 'a', repeatId: 'r1', dayStart: 1, taskContent: 'x' },
    $store: { state: { ui: { showRepeatDeleteConfirm: 'a' } }, dispatch: (a, p) => { dispatches.push([a, p]); return Promise.resolve() } },
    $message: null, // toast layer needs window.Vue; keep the test focused on the dispatch guard
    $createElement: () => ({}),
    $t: k => k,
    close () {}
  })
  const self = makeSelf()
  globalThis.window.todoAPI = { dbCall: async () => group }
  const p1 = component.methods.confirm.call(self)
  const p2 = component.methods.confirm.call(self) // second click while the first is in flight
  await Promise.all([p1, p2])
  const deletes = dispatches.filter(([a]) => a === 'todo/deleteTodosMany')
  assert.equal(deletes.length, 1, 'double click = ONE batch delete (one undo-stack push), not two')
  assert.deepEqual(deletes[0][1], [{ taskId: 'a' }, { taskId: 'b' }])
  assert.equal(self.busy, false, 'busy is released after completion')
})
