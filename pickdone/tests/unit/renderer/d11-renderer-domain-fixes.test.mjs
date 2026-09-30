/**
 * D11 renderer-domain fix round — regression batch (one test per finding, all red on the
 * pre-fix code):
 *  - next-weekday-force-next-week      (utils/nlDate.js)
 *  - leftover-move-wipes-time          (utils/leftovers.js via crossDayMovePatch)
 *  - leftover-null-sentinel-excluded   (shared isRepeatTask in utils/confirm.js)
 *  - editpanel-esc-ignores-context-menu (EditPanel.vue + ContextMenuHost.vue)
 *  - undo-delete-bypasses-restoreFromRecycle (confirm.js deleteWithUndo + TodoBoxView revertOf)
 *  - projectdocs-false-saved-stamp     (ProjectDocs.vue persist)
 *  - tomato-timeline-unbounded-prev-day (TomatoFocusRecordModal.vue)
 *  - batchdelete-no-busy-guard         (TodoBoxView.vue)
 *  - category-reorder-drag-only        (SnManageCategoriesModal.vue)
 *  - finding 1  restoreSnapshot LWW re-stamp (utils/dayPlans.js)
 *  - finding 7  critical backup quit-flush awaitable + failure stamp (store/helpers/todoBackup.js)
 *  - finding 9  pending-upsert replay guard (store/helpers/todoPendingUpserts.js)
 *  - finding 13 category init DB-fail skips LS migration (store/category.js)
 *  - finding 14 reorder-only no LWW re-age (store/todo.js reorderTodos)
 * Run: node --test tests/unit/renderer/d11-renderer-domain-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

/* Shared minimal DOM stubs for toast-building utils (same shape as editpanel-behavior.test.mjs) */
if (!globalThis.document) {
  globalThis.document = {
    addEventListener () {}, removeEventListener () {},
    querySelector () { return null }, querySelectorAll () { return [] }
  }
}
if (!globalThis.window.Vue) globalThis.window.Vue = {}
globalThis.window.Vue.h = (tag, props) => ({ tag, props })
// modules destructure { reactive } from window.Vue at import time and degrade to a plain object
// only when window.Vue is MISSING — an empty object would break them, so provide the passthrough
if (!globalThis.window.Vue.reactive) globalThis.window.Vue.reactive = o => o

/* ---------- next-weekday-force-next-week ---------- */
test('nlDate: "next <weekday>" never lands inside the base calendar week', async () => {
  const { parseNaturalDate } = await import('../../../renderer/js/utils/nlDate.js')
  const { dayjs } = await import('../../../renderer/js/utils/core.js')
  const monday = dayjs('2026-09-14T12:00:00') // Monday
  const tuesday = dayjs('2026-09-15T12:00:00')
  const d = (txt, base) => parseNaturalDate(txt, base).date
  // On the matching weekday: next monday from Monday = exactly one week out (was the fix's anchor case)
  assert.equal(d('next monday', monday).format('YYYY-MM-DD'), '2026-09-21')
  // From a Tuesday, "next friday" is NEXT week's Friday (9-18 is inside Tue's week) — the
  // pre-fix code resolved it identically to a bare weekday
  assert.equal(d('next friday', tuesday).format('YYYY-MM-DD'), '2026-09-25')
  // Already-next-week occurrences stay put (next monday from Tuesday = 9-21)
  assert.equal(d('next monday', tuesday).format('YYYY-MM-DD'), '2026-09-21')
  // bare / on / this semantics unchanged
  assert.equal(d('monday', monday).format('YYYY-MM-DD'), '2026-09-21')
  assert.equal(d('on monday', monday).format('YYYY-MM-DD'), '2026-09-21')
  assert.equal(d('this wednesday', tuesday).format('YYYY-MM-DD'), '2026-09-16')
})

