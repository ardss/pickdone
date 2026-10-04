/**
 * [D17-DOM3 fixes — renderer store/views/components, 2026-10-02]
 * F1  EditPanel.restoreFromBin goes through the single todo/restoreFromRecycle entry
 *     (stale deletedAt + missing chip snapshot backfill + missing B5 guard are gone)
 * F2  undo.js persistSnapshotDiffCore: undo-of-create soft delete stamps deletedAt
 *     (same as deleteTodo/deleteTodosMany — purgeExpiredRecycle ages rows from it)
 * F3  purgeIds/purgeAllRecycle commit historyBarrier (comment/code agreement, no
 *     historyClear left on the purge paths)
 * F4  TodayXView shows the running rest phase instead of an idle preview + lying Start
 * F5  confirm.js restoreAndToast: undo-of-delete awaits the dispatch; success toast only
 *     on success, honest error toast on failure. RepeatDeleteModal undo observes failures.
 * F6  SettingsSyncTab.connectPeer warns inline on a malformed address (no silent return)
 * F7  RecycleBinView.purgeConfirm falls back to the untitled label
 * F8  FeedbackModal attach-log checkbox renders unchecked+disabled (nothing attaches)
 * F9  QuickAdd bulk-paste toast names the target date (chip/today/inbox)
 * F10 EpReminders refuses to silently anchor a dateless row to TODAY
 * Run: node --test tests/unit/renderer/d17-dom3-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// Minimal window shim BEFORE the module imports: the renderer's utils read dayjs/i18n from UMD
// globals with a deferred error (audit S4); these tests never touch date formatting, so the full
// tests/setup.mjs (which requires the dayjs npm package) is not needed here.
if (!globalThis.window) globalThis.window = {}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const url = p => 'file://' + path.join(ROOT, p).replace(/\\/g, '/')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

/* ---------------- F2: deletedAt on the undo-of-create soft delete (behavior) ---------------- */

test('F2: persistSnapshotDiffCore stamps deletedAt (= updateTime) on the undo-of-create soft delete', async () => {
  const mod = await import(url('renderer/js/store/helpers/undo.js'))
  const commits = []
  const ups = []
  const before = { todoList: [{ taskId: 'a', taskContent: 'x', updateTime: 1 }], recycleList: [] }
  const after = { todoList: [], recycleList: [] }
  const changed = await mod.persistSnapshotDiffCore(
    { commit: (k, v) => commits.push([k, v]) },
    { from: before, to: after },
    r => ups.push(r)
  )
  assert.equal(changed.length, 1, 'the vanished row is soft-deleted')
  const merged = changed[0]
  assert.equal(merged.delete, true)
  assert.equal(merged.status, 'delete')
  assert.equal(merged.version, 0)
  assert.equal(typeof merged.deletedAt, 'number', 'deletedAt stamped (was missing)')
  assert.equal(merged.deletedAt, merged.updateTime, 'deletedAt shares the updateTime timestamp')
})

test('F2: allowDeletes=false still never tombstones (round-5 guard intact)', async () => {
  const mod = await import(url('renderer/js/store/helpers/undo.js'))
  const commits = []
  const changed = await mod.persistSnapshotDiffCore(
    { commit: (k, v) => commits.push([k, v]) },
    { from: { todoList: [{ taskId: 'a', updateTime: 1 }], recycleList: [] }, to: { todoList: [], recycleList: [] }, allowDeletes: false },
    () => {}
  )
  assert.equal(changed.length, 0)
})

/* ---------------- F5: restoreAndToast converges the toast on reality (behavior) ---------------- */

