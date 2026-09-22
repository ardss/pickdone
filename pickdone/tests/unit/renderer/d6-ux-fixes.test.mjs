/**
 * D6 UX/views maintenance round (renderer) — regression guards.
 * Fixes covered:
 *   [F1] calendar inline-create orphan cleanup: ui/closeEditCleanup + ui/collapseEditCleanup
 *        soft-delete the inline-created task ONLY while it is still unnamed (store-level, fake todo module)
 *   [F13] multi-term search highlights each term (not the raw whole-query string)
 *   [F2/F3/F5/F6/F11] shortcut dispatch wiring in main.js (source anchors)
 * Run: node --test tests/unit/renderer/d6-ux-fixes.test.mjs
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

/* ---------- [F2r/F6r] review round 2026-09-22: flush-before-cleanup + shared undo restore path ---------- */

test('[F2r] closeEditCleanup awaits the EditPanel flush hook — a title landing via the flush survives', async () => {
  const { store, deletes } = makeStore({ todoList: [{ taskId: TASK, taskContent: '' }] })
  openInline(store)
  let flushed = 0
  // Simulates the panel's save queue: the fast typist's title commits during the awaited flush
  globalThis.window.__editPanelFlushSave = async () => {
    flushed++
    store.state.todo.todoList[0].taskContent = 'fast typist title'
  }
  try {
    await store.dispatch('ui/closeEditCleanup')
    assert.equal(flushed, 1, 'the panel flush ran exactly once before the emptiness check')
    assert.deepEqual(deletes, [], 'just-titled task must NOT be orphan-deleted (was: 60ms sleep raced the 350ms debounce)')
  } finally { delete globalThis.window.__editPanelFlushSave }
})

test('[F2r] a task still empty after the flush is still orphan-cleaned (semantics kept)', async () => {
  const { store, deletes } = makeStore({ todoList: [{ taskId: TASK, taskContent: '' }] })
  openInline(store)
  globalThis.window.__editPanelFlushSave = async () => { /* flush landed nothing: task stays empty */ }
  try {
    await store.dispatch('ui/closeEditCleanup')
    assert.deepEqual(deletes, [TASK], 'empty-content cleanup semantics unchanged')
  } finally { delete globalThis.window.__editPanelFlushSave }
})