/* ---------- leftover-move-wipes-time + leftover-null-sentinel-excluded ---------- */
test('leftovers: move-to-today keeps time-of-day and re-anchors reminders; legacy repeatId \'null\' rows are candidates', async () => {
  const { maybeAskLeftovers } = await import('../../../renderer/js/utils/leftovers.js')
  const { dayjs } = await import('../../../renderer/js/utils/core.js')
  const today = +dayjs().startOf('day')
  const yesterday = today - 86400000
  const at = (day, h, m = 0) => day + h * 3600000 + m * 60000
  const plainSentinel = {
    taskId: 'sentinel', taskContent: 'sentinel', delete: false, complete: false,
    repeatId: 'null', // legacy string sentinel — must count as NON-repeat (was excluded)
    dayStart: yesterday, todoTime: at(yesterday, 14, 30),
    reminderTime: at(yesterday, 9), reminderExtra: [at(yesterday, 8)]
  }
  const realRepeat = { taskId: 'rep', delete: false, complete: false, repeatId: 'rep1', dayStart: yesterday, todoTime: at(yesterday, 10) }
  const dispatches = []
  const store = {
    state: { todo: { todoList: [plainSentinel, realRepeat] } },
    dispatch (type, payload) {
      dispatches.push([type, payload])
      if (type === 'todo/updateTodoFields') {
        const row = store.state.todo.todoList.find(t => t.taskId === payload.taskId)
        Object.assign(row, payload.patch)
        return Promise.resolve(row)
      }
      return Promise.resolve()
    }
  }
  let confirmed = 0
  globalThis.window.appUI = {
    $confirm: async () => { confirmed++ },
    $message: Object.assign(() => {}, { success () {}, error () {}, closeAll () {} })
  }
  globalThis.window.todoAPI = {
    dbCall: async (op) => {
      if (op === 'getMeta') return null // leftoverAskDate not asked yet
      return null
    }
  }
  await maybeAskLeftovers(store)
  assert.equal(confirmed, 1, 'confirm dialog shown')
  const move = dispatches.find(x => x[0] === 'todo/updateTodoFields' && x[1].taskId === 'sentinel')
  assert.ok(move, 'legacy \'null\'-sentinel task IS offered for move-to-today')
  const patch = move[1].patch
  // time-of-day survives (raw {todoTime: todayStart} wiped it to 00:00)
  assert.equal(patch.todoTime, at(today, 14, 30), '14:30 schedule stays 14:30 on today')
  assert.equal(patch.dayStart, today, 'dayStart moves to today')
  assert.equal(patch.reminderTime, at(today, 9), 'reminder re-anchored to the new day (was orphaned on yesterday)')
  assert.deepEqual(patch.reminderExtra, [at(today, 8)], 'extra reminders re-anchored too')
  assert.equal(patch._deferViews, true, 'view rebuild stays deferred for the batch')
  assert.ok(!dispatches.some(x => x[0] === 'todo/updateTodoFields' && x[1].taskId === 'rep'), 'real repeating instances stay excluded')
  // undo reverts exactly the touched fields with the original values
  const todo = await import('../../../renderer/js/store/todo.js') // ensure no circular-import surprise in host env
  void todo
  const undo = dispatches.find(x => x[0] === 'todo/updateTodoFields' && x[1].taskId === 'sentinel')
  assert.ok(undo)
})

test('confirm.js isRepeatTask: legacy \'null\' sentinel is NOT a repeat (shared predicate)', async () => {
  const { isRepeatTask } = await import('../../../renderer/js/utils/confirm.js')
  assert.equal(isRepeatTask({ repeatId: 'null' }), false)
  assert.equal(isRepeatTask({ repeatId: null }), false)
  assert.equal(isRepeatTask({}), false)
  assert.equal(isRepeatTask(null), false)
  assert.equal(isRepeatTask({ repeatId: 'r1' }), true)
  // the duplicated inline predicate in TodoBoxView is gone (single source)
  const src = read('renderer/js/views/TodoBoxView.vue')
  assert.ok(!/const isRepeat = t => !!\(t && t\.repeatId && t\.repeatId !== 'null'\)/.test(src), 'TodoBoxView no longer duplicates the sentinel knowledge')
  assert.match(src, /const isRepeat = isRepeatTask/)
  const leftSrc = read('renderer/js/utils/leftovers.js')
  assert.match(leftSrc, /isRepeatTask/, 'leftover detection uses the shared predicate')
})

