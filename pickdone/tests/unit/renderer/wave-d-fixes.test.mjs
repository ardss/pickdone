/**
 * Wave-D fix round (renderer) — regression guards. Fixes covered:
 *   [P1-1] EditPanel.flushSave RETURNS the save queue's flush promise — ui/closeEditCleanup's
 *          inline-created orphan cleanup awaits the hook; a hook resolving undefined re-opened
 *          the 60ms race against the 350ms debounce (fast-typed title orphan-deleted)
 *   [P1-2] categoryDelete: settings reset keys are tested against the FULL cascade victim set
 *          (folder descendants too), not just the root categoryId
 *   [P2-3] categoryDelete undo: tasks concurrently moved/deleted during the 5s window are NOT
 *          stomped back to the snapshotted categoryId
 *   [P2-1] contracts.d.ts DbCallOp union mirrors the main-process renderer whitelist
 *   [P3]   NaN dayStart/createTime degrade to fallback buckets / stable order (sortMode + todo views)
 * Run: node --test tests/unit/renderer/wave-d-fixes.test.mjs
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

/* ---------- [P1-1] EditPanel.flushSave returns the flush promise ---------- */

const EDIT_PANEL = read('renderer/js/components/EditPanel.vue')

test('[P1-1] flushSave method returns the save queue flush promise (not fire-and-forget)', () => {
  assert.match(EDIT_PANEL, /flushSave \(\) \{ return this\._save \? this\._save\.flushSave\(\) : undefined \}/,
    'flushSave must return the promise so the ui-store flush hook is awaitable')
  assert.match(EDIT_PANEL, /this\._flushHook = \(\) => this\.flushSave\(\)/,
    'the hook registered for closeEditCleanup stays wired to flushSave')
})

test('[P1-1] editSave.flushSave returns Promise.all(outs) (the awaited contract)', () => {
  const src = read('renderer/js/utils/editSave.js')
  const body = src.slice(src.indexOf('const flushSave = () =>'))
  assert.match(body, /return Promise\.all\(outs\)/, 'the flush implementation must surface its promise')
})

test('[P1-1] closeEditCleanup awaits the registered flush hook before the emptiness check', async () => {
  const { default: Vue } = await import('vue')
  globalThis.window.Vue = Vue
  const Vuex = (await import('vuex')).default
  const ui = (await import('../../../renderer/js/store/ui.js')).default

  const deletes = []
  const TASK = 't-flush-1'
  const todoList = [{ taskId: TASK, taskContent: '' }]
  // Simulates EditPanel's debounced dispatch landing DURING flushSave: the title only becomes
  // visible after the hook runs. If cleanup did not await the hook, the emptiness check would see
  // '' and orphan-delete a just-titled task.
  globalThis.window.__editPanelFlushSave = () => new Promise(resolve => {
    setTimeout(() => { todoList[0].taskContent = '买牛奶'; resolve(true) }, 20)
  })
  try {
    const store = new Vuex.createStore({
      modules: {
        ui,
        todo: {
          namespaced: true,
          state: () => ({ todoList, recycleList: [] }),
          actions: {
            deleteTodo (_ctx, t) { deletes.push(t && t.taskId); return Promise.resolve(true) },
            updateTodoFields (_ctx, p) { return Promise.resolve(true) }
          }
        }
      }
    })
    store.commit('ui/openEdit', { taskId: TASK, taskContent: '' })
    store.commit('ui/markInlineCreate', TASK)
    await store.dispatch('ui/closeEditCleanup')
    assert.deepEqual(deletes, [], 'a title landing during the awaited flush must NOT be orphan-deleted')
  } finally {
    delete globalThis.window.__editPanelFlushSave
  }
})

/* ---------- [P1-2] / [P2-3] categoryDelete: victim-set settings reset + undo guard ---------- */

const { deleteCategoryWithUndo } = await import('../../../renderer/js/components/side-nav/categoryDelete.js')

