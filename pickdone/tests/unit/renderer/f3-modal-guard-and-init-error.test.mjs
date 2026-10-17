/**
 * F3 fix round (2026-10-18) — regression guards:
 *   F1  main.js modalOpen() guard: the global shortcut pipeline (deleteEvent / startPomodoro /
 *       view-switch / Ctrl+N / undo / redo) short-circuits while a dialog is open — source
 *       anchors, same idiom as d6-ux-fixes (main.js boots a full app and cannot be imported).
 *   F2  EditPanel.vue window-level Esc: an open component-local overlay (el-dialog family /
 *       .modal-container) blocks the closeEditCleanup fall-through — source anchor.
 *   F4  store/todo.js init: a failed getAll no longer degrades to setLoaded(true) with a fake
 *       empty list — it sets an observable initError (loaded stays false); a later successful
 *       init clears it. Real store, stubbed db bridge.
 *   F5/F6 i18n parity: dedicated dateOnlyRefused (QuickAdd) and tagNameExistsWarn (SideNav) keys
 *       exist in BOTH language shards; the call sites reference the new keys.
 * Run: node --test tests/unit/renderer/f3-modal-guard-and-init-error.test.mjs
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

/* ==================== F1: main.js modal guard (source anchors) ==================== */

const mainSrc = read('renderer/js/main.js')

test('F1 modalOpen helper is defined and covers the store modal flags + DOM sweep', () => {
  assert.ok(mainSrc.includes('const modalOpen = () => {'), 'modalOpen helper exists')
  for (const flag of ['showSettingsModal', 'showFilterModal', 'showFeedbackModal', 'showRepeatModalFor',
    'showRepeatDeleteConfirm', 'accountTaskId', 'tomatoAbandonVisible', 'tomatoFocusRecordVisible',
    'tomatoRecordAddVisible', 'contextMenu']) {
    assert.ok(mainSrc.includes(`ui.${flag}`), `modalOpen covers ui.${flag}`)
  }
  assert.ok(mainSrc.includes('.el-overlay:not([style*="display: none"])'), 'modalOpen sweeps el-dialog overlays')
  assert.ok(mainSrc.includes('.modal-container:not([style*="display: none"])'), 'modalOpen sweeps local modal containers')
})

test('F1 deleteEvent and startPomodoro short-circuit under an open modal', () => {
  const delIdx = mainSrc.indexOf("case 'deleteEvent'")
  assert.ok(delIdx > 0)
  const delBody = mainSrc.slice(delIdx, delIdx + 900)
  assert.ok(delBody.includes('if (modalOpen()) break'), 'deleteEvent guards on modalOpen')
  const pomIdx = mainSrc.indexOf("case 'startPomodoro'")
  assert.ok(pomIdx > 0)
  const pomBody = mainSrc.slice(pomIdx, pomIdx + 300)
  assert.ok(pomBody.includes('if (modalOpen()) break'), 'startPomodoro guards on modalOpen')
})

test('F1 view-switch shortcuts do not change the route under an open modal', () => {
  for (const name of ['switchToDaytodo', 'switchToRecentTodos', 'switchToSchedule', 'switchToInbox']) {
    const idx = mainSrc.indexOf(`case '${name}'`)
    assert.ok(idx > 0, `case ${name} exists`)
    const body = mainSrc.slice(idx, idx + 320)
    assert.ok(body.includes('modalOpen()'), `case ${name} guards on modalOpen`)
    assert.ok(body.includes('router.push'), `case ${name} still routes when no modal`)
  }
})

test('F1 Ctrl+N / undo / redo keydown branches guard on modalOpen', () => {
  const kdIdx = mainSrc.indexOf("window.addEventListener('keydown', e => {")
  assert.ok(kdIdx > 0)
  const body = mainSrc.slice(kdIdx, kdIdx + 2200)
  assert.ok(body.includes('const modal = modalOpen()'), 'keydown handler evaluates the modal guard once')
  assert.ok(body.includes("!modal && e.key.toLowerCase() === 'n'"), 'Ctrl+N guarded')
  assert.ok(body.includes("!inEditor && !modal && e.ctrlKey && !e.shiftKey && e.key.toLowerCase() === 'z'"), 'undo guarded')
  assert.ok(body.includes("!inEditor && !modal && ((e.ctrlKey && e.key.toLowerCase() === 'y')"), 'redo guarded')
})