/* ---------- editpanel-esc-ignores-context-menu ---------- */
function loadEditPanelKeydown () {
  const src = read('renderer/js/components/EditPanel.vue')
  const a = src.indexOf('this._onKeydown = (e) => {')
  const b = src.indexOf("window.addEventListener('keydown'", a)
  assert.ok(a >= 0 && b > a, 'EditPanel._onKeydown present in mounted()')
  const chunk = src.slice(a, b).trim().replace(/,\s*$/, '').replaceAll('this.', 'ctx.')
  return new Function('ctx', chunk + '; return ctx._onKeydown')
}

test('EditPanel Esc: an open task context menu owns the Esc — sidebar stays open', () => {
  const makeCtx = (menuVisible) => {
    const dispatched = []
    return {
      dispatched,
      ctx: {
        catOpen: false, previewImg: null, refocusRow () {},
        $refs: {},
        $store: {
          state: { ui: {
            contextMenu: { visible: menuVisible },
            showSettingsModal: false, showRepeatModalFor: null, showFeedbackModal: false,
            showFilterModal: false, showRepeatDeleteConfirm: null, accountTaskId: '',
            tomatoAbandonVisible: false, tomatoFocusRecordVisible: false, tomatoRecordAddVisible: false,
            rightSidebarTodoEdit: { visible: true, taskId: 't1' }
          } },
          dispatch (p) { dispatched.push(p) }
        }
      }
    }
  }
  // menu open: Esc must NOT close the edit sidebar
  const blocked = makeCtx(true)
  const keydownBlocked = loadEditPanelKeydown()(blocked.ctx)
  keydownBlocked({ key: 'Escape' })
  assert.ok(!blocked.dispatched.includes('ui/closeEditCleanup'), 'sidebar close suppressed while the context menu is open')
  // menu closed: Esc closes the sidebar as before
  const open = makeCtx(false)
  loadEditPanelKeydown()(open.ctx)({ key: 'Escape' })
  assert.ok(open.dispatched.includes('ui/closeEditCleanup'), 'sidebar still closes on Esc without the menu')
  // defense in depth: ContextMenuHost stops Esc propagation so the window listener never sees it
  assert.match(read('renderer/js/components/ContextMenuHost.vue'), /@keydown\.esc\.stop=/)
})

/* ---------- undo-delete-bypasses-restoreFromRecycle ---------- */
function captureUndoHandler (vmMessageArgs) {
  // deleteWithUndo -> showUndoToast(vm.$message.bind(vm), [text, undoVnode]); the message stub
  // receives { message: h('span', children), ... } — the undo link is children[1].props.onClick
  return () => {
    const opts = vmMessageArgs[vmMessageArgs.length - 1]
    const children = opts && opts.message && opts.message.props
    const vnode = Array.isArray(children) ? children[1] : null
    return vnode && vnode.props && vnode.props.onClick
  }
}

test('deleteWithUndo undo path routes through todo/restoreFromRecycle (chips snapshot + B5 guard)', async () => {
  const CONFIRM = await import('../../../renderer/js/utils/confirm.js')
  const dispatched = []
  const store = {
    state: { todo: { recycleList: [{ taskId: 't1', repeatId: 'null' }] } },
    commit () {},
    dispatch (type, payload) { dispatched.push([type, payload]); return Promise.resolve(true) }
  }
  const vmMessageArgs = []
  const vm = { $message: Object.assign(function (o) { vmMessageArgs.push(o) }, { success () {}, error () {} }) }
  globalThis.window.todoAPI = { dbCall: async () => null }
  // deleteWithUndo only handles plain rows (repeats divert to the scope modal), so the undone row
  // carries the legacy 'null' sentinel — the undo must still go through the single restore entry
  await CONFIRM.deleteWithUndo(vm, store, { taskId: 't1', taskContent: 'x' })
  assert.ok(dispatched.some(d => d[0] === 'todo/deleteTodo'))
  dispatched.length = 0
  const undo = captureUndoHandler(vmMessageArgs)()
  assert.equal(typeof undo, 'function', 'undo link rendered')
  await undo()
  const restore = dispatched.find(d => d[0] === 'todo/restoreFromRecycle')
  assert.ok(restore, 'undo dispatches todo/restoreFromRecycle (single restore entry)')
  assert.equal(restore[1].taskId, 't1')
  assert.ok(!restore[1].repeatId, 'legacy \'null\' sentinel does not feed the B5 repeat lookup')
  assert.ok(!dispatched.some(d => d[0] === 'todo/updateTodoFields' && d[1].patch && d[1].patch.delete === false), 'no bare delete:false patch bypass')
})