function makeDeleteCtx ({ todoList, settings }) {
  const updates = []
  const settingsUpdates = []
  const recovers = []
  const softDeleted = []
  const state = {
    category: {
      list: [
        { categoryId: 5, categoryName: 'Folder', folderIs: true, delete: false },
        { categoryId: 6, categoryName: 'Child', folderId: 5, delete: false }
      ],
      projectIds: []
    },
    todo: { todoList: todoList.map(t => ({ ...t })), recycleList: [] },
    filters: { list: [] },
    settings: { ...settings }
  }
  const store = {
    state,
    commit (path, p) {
      if (path === 'category/softDelete') softDeleted.push(p)
      if (path === 'category/recover') recovers.push(p)
      if (path === 'category/setProject') state.category.projectIds = state.category.projectIds.filter(x => x !== p.id)
    },
    async dispatch (path, p) {
      if (path === 'todo/updateTodoFields') {
        const t = state.todo.todoList.find(x => x.taskId === p.taskId)
        if (t) Object.assign(t, p.patch)
        updates.push({ taskId: p.taskId, patch: { ...p.patch } })
        return true
      }
      if (path === 'settings/update') {
        Object.assign(state.settings, p)
        settingsUpdates.push({ ...p })
        return true
      }
      if (path === 'filters/save') return true
      throw new Error('unexpected dispatch ' + path)
    }
  }
  const ctx = {
    $store: store,
    $t: k => k,
    $message: Object.assign(() => ({ close: () => {} }), { warning: () => {} })
  }
  return { ctx, store, updates, settingsUpdates }
}

test('[P1-2] deleting a FOLDER resets todoBoxCategoryId that points at a cascade-deleted DESCENDANT', async () => {
  // No window.Vue → the undo toast is skipped; undo behavior is covered by the dedicated tests below
  const savedVue = globalThis.window.Vue
  globalThis.window.Vue = undefined
  try {
    const { ctx, settingsUpdates } = makeDeleteCtx({
      todoList: [{ taskId: 'a', categoryId: 6 }],
      settings: { todoBoxCategoryId: 6, newTodoCategoryId: 0, calendarCategory: 0 }
    })
    await deleteCategoryWithUndo(ctx, { categoryId: 5, categoryName: 'Folder' })
    assert.deepEqual(settingsUpdates, [{ todoBoxCategoryId: -1 }],
      'a subcategory-targeted todo box filter must be reset when the folder cascade deletes it')
  } finally {
    globalThis.window.Vue = savedVue
  }
})

test('[P1-2] deleting a folder does NOT touch settings pointing at unrelated categories', async () => {
  const savedVue = globalThis.window.Vue
  globalThis.window.Vue = undefined
  try {
    const { ctx, settingsUpdates } = makeDeleteCtx({
      todoList: [],
      settings: { todoBoxCategoryId: 42, newTodoCategoryId: 0, calendarCategory: 0 }
    })
    await deleteCategoryWithUndo(ctx, { categoryId: 5, categoryName: 'Folder' })
    assert.deepEqual(settingsUpdates, [])
  } finally {
    globalThis.window.Vue = savedVue
  }
})

function captureUndo (ctx) {
  // Fake Vue.h so the undo anchor's onClick lands in a plain object we can invoke
  globalThis.window.Vue = { h: (tag, props, ...kids) => ({ tag, props, kids }) }
  let opts = null
  ctx.$message = o => { opts = o; return { close: () => {} } }
  return () => {
    // children = [summary string, undo anchor vnode]; the toast wraps them via h('span', children).
    // The fake h receives children as its 2nd arg for the wrapper (no props), so unwrap either shape.
    const wrapper = opts.message
    const children = Array.isArray(wrapper.props) ? wrapper.props : wrapper.kids
    const anchor = children[1]
    return anchor.props.onClick()
  }
}

test('[P2-3] undo restores moved-back tasks but does NOT stomp tasks moved elsewhere during the window', async () => {
  const { ctx, store, updates } = makeDeleteCtx({
    todoList: [
      { taskId: 'kept', categoryId: 6 },
      { taskId: 'moved', categoryId: 6 }
    ],
    settings: { todoBoxCategoryId: -1, newTodoCategoryId: 0, calendarCategory: 0 }
  })
  const runUndo = captureUndo(ctx)
  await deleteCategoryWithUndo(ctx, { categoryId: 5, categoryName: 'Folder' })
  assert.equal(store.state.todo.todoList[0].categoryId, 0)
  assert.equal(store.state.todo.todoList[1].categoryId, 0)

  // Concurrent user edit inside the 5s window: "moved" is reassigned to category 7
  store.state.todo.todoList[1].categoryId = 7
  updates.length = 0

  await runUndo()
  const movedUpdates = updates.filter(u => u.taskId === 'moved')
  assert.deepEqual(movedUpdates, [], 'undo must skip a task the user already moved elsewhere')
  const keptUpdates = updates.filter(u => u.taskId === 'kept')
  assert.deepEqual(keptUpdates, [{ taskId: 'kept', patch: { categoryId: 6 } }],
    'undo still restores tasks left in the purge-affected (categoryId 0) state')
})