test('F5: restoreAndToast success path — success toast after the dispatch resolves', async () => {
  const mod = await import(url('renderer/js/utils/confirm.js'))
  const calls = []
  const store = {
    state: { todo: { recycleList: [{ taskId: 't1', repeatId: null }] } },
    dispatch: async (k, p) => { calls.push([k, p]); return {} }
  }
  const vm = { $message: { success: m => calls.push(['success', m]), error: m => calls.push(['error', m]) } }
  mod.restoreAndToast(vm, store, { taskId: 't1' })
  await new Promise(r => setTimeout(r, 0))
  assert.deepEqual(calls[0][0], 'todo/restoreFromRecycle')
  assert.equal(calls[0][1].taskId, 't1')
  assert.equal(calls[0][1].repeatId, undefined, "legacy 'null' sentinel not fed to the B5 guard")
  assert.equal(calls[1][0], 'success', 'success toast only after resolve')
  assert.ok(!calls.some(c => c[0] === 'error'))
})

test('F5: restoreAndToast failure path — error toast, NO success toast (was unconditional)', async () => {
  const mod = await import(url('renderer/js/utils/confirm.js'))
  const calls = []
  const store = {
    state: { todo: { recycleList: [{ taskId: 't1', repeatId: 'rid1' }] } },
    dispatch: async (k, p) => { calls.push([k, p]); throw new Error('ipc down') }
  }
  const vm = { $message: { success: m => calls.push(['success', m]), error: m => calls.push(['error', m]) } }
  mod.restoreAndToast(vm, store, { taskId: 't1' })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(calls[0][1].repeatId, 'rid1', 'a REAL repeatId feeds the B5 guard')
  assert.ok(!calls.some(c => c[0] === 'success'), 'no fake "Restored" on failure')
  assert.equal(calls[1][0], 'error')
})

test('F5: restoreAndToast with the row already gone — no dispatch at all', async () => {
  const mod = await import(url('renderer/js/utils/confirm.js'))
  let dispatched = 0
  const store = { state: { todo: { recycleList: [] } }, dispatch: async () => { dispatched++ } }
  mod.restoreAndToast({ $message: {} }, store, { taskId: 'gone' })
  await new Promise(r => setTimeout(r, 0))
  assert.equal(dispatched, 0)
})

test('F5: deleteWithUndo delegates its undo link to restoreAndToast', () => {
  const src = read('renderer/js/utils/confirm.js')
  assert.match(src, /const undo = \(\) => restoreAndToast\(vm, store, task\)/)
})

/* ---------------- source-extraction tests (repo idiom for .vue files) ---------------- */