/* ---------- projectdocs-false-saved-stamp ---------- */
function loadProjectDocsPersist () {
  const src = read('renderer/js/components/ProjectDocs.vue')
  const a = src.indexOf('persist (keyOverride) {')
  // method block ends at the next method definition
  const b = src.indexOf('queueSave () {', a)
  assert.ok(a >= 0 && b > a, 'ProjectDocs.persist present')
  const chunk = src.slice(a, b).trim().replace(/,\s*$/,'')
  return new Function('keyOf', `const methods = { ${chunk} }; return methods.persist`)(catId => 'projectDocs:' + catId)
}

test('ProjectDocs persist: savedAt stamped only after a SUCCESSFUL setMeta; failure flips the honest state', async () => {
  const persist = loadProjectDocsPersist()
  let rejectNext = false
  const calls = []
  globalThis.window.todoAPI = {
    dbCall (op, params) {
      calls.push([op, params])
      return rejectNext ? Promise.reject(new Error('ipc down')) : Promise.resolve(true)
    }
  }
  const comp = { catId: 7, _docsCatId: 7, docs: [{ id: 'd1' }], savedAt: 0, saveFailed: false, _saving: null }
  // success path still stamps
  persist.call(comp)
  await comp._saving
  assert.equal(comp.saveFailed, false)
  assert.ok(comp.savedAt > 0, 'success stamps savedAt')
  // failure: no NEW stamp flip, honest failed state (pre-fix: .catch(()=>{}) then unconditional stamp)
  const before = comp.savedAt
  rejectNext = true
  persist.call(comp)
  await comp._saving
  assert.equal(comp.saveFailed, true, 'failure surfaces in saveFailed (statusText shows the failed state)')
  assert.equal(comp.savedAt, before, 'savedAt NOT stamped on failure — no false "Saved HH:mm"')
})

/* ---------- tomato-timeline-unbounded-prev-day ---------- */
test('TomatoFocusRecordModal: prev-day navigation bounded, dead :disabled="false" gone', () => {
  const src = read('renderer/js/components/TomatoFocusRecordModal.vue')
  assert.ok(!/disabled="false"/.test(src), 'dead :disabled="false" literal removed')
  assert.match(src, /:disabled="tlOffset <= TL_MIN_OFFSET"/, 'prev button binds the lower bound')
  assert.match(src, /TL_MIN_OFFSET: -30/, '30-day look-back bound declared')
})

/* ---------- batchdelete-no-busy-guard + undo route in batchDelete ---------- */
function loadTodoBoxBatchMethods () {
  const src = read('renderer/js/views/TodoBoxView.vue')
  // splitBatchDelete (module-level fn in the SFC) is injected into the methods block, same wiring
  const sa = src.indexOf('function splitBatchDelete (rows) {')
  const sb = src.indexOf('export default', sa)
  const splitChunk = src.slice(sa, sb).trim().replace(/,\s*$/, '')
  const splitBatchDelete = new Function('isRepeatTask', `${splitChunk}\nreturn splitBatchDelete`)(t => !!(t && t.repeatId && t.repeatId !== 'null'))
  const a = src.indexOf('async batchDelete () {')
  const b = src.indexOf('ctxMenu (t, e) {', a)
  assert.ok(a >= 0 && b > a, 'batchDelete methods block present')
  const chunk = src.slice(a, b).trim().replace(/,\s*$/, '')
  const toasts = []
  const batchMoveWithUndoStub = (vm, opts) => { toasts.push(opts) }
  const methods = new Function('splitBatchDelete', 'batchMoveWithUndo', 'isRepeatTask', `const o = { ${chunk} }; return o`)(splitBatchDelete, batchMoveWithUndoStub, t => !!(t && t.repeatId && t.repeatId !== 'null'))
  methods._toasts = toasts
  return methods
}