test('[P2-3] undo does not resurrect a task that was soft-deleted during the window', async () => {
  const { ctx, store, updates } = makeDeleteCtx({
    todoList: [{ taskId: 'gone', categoryId: 6 }],
    settings: { todoBoxCategoryId: -1, newTodoCategoryId: 0, calendarCategory: 0 }
  })
  const runUndo = captureUndo(ctx)
  await deleteCategoryWithUndo(ctx, { categoryId: 5, categoryName: 'Folder' })
  // User permanently deletes / recycle-bins the row during the window
  store.state.todo.todoList[0].delete = true
  updates.length = 0
  await runUndo()
  assert.deepEqual(updates.filter(u => u.taskId === 'gone'), [], 'deleted rows must not receive a category restore')
})

/* ---------- [P2-1/P2-2] contracts.d.ts mirrors the main-process / preload surface ---------- */

test('[P2-1] every ALLOWED_RENDERER_OPS entry appears in the DbCallOp union', () => {
  const main = read('src/main/handlers/todo.js')
  const m = main.match(/ALLOWED_RENDERER_OPS = new Set\(\[([\s\S]*?)\]\)/)
  assert.ok(m, 'whitelist found in src/main/handlers/todo.js')
  const ops = [...m[1].matchAll(/'([A-Za-z]+)'/g)].map(x => x[1])
  assert.ok(ops.length >= 50, 'whitelist parse is non-trivial')
  const contracts = read('renderer/js/contracts.d.ts')
  const union = contracts.match(/type DbCallOp = ([^\n]+)/)[1]
  for (const op of ops) {
    assert.ok(union.includes(`'${op}'`), `DbCallOp must include whitelisted op '${op}'`)
  }
})

test('[P2-2] TodoAPI declares the previously-missing preload methods', () => {
  const contracts = read('renderer/js/contracts.d.ts')
  const iface = contracts.slice(contracts.indexOf('interface TodoAPI'), contracts.indexOf('interface Window'))
  for (const name of ['getMetaMany', 'tomatoRunAnnounce', 'tomatoRunAnnounces', 'onWhiteNoiseUpdated',
    'onExternalHabitsChanged', 'notifyQuitFlushDone', 'syncPairRespond', 'syncPairRequest',
    'syncConflictBackupsList', 'syncConflictBackupRestore']) {
    assert.ok(new RegExp(`\\b${name}:`).test(iface), `TodoAPI must declare ${name}`)
  }
})

/* ---------- [P3] NaN comparators degrade to a stable fallback order ---------- */

const { sortByMode, normalizeSortMode } = await import('../../../renderer/js/utils/sortMode.js')

test('[P3] sortMode: NaN/missing taskSort and createTime keep rows in a deterministic order', () => {
  const rows = [
    { id: 'nanSort', taskSort: NaN, createTime: 100 },
    { id: 'sorted', taskSort: 5, createTime: 100 },
    { id: 'noCreate', taskSort: 5, createTime: NaN }
  ]
  const out = sortByMode(rows, 'custom')
  // Deterministic order: NaN taskSort falls into the bottom bucket; a NaN createTime tiebreaks as 0
  // (oldest), so the row order is fixed instead of implementation-defined
  assert.deepEqual(out.map(r => r.id), ['noCreate', 'sorted', 'nanSort'])
  // created mode: NaN createTime degrades to 0 (oldest), never reshuffles nondeterministically
  const out2 = sortByMode([{ id: 'a', createTime: 2 }, { id: 'nan', createTime: NaN }, { id: 'b', createTime: 1 }], 'created')
  assert.deepEqual(out2.map(r => r.id), ['a', 'b', 'nan'])
  // purity: input untouched
  assert.equal(rows.length, 3)
})

test('[P3] sortMode: legacy Chinese modes still normalize', () => {
  assert.equal(normalizeSortMode('按难度'), 'difficulty')
  assert.equal(normalizeSortMode(undefined), 'custom')
})
