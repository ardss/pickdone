/**
 * D6 UX/views maintenance round (renderer) — regression guards.
 * Fixes covered:
 *   [F1] calendar inline-create orphan cleanup: ui/closeEditCleanup + ui/collapseEditCleanup
 *        soft-delete the inline-created task ONLY while it is still unnamed (store-level, fake todo module)
 *   [F13] multi-term search highlights each term (not the raw whole-query string)
 * Run: node --test tests/unit/renderer/d6-ux-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

if (!globalThis.window.location) globalThis.window.location = { hash: '' }

/* ---------- [F1] store-level: ui module against a fake todo module ---------- */
const { default: Vue } = await import('vue')
globalThis.window.Vue = Vue
const Vuex = (await import('vuex')).default
const ui = (await import('../../../renderer/js/store/ui.js')).default

function makeStore ({ todoList = [], recycleList = [] } = {}) {
  const deletes = []
  const store = new Vuex.createStore({
    modules: {
      ui,
      todo: {
        namespaced: true,
        state: () => ({ todoList, recycleList }),
        actions: {
          deleteTodo (_ctx, t) { deletes.push(t && t.taskId); return Promise.resolve(true) },
          updateTodoFields (_ctx, p) { return Promise.resolve(true) }
        }
      }
    }
  })
  return { store, deletes }
}
const TASK = 't-inline-1'
const openInline = (store, content = '') => {
  store.commit('ui/openEdit', { taskId: TASK, taskContent: content })
  store.commit('ui/markInlineCreate', TASK)
}

test('[F1] closeEditCleanup soft-deletes the still-empty inline-created task', async () => {
  const { store, deletes } = makeStore({ todoList: [{ taskId: TASK, taskContent: '' }] })
  openInline(store)
  await store.dispatch('ui/closeEditCleanup')
  assert.deepEqual(deletes, [TASK], 'empty inline-created task must be soft-deleted on close')
  assert.equal(store.state.ui.rightSidebarTodoEdit.visible, false)
})

test('[F1] closeEditCleanup keeps the inline-created task once it has content', async () => {
  const { store, deletes } = makeStore({ todoList: [{ taskId: TASK, taskContent: '买牛奶' }] })
  openInline(store)
  await store.dispatch('ui/closeEditCleanup')
  assert.deepEqual(deletes, [], 'named task must survive the close')
})

test('[F1] closeEditCleanup never touches a user-opened empty task (flag-scoped)', async () => {
  const { store, deletes } = makeStore({ todoList: [{ taskId: 'user-1', taskContent: '' }] })
  store.commit('ui/openEdit', { taskId: 'user-1', taskContent: '' })
  await store.dispatch('ui/closeEditCleanup')
  assert.deepEqual(deletes, [], 'user-opened empties are not orphan-cleaned')
})

test('[F1] openEdit clears a stale inline-create flag (retarget closes clean)', async () => {
  const { store, deletes } = makeStore({ todoList: [{ taskId: TASK, taskContent: '' }, { taskId: 'user-2', taskContent: '' }] })
  openInline(store)
  store.commit('ui/openEdit', { taskId: 'user-2', taskContent: '' })
  assert.equal(store.state.ui.inlineCreatedTaskId, '', 'flag must not leak onto the newly opened task')
  await store.dispatch('ui/closeEditCleanup')
  assert.deepEqual(deletes, [])
})

test('[F1] collapseEditCleanup: orphan is closed+deleted; normal case stays a plain collapse', async () => {
  const { store, deletes } = makeStore({ todoList: [{ taskId: TASK, taskContent: '' }] })
  openInline(store)
  await store.dispatch('ui/collapseEditCleanup')
  assert.deepEqual(deletes, [TASK])
  assert.equal(store.state.ui.rightSidebarTodoEdit.visible, false, 'orphan cleanup closes the panel, not just collapse')

  const s2 = makeStore()
  s2.store.commit('ui/openEdit', { taskId: 'user-3', taskContent: 'real' })
  await s2.store.dispatch('ui/collapseEditCleanup')
  assert.deepEqual(s2.deletes, [])
  assert.equal(s2.store.state.ui.rightSidebarTodoEdit.visible, true, 'normal collapse keeps the panel')
  assert.equal(s2.store.state.ui.rightSidebarTodoEdit.collapsed, true)
})

/* ---------- [F13] multi-term highlight: per-term, anchored on source ---------- */
const search = await import('../../../renderer/js/utils/search.js')

test('[F13] highlightHTML wraps each whitespace-separated term, not the raw query', () => {
  const html = search.highlightHTML('buy milk and bread', 'milk bread')
  assert.ok(html.includes('<span class="search-highlight">milk</span>'), 'term 1 highlighted: ' + html)
  assert.ok(html.includes('<span class="search-highlight">bread</span>'), 'term 2 highlighted: ' + html)
  assert.ok(!html.includes('milk and bread</span>'), 'raw multi-term query must not be matched as one string')
})

test('[F13] highlightHTML single-term behavior unchanged; input stays escaped', () => {
  assert.equal(search.highlightHTML('buy milk', 'milk'), 'buy <span class="search-highlight">milk</span>')
  const evil = search.highlightHTML('<img onerror>', '<b>')
  assert.ok(!evil.includes('<b '), 'query is escaped before regex use')
  assert.ok(evil.startsWith('&lt;img'), 'text stays escaped')
})