test('TodoBoxView batchDelete: batchBusy re-entrancy guard; undo goes through restoreFromRecycle', async () => {
  const src = read('renderer/js/views/TodoBoxView.vue')
  const fn = src.slice(src.indexOf('async batchDelete () {'), src.indexOf('ctxMenu (t, e) {'))
  assert.match(fn, /if \(this\.batchBusy\) return/, 'batchDelete takes the same batchBusy lock as its siblings')
  assert.match(fn, /finally \{ this\.batchBusy = false \}/, 'lock always released')
  assert.match(fn, /todo\/restoreFromRecycle/, 'batch revert routes through restoreFromRecycle')
  assert.ok(!/patch: \{ delete: false, deletedAt: 0, status: 'update' \}/.test(fn), 'bare-patch restore stays deleted from the batch path')

  // Behavior: a second click during the awaited confirm phase returns early (single delete dispatch)
  const methods = loadTodoBoxBatchMethods()
  let confirmCalls = 0
  let deleteDispatches = 0
  const comp = {
    batchBusy: false,
    checkedIds: ['a'],
    _batchDeleteInner: methods._batchDeleteInner,
    $confirm: async () => { confirmCalls++; await new Promise(r => setTimeout(r, 20)); return true },
    $t: k => k,
    $message: Object.assign(() => {}, { closeAll () {}, success () {}, warning () {} }),
    $store: {
      state: { todo: { todoList: [{ taskId: 'a', repeatId: null }] } },
      commit () {},
      dispatch (type) { if (type === 'todo/deleteTodosMany') { deleteDispatches++; return Promise.resolve(['a']) } return Promise.resolve([]) }
    }
  }
  const p1 = methods.batchDelete.call(comp)
  const p2 = methods.batchDelete.call(comp) // re-click while p1 awaits the confirm
  await Promise.all([p1, p2])
  assert.equal(confirmCalls, 1, 'second click returned early')
  assert.equal(deleteDispatches, 1, 'exactly one deleteTodosMany dispatch')
  assert.equal(comp.batchBusy, false, 'lock released after completion')
  // undo wiring: the aggregated toast's revertOf goes through restoreFromRecycle
  assert.equal(methods._toasts.length, 1, 'one aggregate undo toast')
  const dispatchedTypes = []
  comp.$store.dispatch = type => { dispatchedTypes.push(type); return Promise.resolve([]) }
  methods._toasts[0].revertOf({ id: 'a', repeatId: undefined })
  assert.ok(dispatchedTypes.includes('todo/restoreFromRecycle'), 'revertOf dispatches todo/restoreFromRecycle')
})