test('F1: EditPanel.restoreFromBin dispatches todo/restoreFromRecycle (single-path restore)', () => {
  const src = read('renderer/js/components/EditPanel.vue')
  const m = src.match(/async restoreFromBin \(\) \{[\s\S]*?\n {4}\},/)
  assert.ok(m, 'restoreFromBin found')
  const body = m[0]
  assert.match(body, /dispatch\('todo\/restoreFromRecycle'/, 'single restore entry')
  assert.ok(!body.includes('todo/updateTodoFields'), 'bare updateTodoFields restore eliminated')
  assert.match(body, /repeatId: this\.e\.repeatId/, 'repeatId feeds the B5 dangling-rule guard')
  assert.match(body, /dayPatch: all/, 'dirty-field flush rides the atomic restore patch')
  assert.ok(!/all\.delete = false/.test(body), 'stale manual delete-flag patch removed')
})

test('F4: TodayXView renders a running rest phase — no lying Start button', () => {
  const src = read('renderer/js/views/TodayXView.vue')
  assert.match(src, /resting \(\) \{ return this\.tomato\.status === 'startRestTime'/, 'resting computed reads the store rest phase')
  assert.match(src, /v-else-if="resting"/, 'rest branch sits between running and idle')
  const restBranch = src.match(/<template v-else-if="resting">[\s\S]*?<\/template>/)
  assert.ok(restBranch, 'rest branch found')
  assert.ok(!restBranch[0].includes('startSelected'), 'no Start button in the rest branch (was a silent no-op)')
  assert.ok(restBranch[0].includes('timerLabel'), 'rest countdown reuses remainingSecOfState via timerLabel')
  assert.match(src, /restingTag/, 'rest tag copy present')
})

test('F6: SettingsSyncTab.connectPeer warns inline on a malformed address', () => {
  const src = read('renderer/js/components/settings/SettingsSyncTab.vue')
  const m = src.match(/async connectPeer \(\) \{[\s\S]*?const proceed = /)
  assert.ok(m, 'connectPeer head found')
  assert.match(m[0], /connectInvalidAddress/, 'inline warning key used')
  assert.ok(!m[0].includes('if (!parsed || !parsed.host || this.busy'), 'silent combined guard replaced')
})

test('F7: RecycleBinView.purgeConfirm guards the untitled task name', () => {
  const src = read('renderer/js/views/RecycleBinView.vue')
  assert.match(src, /purgeConfirm', \{ name: t\.taskContent \|\| this\.\$t\('statsJ\.TodoItem\.untitled'\) \}/)
})

test('F8: FeedbackModal attach-log checkbox is unchecked + disabled (honest)', () => {
  const src = read('renderer/js/components/FeedbackModal.vue')
  assert.match(src, /attachLog: false/, 'data default false — nothing actually attaches')
  assert.match(src, /<input type="checkbox" v-model="attachLog" disabled\/>/, 'checkbox stays disabled')
  assert.match(src, /attachLogPending/, 'explanatory tooltip copy present')
})

test('F9: QuickAdd bulk-paste toast names the target date (reuses onEnter idiom)', () => {
  const src = read('renderer/js/components/QuickAdd.vue')
  const m = src.match(/async createLines \(lines\) \{[\s\S]*?\n {4}\},/)
  assert.ok(m, 'createLines found')
  assert.match(m[0], /scheduledAt/, 'date suffix reused from the single-line toast')
  assert.match(m[0], /movedToInbox/, 'undated (todo box) case named honestly')
  assert.match(m[0], /let d = this\.effDate/, 'effective date read before reset')
  assert.match(m[0], /createdBulk', \{ n \}[\s\S]*?\+ when/, 'bulk copy carries the date suffix')
})

test('F10: EpReminders refuses to silently anchor a dateless row to today', () => {
  const src = read('renderer/js/components/edit-panel/EpReminders.vue')
  assert.match(src, /if \(!r\.date && !this\.task\.dateTs\) \{ undatedSkipped = true; continue \}/, 'dateless row skipped, not today-anchored')
  const m = src.match(/const baseDay = r\.date \|\| this\.task\.dateTs(\s*\|\| this\.today0)?/)
  assert.ok(m && !m[1], 'today0 fallback removed from commitReminders')
  assert.match(src, /remindNeedsDate/, 'warning surfaces the skipped row')
})

/* ---------------- F3: purge paths commit historyBarrier, not historyClear ---------------- */

test('F3: purgeIds/purgeAllRecycle commit historyBarrier; no historyClear on purge paths', () => {
  const src = read('renderer/js/store/todo.js')
  const purgeIds = src.match(/async purgeIds \([\s\S]*?async purgeAllRecycle/)
  assert.ok(purgeIds, 'purgeIds found')
  assert.match(purgeIds[0], /commit\('historyBarrier'\)/)
  assert.ok(!purgeIds[0].includes("commit('historyClear')"), 'no whole-stack wipe on purgeIds')
  const purgeAll = src.match(/async purgeAllRecycle \([\s\S]*?\n {6}return true/)
  assert.ok(purgeAll, 'purgeAllRecycle found')
  assert.match(purgeAll[0], /commit\('historyBarrier'\)/)
  assert.ok(!purgeAll[0].includes("commit('historyClear')"), 'no whole-stack wipe on purgeAllRecycle')
  // the stale inline comment claiming "mandatory historyClear below" is gone
  assert.ok(!/mandatory historyClear below/.test(src), 'stale historyClear comment fixed')
})
