/**
 * F3 UX false-success wave (renderer) — regression guards.
 * Fixes covered:
 *   [F3-1] ProjectView: all FOUR milestone write paths (add / edit / remove / toggleMsTask) await
 *          saveMilestones' .savePromise; ok===false keeps the UI at the pre-write list and toasts
 *          the shared actionFailedMsg instead of an unconditional success toast
 *   [F3-2] ProjectView.removeFromProject: category/setProject is a SYNC mutation (Vuex commit
 *          discards the handler return); the view waits out the store's immediate onFail revert
 *          window and only toasts success + navigates when the in-memory projectIds dropped the id
 *   [F3-3] SnManageCategoriesModal.toggleProject: same setProject revert gate before the toast
 *   [F3-4] SnManageCategoriesModal.saveMgrEdit: updateCategory's ok===false persist failure keeps
 *          the editor open on the old name (was: silently closed as if saved)
 *   [F3-5] ProjectView.renameProject: cancel handling scoped to the $prompt await only — a real
 *          persistence rejection no longer dies in the cancel-swallowing catch
 *   [F3-6] SnManageTagsModal.renameTag: bulk rewrite takes a [D15-A8]-style snapshot and offers a
 *          5s undo (restore snapshot fields + rename the userTags bookkeeping back)
 * Run: node --test tests/unit/renderer/f3-ux-false-success.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

if (!globalThis.window.location) globalThis.window.location = { hash: '' }

/* ==================== [F3-1] milestone confirmed-write path ==================== */

test('F3-1 saveMilestones still resolves savePromise=false on a failed meta put (signal consumed, not modified)', async () => {
  const prev = globalThis.window.todoAPI
  let fail = true
  globalThis.window.todoAPI = {
    ...(prev || {}),
    dbCall: async (op, params) => {
      if (op === 'setMeta') { if (fail) throw new Error('disk full'); return 'ok' }
      return prev && prev.dbCall ? prev.dbCall(op, params) : null
    }
  }
  try {
    const { saveMilestones, loadMilestones } = await import('../../../renderer/js/utils/milestones.js')
    const saved = saveMilestones('catF3a', [{ id: 'ms1', title: 'M1', date: 1700000000000 }])
    assert.equal(await saved.savePromise, false, 'failed write resolves false — the view must gate on it')
    assert.deepEqual(await loadMilestones('catF3a'), [], 'nothing durably stored (loadMilestones falls back to [])')
    fail = false
    const ok = saveMilestones('catF3b', [{ id: 'ms2', title: 'M2', date: 1700000000000 }])
    assert.equal(await ok.savePromise, true, 'clean write resolves true')
  } finally {
    globalThis.window.todoAPI = prev
  }
})

