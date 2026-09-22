/**
 * Sharp-review round (2026-09-22) — categoryDelete undo regressions.
 * Fixes covered:
 *   [renderer-1] the undo closure snapshotted LIVE task row references; updateTodoFields rewrites rows
 *                in place (upsertLocal's Object.assign), so by undo time patch.categoryId read 0 and the
 *                restore wrote 0 back — every affected task stayed permanently uncategorized.
 *                Fix: affectedTasks snapshots {taskId, categoryId} VALUE pairs.
 *   [renderer-2] the todoBoxCategoryId/newTodoCategoryId/calendarCategory reset only compared the
 *                top-level deleted id, not the full cascade victim set — settings pointing at a folder's
 *                CHILD category kept aiming at the dead id (todo box forever 0 items).
 *                Fix: compare against victimKey (full collectCascadeIds set), like D5's filter purge.
 * Run: node --test tests/unit/renderer/sharp-review-catdelete-undo.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

if (!globalThis.window.location) globalThis.window.location = { hash: '' }

const VueNs = await import('vue')
const Vue = VueNs.h ? VueNs : VueNs.default
globalThis.window.Vue = Vue

const { collectCascadeIds } = await import('../../../renderer/js/store/category.js')
const { deleteCategoryWithUndo } = await import('../../../renderer/js/components/side-nav/categoryDelete.js')

/** Minimal fake store reproducing the REAL shapes categoryDelete touches: category/softDelete marks the
 *  full cascade deleted (via the store's own collectCascadeIds), todo/updateTodoFields rewrites the live
 *  row IN PLACE (mimicking upsertLocal's Object.assign — the crux of renderer-1), settings/update merges
 *  into the settings state. The undo closure is captured from the toast vnode for direct invocation. */
function makeCtx ({ categories, todos, settings, filters = [] }) {
  const dispatched = []
  let capturedUndo = null
  const markDeleted = id => {
    for (const vid of collectCascadeIds({ list: categories }, id)) {
      const c = categories.find(x => x.categoryId === vid)
      if (c && !c.delete) { c.delete = true; c.deletedAt = Date.now() }
    }
  }
  const recover = id => {
    const c = categories.find(x => x.categoryId === id)
    if (c && c.delete) { c.delete = false; c.deletedAt = 0 }
  }
  const ctx = {
    $t: k => k,
    // EP's $message is callable; showUndoToast receives ctx.$message.bind(ctx) and invokes it with the
    // message opts (type 'success'), so capture the undo onClick out of the vnode tree here.
    $message: Object.assign(opts => {
      const span = opts.message
      for (const child of (span.children || [])) {
        if (child && child.props && child.props.onClick) capturedUndo = child.props.onClick
      }
      return { close () {}, $el: null }
    }, { warning () {} }),
    $store: {
      state: {
        todo: { todoList: todos },
        category: { list: categories, projectIds: [] },
        settings,
        filters: { list: filters }
      },
      commit (type, payload) {
        if (type === 'category/softDelete') markDeleted(payload)
        else if (type === 'category/recover') recover(payload)
      },
      async dispatch (type, payload) {
        dispatched.push([type, payload])
        if (type === 'todo/updateTodoFields') {
          const row = todos.find(t => t.taskId === payload.taskId)
          if (row) Object.assign(row, payload.patch) // in-place rewrite, exactly like upsertLocal
          return
        }
        if (type === 'settings/update') { Object.assign(settings, payload); return }
        if (type === 'filters/save') return
      }
    }
  }
  return { ctx, dispatched, getUndo: () => capturedUndo }
}

const noTimers = async fn => {
  // showUndoToast arms a real 5s auto-dismiss timer; stub setTimeout so the test process never waits on it
  const realSetTimeout = globalThis.setTimeout
  globalThis.setTimeout = () => 0
  try { return await fn() } finally { globalThis.setTimeout = realSetTimeout }
}

const FOLDER = { categoryId: 1, categoryName: 'Folder', folderIs: true, folderId: 0, delete: false }
const CHILD = { categoryId: 7, categoryName: 'Child', folderIs: false, folderId: 1, delete: false }
const task = (id, cat) => ({ taskId: id, taskContent: 't' + id, categoryId: cat })

test('[renderer-1] undo restores each affected task to its ORIGINAL categoryId (not the in-place-rewritten 0)', async () => {
  await noTimers(async () => {
    const todos = [task('a', 7), task('b', 7), task('c', 3)]
    const { ctx, getUndo } = makeCtx({
      categories: [FOLDER, CHILD, { categoryId: 3, categoryName: 'Other', folderIs: false, folderId: 0, delete: false }],
      todos,
      settings: {}
    })
    await deleteCategoryWithUndo(ctx, CHILD)
    assert.equal(todos[0].categoryId, 0, 'delete reassigned the task to uncategorized')
    const undo = getUndo()
    assert.ok(undo, 'undo closure captured from the toast')
    await undo()
    assert.equal(todos[0].categoryId, 7, 'task a restored to its original category 7 (bug: stayed 0)')
    assert.equal(todos[1].categoryId, 7, 'task b restored too')
    assert.equal(todos[2].categoryId, 3, 'unaffected task untouched')
  })
})

test('[renderer-2] settings pointing at a cascade CHILD victim are reset (not just the top-level id)', async () => {
  await noTimers(async () => {
    const settings = { todoBoxCategoryId: 7, newTodoCategoryId: 7, calendarCategory: 3 }
    const { ctx, dispatched } = makeCtx({ categories: [FOLDER, CHILD], todos: [task('a', 7)], settings })
    await deleteCategoryWithUndo(ctx, FOLDER) // deleting the FOLDER cascades child 7 away
    const upd = dispatched.filter(([t]) => t === 'settings/update').map(([, p]) => p)
    assert.ok(upd.length >= 1, 'settings/update dispatched')
    assert.equal(upd[0].todoBoxCategoryId, -1, 'todo box selector reset (pointed at cascaded child 7)')
    assert.equal(upd[0].newTodoCategoryId, 0, 'new-todo selector reset too')
    assert.equal(upd[0].calendarCategory, undefined, 'calendar pointed at live category 3 — left alone')
  })
})

test('[renderer-2] undo restores the pre-reset selector values', async () => {
  await noTimers(async () => {
    const settings = { todoBoxCategoryId: 7 }
    const { ctx, getUndo } = makeCtx({ categories: [FOLDER, CHILD], todos: [task('a', 7)], settings })
    await deleteCategoryWithUndo(ctx, FOLDER)
    assert.equal(settings.todoBoxCategoryId, -1)
    await getUndo()()
    assert.equal(settings.todoBoxCategoryId, 7, 'pre-reset value restored on undo')
  })
})