test('[F6r] inline-orphan undo routes through todo/restoreFromRecycle (chips survive, like the recycle bin)', () => {
  const src = read('renderer/js/store/ui.js')
  assert.ok(src.includes("dispatch('todo/restoreFromRecycle'"), 'undo uses the shared restore path (updateTodoFields + planChips restoreSnapshot)')
  assert.ok(!src.includes("patch: { delete: false, deletedAt: 0, status: 'update' }"), 'raw delete:false patch is gone')
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

/* ---------- [F2/F3/F5/F6/F11] shortcut dispatch wiring (source anchors; main.js boots a full app) ---------- */

test('[F2/F3] Ctrl+N and addEvent route through focusQuickAdd with an unmounted-bar fallback', () => {
  const src = read('renderer/js/main.js')
  assert.ok(src.includes('const focusQuickAdd = () => {'), 'focusQuickAdd helper defined')
  assert.ok(/if \(document\.querySelector\('\.qa-wrap'\)\)/.test(src), 'mounted-bar probe present')
  assert.ok(src.includes("router.push({ name: 'todo-list-today' }).then("), 'fallback routes to Today when the bar is unmounted')
  assert.ok(src.includes('focusQuickAdd()'), 'keydown handler delegates to the helper')
  assert.ok(src.includes("case 'addEvent': focusQuickAdd(); break"), 'addEvent shortcut is dispatched (was a dead binding)')
})

test('[F5] pin/unpin announces state and refuses silently no-op when sort is not custom', () => {
  const src = read('renderer/js/main.js')
  assert.ok(src.includes("normalizeSortMode(store.state.settings.sortMode) !== 'custom'"), 'custom-sort guard present')
  assert.ok(src.includes('statsH.main.pinIgnoredSort'), 'non-custom sort shows an info instead of a silent no-op')
  assert.ok(src.includes('statsH.main.pinned') && src.includes('statsH.main.unpinned'), 'pin/unpin result is announced')
})

test('[F6] switchToRecentTodos respects the today-x nav gate', () => {
  const src = read('renderer/js/main.js')
  assert.ok(/switchToRecentTodos[\s\S]{0,200}showTodayXModule === true[\s\S]{0,120}todo-list-today-x[\s\S]{0,80}todo-list-today/.test(src),
    'dev-gated today-x route; everyone else lands on Today')
})

test('[F11] deleteEvent with no selection shows an info instead of staying silent', () => {
  assert.ok(read('renderer/js/main.js').includes('statsH.main.deleteNoSelection'), 'no-selection info anchor')
})

test('i18n parity: new statsH.main keys exist in BOTH zh and en shards', () => {
  for (const k of ['deleteNoSelection', 'pinIgnoredSort', 'pinned', 'unpinned']) {
    assert.ok(read('renderer/js/i18n/locales/zh-CN-H.js').includes(k + ':'), 'zh missing ' + k)
    assert.ok(read('renderer/js/i18n/locales/en-US-H.js').includes(k + ':'), 'en missing ' + k)
  }
})

/* ---------- [F4/F5cat] category delete: busy state, failure isolation, undo doctrine (anchors) ---------- */

test('[F4/F5cat] delCat is failure-isolated, row-busy guarded and undo-toast driven', () => {
  const nav = read('renderer/js/components/SideNav.vue')
  assert.ok(nav.includes('catBusyId != null) return'), 're-entry guard on the busy flag')
  assert.ok(nav.includes('deleteCategoryWithUndo'), 'shared delete exit wired into the sidebar')
  assert.ok(nav.includes('catBusyId===o.categoryId'), 'row carries the busy state')
  const shared = read('renderer/js/components/side-nav/categoryDelete.js')
  assert.ok(shared.includes('delCatPartialFail'), 'partial-failure toast reports ok/total')
  assert.ok(shared.includes('delCatUndone'), 'undo toast names the cascade (tasks + saved filters)')
  assert.ok(shared.includes('collectCascadeIds'), 'cascade victims counted via the pure store helper')
  assert.ok(shared.includes("commit('category/recover'"), 'undo restores the category flags')
  assert.ok(shared.includes("dispatch('filters/save'"), 'undo re-puts the purged saved filters')
  const modal = read('renderer/js/components/side-nav/SnManageCategoriesModal.vue')
  assert.ok(modal.includes('deleteCategoryWithUndo'), 'manage-categories modal uses the same shared exit')
  assert.ok(!modal.includes('delCatConfirm'), 'modal no longer double-confirms (doctrine inverted)')
})

test('i18n parity: delCat keys in BOTH zh and en G shards', () => {
  for (const k of ['delCatPartialFail', 'delCatUndone']) {
    assert.ok(read('renderer/js/i18n/locales/zh-CN-G.js').includes(k + ':'), 'zh missing ' + k)
    assert.ok(read('renderer/js/i18n/locales/en-US-G.js').includes(k + ':'), 'en missing ' + k)
  }
})

/* ---------- [F7] RepeatModal: per-date failure isolation + one summary toast (anchors) ---------- */

test('[F7] generate() isolates per-date failures and merges toasts into one summary', () => {
  const src = read('renderer/js/components/RepeatModal.vue')
  assert.ok(/for \(let i = 0; i < dates\.length; i\+\+\)[\s\S]{0,600}try \{[\s\S]{0,1200}catch \(e\) \{[\s\S]{0,400}failed\+\+/.test(src),
    'each addTodo is wrapped in try/catch counting failures')
  assert.ok(src.includes('statsD.RepeatModal.partialFail'), 'summary reports failed/total')
  assert.ok(src.includes('statsD.RepeatModal.renewalDisabledWarn'), 'rule-save failure appends the renewal-disabled warning')
  // the old contradictory pattern (success toast + standalone ruleSaveFailed warning) must be gone
  assert.ok(!/\$message\.warning\(this\.\$t\('statsD\.RepeatModal\.ruleSaveFailed'\)\)/.test(src), 'no standalone rule-save-failed toast')
  assert.ok(src.indexOf("commit('ui/askRepeatEdit', null)") < src.indexOf('$message.warning(msg)'), 'modal closes before the summary toast')
})

test('i18n parity: RepeatModal keys in BOTH zh and en D shards', () => {
  for (const k of ['partialFail', 'renewalDisabledWarn']) {
    assert.ok(read('renderer/js/i18n/locales/zh-CN-D.js').includes('"' + k + '"'), 'zh missing ' + k)
    assert.ok(read('renderer/js/i18n/locales/en-US-D.js').includes('"' + k + '"'), 'en missing ' + k)
  }
})

/* ---------- [F8] WeatherWidget: stale flag after final retry failure (anchors) ---------- */

test('[F8] weather dims cached temps and offers an explicit refresh affordance when stale', () => {
  const src = read('renderer/js/components/WeatherWidget.vue')
  assert.ok(src.includes("'is-stale': stale"), 'stale state class on the widget shell')
  assert.ok(src.includes('w-stale-chip'), 'explicit refresh chip rendered when stale')
  assert.ok(/_retryCount > 2 && this\.temp !== null\) this\.stale = true/.test(src), 'stale flips on only after the final retry with cached data')
  assert.ok(src.includes('this.stale = false'), 'a successful fetch clears the stale flag')
  assert.ok(src.includes('staleTitle'), 'title explains the stale state')
})

test('i18n parity: WeatherWidget stale keys in BOTH zh and en D shards', () => {
  for (const k of ['staleTitle', 'staleChip']) {
    assert.ok(read('renderer/js/i18n/locales/zh-CN-D.js').includes('"' + k + '"'), 'zh missing ' + k)
    assert.ok(read('renderer/js/i18n/locales/en-US-D.js').includes('"' + k + '"'), 'en missing ' + k)
  }
})

/* ---------- [F9] EditPanel: width restore + save-failed Retry (anchors) ---------- */

test('[F9] auto-widen remembers pre-open width and restores it on close', () => {
  const src = read('renderer/js/layout.vue')
  assert.ok(src.includes('_preEditWidth'), 'pre-open width is remembered')
  assert.ok(src.includes('restoreWindowWidth'), 'restore call on close')
  const preload = read('src/preload/index.js')
  assert.ok(preload.includes('restoreWindowWidth: w => invoke('), 'preload exposes restoreWindowWidth')
  const handler = read('src/main/handlers/tomato.js')
  assert.ok(handler.includes("'restore-window-width'"), 'main handler shrinks the window back')
  assert.ok(handler.includes('isMaximized'), 'restore never fights a maximized window')
})

test('[F9] save-failed banner has a working Retry that flushes the queue', () => {
  const src = read('renderer/js/components/EditPanel.vue')
  assert.ok(src.includes('retrySave'), 'retrySave handler present')
  assert.ok(/retrySave[\s\S]{0,200}this\.saveFailed = false[\s\S]{0,80}this\.flushSave\(\)/.test(src), 'retry clears the flag and flushes pending saves')
  assert.ok(src.includes('statsJ.EditPanel.saveRetry'), 'retry button labeled')
})

test('i18n parity: EditPanel saveRetry in BOTH zh and en J shards', () => {
  assert.ok(read('renderer/js/i18n/locales/zh-CN-J.js').includes('saveRetry'), 'zh missing saveRetry')
  assert.ok(read('renderer/js/i18n/locales/en-US-J.js').includes('saveRetry'), 'en missing saveRetry')
})

/* ---------- [F10] statistics custom range: inverted picks swap in place (anchor) ---------- */

test('[F10] applyCustomRange swaps an inverted pick in the visible draft before applying', () => {
  const src = read('renderer/js/views/StatisticsView.vue')
  const start = src.indexOf('applyCustomRange () {')
  assert.ok(start >= 0, 'applyCustomRange found')
  const body = src.slice(start, start + 1400)
  assert.ok(/isBefore[\s\S]{0,200}customDraft = \[this\.customDraft\[1\], this\.customDraft\[0\]\]/.test(body),
    'inverted draft is swapped in place (visible selection matches the applied range)')
  assert.ok(body.indexOf('isBefore') < body.indexOf('customDraftDays > CUSTOM_MAX_DAYS'), 'swap happens BEFORE the cap check')
})

/* ---------- [F12] quick-add window: draft survives Esc-hide (anchor) ---------- */

test('[F12] QuickAddPage persists the draft on Esc and restores it on reopen', () => {
  const src = read('renderer/js/views/QuickAddPage.vue')
  assert.ok(src.includes("const DRAFT_KEY = 'quickAddDraft'"), 'draft storage key defined')
  const iEsc = src.indexOf('Escape')
  // Review P3 2026-09-22: persistence extracted into persistDraft(); Esc still persists before hiding
  assert.ok(iEsc > -1 && iEsc < src.indexOf('window.todoAPI.quickAddHide()') && /persistDraft \(\) \{/.test(src), 'Esc persists the draft before hiding')
  assert.ok(/getItem\(DRAFT_KEY\)[\s\S]{0,200}qa\.text = draft/.test(src), 'reopen restores the draft into the input')
  assert.ok(/onQuickAddFocus[\s\S]{0,300}restoreDraft\(\)/.test(src), 'focus callback restores the draft (window is hidden-not-destroyed)')
  assert.ok(/addEventListener\('blur', this\.persistDraft\)/.test(src), 'blur-hide also persists the draft')
  assert.ok(/onCreated[\s\S]{0,200}removeItem\(DRAFT_KEY\)/.test(src), 'a successful creation consumes the draft')
})

/* ---------- [F14] backup dump/restore carries plan chips + saved filters ---------- */

test('[F14] buildBackupDump includes planState + filterState; writers read chips at dump time', async () => {
  const filters = [{ id: 3, name: 'work', conds: { catId: 1 } }]
  const { buildBackupDump, collectPlanState } = await import('../../../renderer/js/store/todoBackup.js')
  const rootState = {
    settings: {}, auth: { user: null, lastLoginRecord: null },
    tomato: { tomatoRecordList: [] }, category: { list: [] },
    habits: { habits: [], moments: [], savedAt: 0 },
    filters: { list: filters }
  }
  const state = { search: '', todoList: [], recycleList: [], version: 0, remoteVersion: 0, todayTimestamp: 0, ignoreReminder: false, todosVersion: 0 }
  if (!globalThis.window.location) globalThis.window.location = { hash: '' }
  globalThis.window.localStorage = globalThis.window.localStorage || { getItem: () => null }
  const dump = buildBackupDump(rootState, state, { planState: JSON.stringify({ schemaV: 1, chips: [] }) })
  const segs = dump.backup
  assert.ok(segs.filterState && JSON.parse(segs.filterState).list.length === 1, 'saved filters ride the dump')
  assert.ok(segs.planState && JSON.parse(segs.planState).chips, 'plan chips segment included when provided')
  assert.ok(buildBackupDump(rootState, state).backup.planState === undefined, 'planState absent when the caller could not read chips (dropped by JSON.stringify)')
  assert.equal(typeof collectPlanState, 'function', 'collectPlanState exported for async chip reads')
})

test('[F14] restore pipeline consumes filterState + planState segments (source anchors)', () => {
  const src = read('renderer/js/components/settings/SettingsDataTab.vue')
  assert.ok(src.includes('restoreSavedFilters') && src.includes("commitCommand('filter', 'putMany'"), 'filters re-put idempotently by id')
  assert.ok(src.includes('restorePlanChips') && src.includes("commitCommand('plan', 'putMany'"), 'chips re-put idempotently by id')
  assert.ok(src.includes('day-plans-changed'), 'DayRail is pinged to reload after a chip restore')
  assert.ok(/failed\.push\('filters'\)/.test(src) && /failed\.push\('planChips'\)/.test(src), 'segment failures are reported honestly')
})

/* ---------- [F15] XLSX export: priority + completedAt columns ---------- */

test('[F15] export rows gain priority + completedAt; header + guard updated to 17 in both locales', () => {
  const tab = read('renderer/js/components/settings/SettingsDataTab.vue')
  assert.ok(tab.includes('t.priority || 0,') && tab.includes("t.completedAt ? dayjs(t.completedAt).format(FMT.dateTime) : ''"), 'rows append priority + completedAt')
  const guard = read('src/main/export-xlsx.js')
  assert.ok(guard.includes('head.length !== 17'), 'column guard raised to 17')
  assert.ok(guard.includes("mergeCells('A1:Q1')"), 'title merge spans the new columns')
  const zh = read('src/main/i18n.js')
  for (const seg of ['优先级,完成时间', 'Priority,Completed at']) {
    assert.ok(zh.includes(seg), 'exportCols updated: ' + seg)
  }
  const m = zh.match(new RegExp("exportCols: '([^']+)'"))
  assert.equal(m[1].split(',').length, 17, 'header has exactly 17 columns')
})