test('F3-1 ProjectView: every milestone write routes through the awaited confirmed-save helper', () => {
  const src = read('renderer/js/views/ProjectView.vue')
  // the helper awaits the durable write and keeps the UI on failure
  assert.match(src, /async saveMilestonesConfirmed \(next\)/, 'single confirmed-write helper exists')
  assert.match(src, /ok = await saved\.savePromise/, 'helper awaits saveMilestones .savePromise (utils/milestones.js consumed, never modified)')
  assert.match(src, /if \(ok !== true\) \{\s*\n\s*this\.milestones = prev/, 'UI stays at the pre-write list when the put failed')
  assert.match(src, /statsH\.main\.actionFailedMsg/, 'failure toasts the shared actionFailedMsg key')
  // all four call sites go through it — no direct un-awaited assignments remain
  assert.equal((src.match(/saveMilestonesConfirmed ?\(/g) || []).length, 5, 'helper definition + 4 call sites (add / edit / remove / toggleMsTask)')
  assert.doesNotMatch(src, /this\.milestones = saveMilestones\(/, 'no direct un-gated saveMilestones assignment survives')
  // success toasts only AFTER the awaited save (inside the onMsSave success branches)
  assert.match(src, /if \(!saved\) return\s*\n\s*this\.msNewId/, 'add path: entrance animation only after the write confirmed')
  assert.match(src, /if \(!saved\) return\s*\n\s*this\.\$message\.success\(this\.\$t\('statsB\.ProjectView\.msUpdated'\)\)/, 'edit path: success toast only after the write confirmed')
})

/* ==================== [F3-2] setProject revert gate (removeFromProject) ==================== */

test('F3-2 category/setProject failed durable flag write reverts the in-memory projectIds (signal the views gate on)', async () => {
  // store-level behavioral: the onFail revert is the failure signal the view checks
  const puts = []
  let failDelete = false
  globalThis.window.todoAPI = {
    dbCall: async (op, params) => {
      if (op === 'setMeta') { puts.push(params); return 'ok' }
      if (op === 'deleteMeta') { if (failDelete) throw new Error('ipc down'); return 'ok' }
      if (op === 'getAllCategories') return []
      return null
    }
  }
  const cat = (await import('../../../renderer/js/store/category.js')).default
  const state = { list: [], projectIds: [777], projectMeta: {} }
  const ctx = { state, commit () {} }
  cat.mutations.setProject(state, { id: 777, flag: false }, ctx)
  await new Promise(r => setTimeout(r, 0))
  assert.ok(!state.projectIds.includes(777), 'clean delete drops the id (view may toast success)')
  failDelete = true
  cat.mutations.setProject(state, { id: 777, flag: false }, ctx)
  await new Promise(r => setTimeout(r, 0))
  assert.ok(state.projectIds.includes(777), 'failed delete keeps the id (revert = failure signal)')
})

test('F3-2 ProjectView.removeFromProject gates success toast + navigation on the revert signal', () => {
  const src = read('renderer/js/views/ProjectView.vue')
  const m = src.match(/async removeFromProject \(\) \{[\s\S]*?\n {4}\},/)
  assert.ok(m, 'removeFromProject block found')
  const body = m[0]
  assert.match(body, /commit\('category\/setProject', \{ id: this\.catId, flag: false \}\)/)
  assert.match(body, /await new Promise\(r => setTimeout\(r, 0\)\)/, 'waits out the immediate onFail revert window')
  assert.match(body, /projectIds\.includes\(this\.catId\)/, 'checks the in-memory revert (sync mutation: commit discards the return)')
  const toastIdx = body.indexOf('statsB.ProjectView.restored')
  const gateIdx = body.indexOf('projectIds.includes')
  const pushIdx = body.indexOf('$router.push')
  assert.ok(gateIdx !== -1 && gateIdx < toastIdx && gateIdx < pushIdx, 'success toast AND router.push only after the gate')
  assert.match(body, /statsH\.main\.actionFailedMsg/, 'failure toasts the shared actionFailedMsg key')
})

/* ==================== [F3-3/F3-4] SnManageCategoriesModal ==================== */

test('F3-3 SnManageCategoriesModal.toggleProject gates the success toast on the same revert signal', () => {
  const src = read('renderer/js/components/side-nav/SnManageCategoriesModal.vue')
  const m = src.match(/async toggleProject \(c\) \{[\s\S]*?\n {4}\},/)
  assert.ok(m, 'toggleProject block found')
  const body = m[0]
  assert.match(body, /await new Promise\(r => setTimeout\(r, 0\)\)/)
  assert.match(body, /projectIds\.includes\(c\.categoryId\) !== flag/, 'both directions gated on the flag delta')
  assert.match(body, /statsH\.main\.actionFailedMsg/)
  const toastIdx = body.indexOf('statsG.SideNav.setProject')
  const gateIdx = body.indexOf('!== flag')
  assert.ok(gateIdx < toastIdx, 'success toast only after the gate')
})

test('F3-4 saveMgrEdit: a failed persist keeps the editor open on the old name', () => {
  const src = read('renderer/js/components/side-nav/SnManageCategoriesModal.vue')
  assert.match(src, /const ok = await this\.\$store\.commit\('category\/updateCategory', \{ categoryId: c\.categoryId, categoryName: this\.mgrName\.trim\(\) \}\)/, 'persist result captured')
  assert.match(src, /if \(ok === false\) \{[\s\S]*?statsH\.main\.actionFailedMsg[\s\S]*?this\.mgrName = c\.categoryName/, 'failure: toast + editor restored to the old name (kept open)')
  // the CATEGORY_EXISTS branch must keep its refocus convention
  assert.match(src, /e\.code === 'CATEGORY_EXISTS'/, 'duplicate-name warning branch preserved')
})

/* ==================== [F3-5] renameProject cancel vs persistence failure ==================== */

test('F3-5 renameProject: cancel scoped to the dialog await; persistence errors surface', () => {
  const src = read('renderer/js/views/ProjectView.vue')
  const m = src.match(/async renameProject \(\) \{[\s\S]*?\n {4}\},/)
  assert.ok(m, 'renameProject block found')
  const body = m[0]
  assert.match(body, /catch \{ return \} \/\/ user cancelled the dialog/, 'the ONLY swallow is the $prompt cancel')
  assert.equal((body.match(/catch ?[{(]/g) || []).length, 2, 'exactly two catch scopes: dialog cancel + persist errors')
  assert.match(body, /const ok = await this\.\$store\.commit\('category\/updateCategory', \{ categoryId: this\.catId, categoryName: name \}\)/, '[A4] pinned gate line shape preserved (d20 contract)')
  assert.match(body, /e\.code === 'CATEGORY_EXISTS'/, 'duplicate-name warning preserved')
  assert.match(body, /statsH\.main\.actionFailedMsg/, 'unknown persistence rejections surface (no cancel swallow)')
  assert.doesNotMatch(body, /throw e\s*\n\s*\}\s*\n\s*\} catch \{/, 'no rethrow into an outer cancel-swallowing catch')
})

/* ==================== [F3-6] renameTag undo snapshot ==================== */

test('F3-6 renameTag snapshots before the rewrite and offers the app-wide undo', () => {
  const src = read('renderer/js/components/side-nav/SnManageTagsModal.vue')
  const m = src.match(/async renameTag \(t\) \{[\s\S]*?\n {4}\},/)
  assert.ok(m, 'renameTag block found')
  const body = m[0]
  const snapIdx = body.indexOf('const snapshot = this.tagTodos(t.name)')
  const rewriteIdx = body.indexOf('rewriteTagTodos(')
  assert.ok(snapIdx !== -1 && snapIdx < rewriteIdx, '[D15-A8] snapshot taken BEFORE the bulk rewrite')
  assert.match(body, /taskId: todo\.taskId, taskContent: todo\.taskContent, taskDescribe: todo\.taskDescribe/, 'same snapshot shape as removeTag')
  assert.match(body, /showUndoToast\(this\.\$message\.bind\(this\)/, 'undo toast replaces the bare success')
  assert.match(body, /ui\/renameUserTag', \{ from: next, to: t\.name \}/, 'undo renames the userTags bookkeeping back')
  assert.match(body, /statsA\.core\.undo/, 'undo link label')
})