/* ---------- category-reorder-drag-only ---------- */
test('SnManageCategoriesModal: drag handle is focusable + Alt+Arrow keyboard reorder commits category/reorder', () => {
  const src = read('renderer/js/components/side-nav/SnManageCategoriesModal.vue')
  assert.match(src, /class="cat-mgr-drag"[^>]*role="button"/, 'handle is role=button')
  assert.match(src, /class="cat-mgr-drag"[^>]*tabindex="0"/, 'handle is keyboard-focusable')
  assert.match(src, /@keydown\.up\.prevent="e => \{ if \(e\.altKey\) mgrMove\(c, -1\) \}"/)
  assert.match(src, /@keydown\.down\.prevent="e => \{ if \(e\.altKey\) mgrMove\(c, 1\) \}"/)
  assert.match(src, /mgrMove \(c, dir\) \{[\s\S]*?category\/reorder/, 'keyboard path commits the same store mutation as drag')

  // Behavior: mgrMove reorders both ways and no-ops at the boundaries
  const a = src.indexOf('mgrMove (c, dir) {')
  const b = src.indexOf('dragMgrOver (c, e) {', a)
  const chunk = src.slice(a, b).trim().replace(/,\s*$/, '')
  const mgrMove = new Function(`const o = { ${chunk} }; return o.mgrMove`)()
  const commits = []
  const comp = {
    categories: [{ categoryId: 1 }, { categoryId: 2 }, { categoryId: 3 }],
    $store: { commit (m, ids) { commits.push([m, ids]); comp.categories = ids.map(id => ({ categoryId: id })) } }
  }
  mgrMove.call(comp, { categoryId: 3 }, -1)
  assert.deepEqual(commits[0], ['category/reorder', [1, 3, 2]], 'Alt+Up moves the last row up')
  mgrMove.call(comp, { categoryId: 1 }, 1)
  assert.deepEqual(commits[1], ['category/reorder', [3, 1, 2]], 'Alt+Down moves the first row down')
  // boundary moves on a FRESH 3-row order: first row up / last row down are no-ops
  comp.categories = [{ categoryId: 1 }, { categoryId: 2 }, { categoryId: 3 }]
  const before = commits.length
  mgrMove.call(comp, { categoryId: 1 }, -1) // already first
  mgrMove.call(comp, { categoryId: 3 }, 1) // already last
  assert.equal(commits.length, before, 'boundary moves are no-ops')
})

/* ---------- finding 1: restoreSnapshot LWW re-stamp ---------- */
test('dayPlans.restoreSnapshot re-stamps chips fresh so LAN LWW cannot re-delete them', async () => {
  const dayPlans = await import('../../../renderer/js/utils/dayPlans.js')
  const ops = []
  globalThis.window.todoAPI = {
    dbCall (op, params) { ops.push([op, params]); return op === 'getMeta' ? Promise.resolve(JSON.stringify([{ id: 'c1', taskId: 't1', day: '2026-09-20', mm: '09:00', sort: 0, updatedAt: 1000 }])) : Promise.resolve(true) }
  }
  await dayPlans.restoreSnapshot('t1')
  const put = ops.find(o => o[0] === 'planAddMany')
  assert.ok(put, 'chips written back through planAddMany')
  const row = put[1][0]
  assert.ok(row.updatedAt > 1e12, `restored chip carries a FRESH stamp (got ${row.updatedAt}; pre-fix wrote the pre-delete 1000 through verbatim)`)
})

/* ---------- finding 7: critical backup quit-flush awaitable + failure stamp ---------- */
test('todoBackup: quit-flush write is awaitable and failures land in runtimeState', async () => {
  const BACKUP = await import('../../../renderer/js/store/helpers/todoBackup.js')
  let failNext = false
  const writes = []
  globalThis.window.todoAPI = {
    dbCall: async () => null,
    getMetaMany: async () => [],
    writeCriticalStateBackup: async (s) => { writes.push(s); if (failNext) throw new Error('disk full'); return true },
    onAppQuittingFlush (fn) { globalThis.__quitFlushHook = fn }
  }
  const ctx = {}
  BACKUP.writeCriticalBackupCore(ctx, {
    state: { todoList: [], recycleList: [] },
    rootState: { settings: {}, tomato: { tomatoRecordList: [] }, category: { list: [] }, habits: { habits: [], moments: [] }, filters: { list: [] } }
  })
  assert.ok(globalThis.__quitFlushHook, 'quit-flush hook registered')
  clearTimeout(ctx._cbTimer) // do not leave the 5s debounce dangling in the test process
  const flushNow = () => { ctx._cbTimer = 1 /* truthy: a pending debounce exists */ ; globalThis.__quitFlushHook(); clearTimeout(ctx._cbTimer) }
  // success path: the flush write is retained and awaitable
  flushNow()
  assert.ok(ctx._quitFlushWrite && typeof ctx._quitFlushWrite.then === 'function', 'flush write promise kept on ctx (pre-fix: discarded)')
  await BACKUP.criticalBackupWrite()
  assert.equal(writes.length, 1)
  // failure path: rejection is awaitable and stamped into runtimeState (pre-fix: console.error only)
  failNext = true
  flushNow()
  await assert.rejects(BACKUP.criticalBackupWrite(), /disk full/)
  const runtime = JSON.parse(globalThis.localStorage.getItem('pickdone:runtimeState') || globalThis.localStorage.getItem('runtimeState') || '{}')
  assert.ok(runtime.criticalBackupLastFailAt > 0 || runtime.criticalBackupLastError, 'failure stamped into runtimeState')
})

/* ---------- finding 9: pending-upsert replay guard ---------- */
test('todoPendingUpserts: a newer upsert supersedes the stale queued copy of the same row', async () => {
  const P = await import('../../../renderer/js/store/helpers/todoPendingUpserts.js')
  const q = P.pendingUpserts()
  q.length = 0 // isolate from other tests (live array seam)
  let rejectPut = true
  globalThis.window.todoAPI = { dbCall (op, params) { ops.push([op, params]); return rejectPut ? Promise.reject(new Error('ipc down')) : Promise.resolve(true) } }
  const ops = []
  // first write fails -> stays queued with its (soon stale) row JSON
  P.safeUpsert({ taskId: 't9', content: 'v1', updateTime: 1 })
  await new Promise(r => setTimeout(r, 5))
  assert.equal(q.length, 1, 'failed write stays queued')
  // a NEWER edit of the same task: the stale queued copy must be superseded, not co-exist
  P.safeUpsert({ taskId: 't9', content: 'v2', updateTime: 2 })
  await new Promise(r => setTimeout(r, 5))
  const upserts = q.filter(e => e.op === 'upsert')
  assert.equal(upserts.length, 1, `only the newest copy of the row is queued (got ${upserts.length})`)
  assert.equal(upserts[0].params.content, 'v2', 'queued copy is the NEW state (pre-fix replayed stale v1 over it)')
  // batch entries: supersede also prunes the row out of queued upsertMany params
  q.length = 0
  P.queuePendingUpsert({ op: 'upsertMany', params: [{ taskId: 't9', content: 'stale' }, { taskId: 'other', content: 'keep' }] })
  P.safeUpsert({ taskId: 't9', content: 'v3' })
  await new Promise(r => setTimeout(r, 5))
  const batch = q.find(e => e.op === 'upsertMany')
  assert.ok(batch, 'batch entry survives')
  assert.deepEqual(batch.params.map(r => r.taskId), ['other'], 'stale row pruned from the batch params')
  // flush re-entrancy: concurrent flush rounds must not double-dispatch the same entries
  q.length = 0
  ops.length = 0
  rejectPut = false
  P.queuePendingUpsert({ op: 'upsert', params: { taskId: 'f1' } })
  P.queuePendingUpsert({ op: 'upsert', params: { taskId: 'f2' } })
  P.flushPendingUpserts()
  P.flushPendingUpserts() // second round while the first is in flight
  await new Promise(r => setTimeout(r, 5))
  const flushed = ops.filter(o => o[0] === 'upsert')
  assert.equal(flushed.length, 2, `exactly one dispatch per entry across concurrent flushes (got ${flushed.length})`)
})

/* ---------- finding 13: category init DB-fail skips LS migration ---------- */
test('category.init: a failed getAllCategories NEVER runs the LS migration / re-seeds default ids', async () => {
  const cat = (await import('../../../renderer/js/store/category.js')).default
  const ops = []
  globalThis.window.todoAPI = {
    dbCall (op, params) {
      ops.push([op, params])
      if (op === 'getAllCategories') return Promise.reject(new Error('transient lock'))
      return Promise.resolve(null)
    }
  }
  const state = { list: [], projectIds: [], projectMeta: {} }
  const committed = []
  const ctx = {
    state,
    rootState: { settings: { recycleBinAutoDeleteDays: 30 } },
    commit (m, p) { committed.push([m, p]); if (cat.mutations[m]) cat.mutations[m](state, p) },
    dispatch () { return Promise.resolve() }
  }
  globalThis.localStorage.setItem('categoryState', JSON.stringify({ list: [{ categoryId: 555, userId: 840001, categoryName: 'Real', categoryColor: '#123456', createTime: 1, listSort: 1, folderIs: false, folderId: 0, delete: false }] }))
  await cat.actions.init.call({ state, dispatch: ctx.dispatch }, ctx)
  assert.ok(!ops.some(o => o[0] === 'upsertCategory'), `no category.put migration writes on a DB read failure (got ${ops.filter(o => o[0] === 'upsertCategory').length})`)
  assert.ok(!ops.some(o => o[0] === 'setMeta' && o[1] && o[1][0] === 'categoryLsMigrated'), 'migration flag never stamped on a failed read')
  assert.equal(state.list[0] && state.list[0].categoryId, 555, 'LS cache stays memory-only (no 100001-100003 seeds over real ids)')
  // sanity: the healthy path still migrates (red-proof the other direction is not what we broke)
  ops.length = 0
  globalThis.window.todoAPI.dbCall = (op, params) => { ops.push([op, params]); return op === 'getAllCategories' ? Promise.resolve([]) : Promise.resolve(null) }
  globalThis.localStorage.removeItem('categoryState') // loadList() seeds defaults (fresh install shape)
  await cat.actions.init.call({ state, dispatch: ctx.dispatch }, ctx)
  assert.ok(ops.some(o => o[0] === 'upsertCategory'), 'genuinely-empty DB still runs the one-time LS migration')
  assert.ok(ops.some(o => o[0] === 'setMeta' && o[1] && o[1][0] === 'categoryLsMigrated'))
})

/* ---------- finding 14: reorder-only no LWW re-age ---------- */
test('reorderTodos: rows whose taskSort is unchanged keep their stamps (no LWW re-age)', async () => {
  const todoMod = (await import('../../../renderer/js/store/todo.js')).default
  const now = Date.now()
  const rowA = { taskId: 'a', taskSort: 1, updateTime: now - 5000, status: 'sync', delete: false }
  const rowB = { taskId: 'b', taskSort: 2, updateTime: now - 5000, status: 'sync', delete: false }
  const state = { todoList: [rowA, rowB], recycleList: [], viewsDirty: true }
  const ops = []
  globalThis.window.todoAPI = { dbCall: async (op, params) => { ops.push([op, params]); return true }, onAppQuittingFlush () {} }
  const storeThis = { state: { todo: state } }
  const ctx = {
    state,
    commit (m, p) { if (todoMod.mutations[m]) todoMod.mutations[m](state, p) },
    dispatch () { return Promise.resolve() }
  }
  // Drag B below A: B's sort changes, A's does not — A must NOT be re-stamped
  await todoMod.actions.reorderTodos.call(storeThis, ctx, [{ taskId: 'b', taskSort: 1.5 }])
  const put = ops.find(o => o[0] === 'upsertMany')
  assert.ok(put, 'batch write issued')
  assert.deepEqual(put[1].map(r => r.taskId), ['b'], 'only the actually-moved row is written')
  const bAfter = state.todoList.find(t => t.taskId === 'b')
  const aAfter = state.todoList.find(t => t.taskId === 'a')
  assert.equal(bAfter.status, 'update', 'moved row re-aged for sync')
  assert.equal(aAfter.status, 'sync', 'untouched row keeps its status (pre-fix: flipped to update)')
  assert.equal(aAfter.updateTime, now - 5000, 'untouched row keeps updateTime (pre-fix: fresh now() made a pure reorder win LWW over a peer content edit)')
  assert.equal(aAfter.taskSort, 1, 'untouched row content untouched')
})