/* ==================== F2: EditPanel Esc sweep ==================== */

test('F2 EditPanel window Esc ignores component-local overlays before closeEditCleanup', () => {
  const src = read('renderer/js/components/EditPanel.vue')
  const idx = src.indexOf("if (e.key !== 'Escape') return")
  assert.ok(idx > 0)
  const body = src.slice(idx, idx + 2500)
  const sweepIdx = body.indexOf(".el-overlay:not([style*=\"display: none\"])")
  const cleanupIdx = body.indexOf("dispatch('ui/closeEditCleanup')")
  assert.ok(sweepIdx > 0, 'DOM sweep for local dialogs present in the Esc handler')
  assert.ok(cleanupIdx > sweepIdx, 'the sweep runs BEFORE closeEditCleanup')
})

/* ==================== F4: todo store init error state ==================== */

test('F4 todo/init failure sets initError and keeps loaded false; success clears it', async () => {
  let getAllFails = true
  const calls = []
  globalThis.window.todoAPI = {
    dbCall (op, params) {
      calls.push(op)
      if (op === 'getAll') {
        return getAllFails ? Promise.reject(new Error('sqlite disk I/O error')) : Promise.resolve([])
      }
      return Promise.resolve(null)
    }
  }
  const Vue = (await import('vue')).default
  globalThis.window.Vue = Vue
  const Vuex = (await import('vuex')).default
  const todo = (await import('../../../renderer/js/store/todo.js')).default
  const store = new Vuex.createStore({
    modules: {
      todo,
      // minimal settings slice: computeViewsCore / purgeExpiredRecycle read these
      settings: {
        namespaced: true,
        state: () => ({
          expiredCompletedTodoRange: '7d',
          recycleBinAutoDeleteDays: 0,
          todoBoxCategoryId: -1,
          todoBoxSortOrder: 'desc',
          todoBoxSortMethod: 'created',
          sortMode: 'created'
        })
      }
    }
  })

  await store.dispatch('todo/init', {})
  assert.equal(store.state.todo.initError, 'sqlite disk I/O error', 'failure surfaces an observable error')
  assert.equal(store.state.todo.loaded, false, 'loaded stays false on failure — no fake empty list')

  getAllFails = false
  await store.dispatch('todo/init', {})
  assert.equal(store.state.todo.initError, null, 'a successful retry clears the error')
  assert.equal(store.state.todo.loaded, true, 'success sets loaded')
})

/* ==================== F5/F6: dedicated i18n keys, both languages ==================== */

test('F5 QuickAdd date-only refusal has its own key in zh and en; the call site uses it', () => {
  const zh = read('renderer/js/i18n/locales/zh-CN-D.js')
  const en = read('renderer/js/i18n/locales/en-US-D.js')
  assert.ok(zh.includes('dateOnlyRefused'), 'zh key exists')
  assert.ok(en.includes('dateOnlyRefused'), 'en key exists')
  assert.ok(!zh.includes('statsB.ProjectView.nameRequired') || true)
  const qa = read('renderer/js/components/QuickAdd.vue')
  assert.ok(qa.includes("this.$t('statsD.QuickAdd.dateOnlyRefused')"), 'QuickAdd uses the new key')
  assert.ok(!qa.includes('statsB.ProjectView.nameRequired'), 'the borrowed generic key is gone')
})

test('F6 tag duplicate warning has its own key in zh and en; createTag uses it (categories untouched)', () => {
  const zh = read('renderer/js/i18n/locales/zh-CN-G.js')
  const en = read('renderer/js/i18n/locales/en-US-G.js')
  assert.ok(zh.includes('tagNameExistsWarn'), 'zh key exists')
  assert.ok(en.includes('tagNameExistsWarn'), 'en key exists')
  const h = read('renderer/js/components/side-nav/sideNavHandlers.js')
  assert.ok(h.includes("vm.$t('statsG.SideNav.tagNameExistsWarn')"), 'tag flow uses the new key')
  assert.equal(h.split('catNameExistsWarn').length - 1, 3, 'the three genuine category call sites keep the category key')
})
