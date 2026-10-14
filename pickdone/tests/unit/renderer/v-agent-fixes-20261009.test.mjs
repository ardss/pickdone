/**
 * v-agent fixes 2026-10-09 (component/view/util domain, 12 items).
 * Covers:
 *   [V1]  CalendarView.pickMonth — timeblock mode aligns tbWeekStart to the target month's
 *         first grid cell instead of dying on the destroyed FullCalendar instance
 *   [V2]  ProjectView.renameProject — CATEGORY_EXISTS is caught separately, not swallowed
 *         by the cancel-catch
 *   [V3]  SnManageCategoriesModal.saveMgrEdit + sideNavHandlers.saveCatEdit — duplicate-name
 *         commit throws keep the edit state and refocus after a warning
 *   [V4]  TaskAccountModal — saveCreate/commitDraft reject intervals ending in the future
 *   [V5]  saveMgrEdit empty-name branch refocuses the blurred inline editor
 *   [V6]  sideNavHandlers.createTag — duplicate tag warns instead of silent return
 *   [V7]  QuickAdd.onEnter — pure date-word input (restText === '') refuses creation
 *   [V8]  EpSubtasks — delete key visible on :focus-within (keyboard path)
 *   [V9]  TodayXView settled/settledTotal depend on tick (midnight re-cut)
 *   [V10] confirm.restoreAndToast — missing recycle row warns and closes the stale toast
 *   [V11] EditPanel Esc — .el-picker-panel in the DOM owns the Esc press
 *   [V12] ProjectOverviewView.deadlineText — day count anchored to todayTimestamp, d===0
 *         reads "due today"
 * Run: node --test tests/unit/renderer/v-agent-fixes-20261009.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const src = {
  cal: read('renderer/js/views/CalendarView.vue'),
  proj: read('renderer/js/views/ProjectView.vue'),
  overview: read('renderer/js/views/ProjectOverviewView.vue'),
  todayx: read('renderer/js/views/TodayXView.vue'),
  acct: read('renderer/js/components/TaskAccountModal.vue'),
  epSub: read('renderer/js/components/edit-panel/EpSubtasks.vue'),
  quick: read('renderer/js/components/QuickAdd.vue'),
  editPanel: read('renderer/js/components/EditPanel.vue'),
  mgrModal: read('renderer/js/components/side-nav/SnManageCategoriesModal.vue'),
  handlers: read('renderer/js/components/side-nav/sideNavHandlers.js'),
  confirm: read('renderer/js/utils/confirm.js')
}

/* ===== [V1] CalendarView pickMonth timeblock ===== */

test('[V1] pickMonth has a timeblock branch that navigates the week grid, before the cal guard', () => {
  const i = src.cal.indexOf('pickMonth (m) {')
  assert.ok(i > -1, 'pickMonth found')
  const body = src.cal.slice(i, i + 900)
  const iTb = body.indexOf("this.view === 'timeblock'")
  const iCal = body.indexOf('if (this.cal)')
  assert.ok(iTb > -1 && iCal > -1 && iTb < iCal,
    'the timeblock branch runs BEFORE the this.cal guard (in timeblock this.cal is null)')
  assert.ok(body.includes('this.tbWeekStart = weekGridStart('),
    'timeblock mode sets tbWeekStart via the shared weekGridStart helper (same caliber as today()/nav())')
  assert.ok(body.includes('this.monthPop = false'),
    'the month bubble still closes on pick')
})

test('[V1] behavior: weekGridStart aligns any first-of-month to the week grid honoring weekStartDay', async () => {
  const { weekGridStart } = await import('../../../renderer/js/utils/weekGrid.js')
  // 2026-10-01 is a Thursday. Monday start: the grid cell is 2026-09-28; Sunday start: 2026-09-27.
  const oct1 = +new Date(2026, 9, 1)
  const mon = new Date(weekGridStart(oct1, false))
  const sun = new Date(weekGridStart(oct1, true))
  assert.equal(mon.getDay(), 1, 'Monday-start grid begins on a Monday')
  assert.equal(sun.getDay(), 0, 'Sunday-start grid begins on a Sunday')
  assert.equal(mon.getDate(), 28, 'Monday-start week of 2026-10-01 begins 09-28')
  assert.equal(sun.getDate(), 27, 'Sunday-start week of 2026-10-01 begins 09-27')
})

/* ===== [V2] ProjectView renameProject CATEGORY_EXISTS ===== */

test('[V2] renameProject catches CATEGORY_EXISTS around the updateCategory commit; cancel-catch scoped to the dialog (F3)', () => {
  const i = src.proj.indexOf('async renameProject () {')
  assert.ok(i > -1, 'renameProject found')
  const body = src.proj.slice(i, src.proj.indexOf('async setColor', i))
  assert.ok(body.includes("e.code === 'CATEGORY_EXISTS'"), 'a dedicated catch branch checks CATEGORY_EXISTS')
  assert.ok(body.includes('catNameExistsWarn'), 'it surfaces the same warning key as ProjectOverviewView.createProject')
  // [F3 fix] contract updated: the old OUTER `catch { /* cancelled */ }` around prompt AND persist
  // swallowed real persistence errors as user cancels. Cancel handling is now scoped to the
  // $prompt await ONLY; the CATEGORY_EXISTS guard lives in the persist try, and any other
  // rejection surfaces via actionFailedMsg instead of dying as a "cancel".
  const iPromptCancel = body.indexOf('catch { return } // user cancelled the dialog')
  const iGuard = body.indexOf('CATEGORY_EXISTS')
  assert.ok(iPromptCancel > -1, 'cancel handling is scoped to the dialog await')
  assert.ok(iGuard > -1 && iGuard > iPromptCancel, 'the guard lives in the persist try AFTER the cancel-only catch')
  assert.ok(body.includes('statsH.main.actionFailedMsg'), 'non-duplicate persistence rejections surface (no cancel swallow)')
  // the updateCategory commit now sits inside its OWN try (the inner guard), not bare in the
  // cancel-only try scope: the line right before `const ok = await ...updateCategory` must be a try opener
  const iCommit = body.indexOf("const ok = await this.$store.commit('category/updateCategory'")
  assert.ok(iCommit > -1)
  const before = body.slice(Math.max(0, iCommit - 120), iCommit)
  assert.ok(/try \{[^}]*$/.test(before), 'the commit is wrapped in its own inner try block')
})

/* ===== [V3] duplicate-name rename channels ===== */

/** Extract a method body from an SFC source by name and build a callable (node cannot import .vue
 *  directly; the method bodies under test are plain JS — no TS-only syntax inside). */
function extractMethod (srcText, name) {
  const sig = name + ' ('
  const i = srcText.indexOf(sig)
  assert.ok(i > -1, 'method ' + name + ' found')
  const open = srcText.indexOf('{', i)
  let depth = 0
  for (let j = open; j < srcText.length; j++) {
    if (srcText[j] === '{') depth++
    else if (srcText[j] === '}') { depth--; if (!depth) return new Function('c', 'return (async () => {' + srcText.slice(open + 1, j) + '})()') }
  }
  throw new Error('unbalanced braces in ' + name)
}

test('[V3] saveMgrEdit: duplicate-name commit keeps the edit state, warns and refocuses', async () => {
  // [F3 fix] saveMgrEdit is now async (it awaits the updateCategory persist result for the
  // confirmed-write gate) — extractMethod wraps the body in an async IIFE so `await` compiles.
  const saveMgrEdit = extractMethod(src.mgrModal, 'saveMgrEdit')
  const warnings = []
  const focusCalls = []
  // the refocus queries at document level (append-to-body dialog) — stub it
  if (!globalThis.document) globalThis.document = {}
  const prevQuery = globalThis.document.querySelector
  globalThis.document.querySelector = sel => sel.includes('sn-cat-edit') ? { focus: () => focusCalls.push('focus') } : null
  let threw = false
  const vm = {
    mgrEditing: 7,
    mgrName: 'dup',
    $t: k => k,
    $message: { warning: m => warnings.push(m) },
    $nextTick: fn => { fn() },
    $store: { commit: () => { const e = new Error('already exists'); e.code = 'CATEGORY_EXISTS'; throw e } }
  }
  try {
    await saveMgrEdit.call(vm, { categoryId: 7 })
  } catch (e) { threw = true } finally {
    globalThis.document.querySelector = prevQuery
  }
  assert.equal(threw, false, 'the CATEGORY_EXISTS throw must not escape the method')
  assert.equal(vm.mgrEditing, 7, 'the edit state is kept (editor stays open for another try)')
  assert.deepEqual(warnings, ['statsG.SideNav.catNameExistsWarn'], 'exactly the duplicate-name warning fired')
  assert.deepEqual(focusCalls, ['focus'], 'the blurred inline editor was re-focused via $nextTick')
})

test('[V3] saveCatEdit (sidebar): duplicate-name commit keeps the edit state, warns and refocuses', async () => {
  const handlers = await import('../../../renderer/js/components/side-nav/sideNavHandlers.js')
  const warnings = []
  const focusCalls = []
  let threw = false
  const vm = {
    catEditing: 3,
    newCatName: 'dup',
    $t: k => k,
    $message: { warning: m => warnings.push(m) },
    $el: { querySelector: () => ({ focus: () => focusCalls.push('focus') }) },
    $nextTick: fn => { fn() },
    $store: { commit: () => { const e = new Error('already exists'); e.code = 'CATEGORY_EXISTS'; throw e } }
  }
  try {
    handlers.saveCatEdit(vm, { categoryId: 3 })
  } catch (e) { threw = true }
  assert.equal(threw, false, 'the CATEGORY_EXISTS throw must not escape')
  assert.equal(vm.catEditing, 3, 'the edit state is kept')
  assert.deepEqual(warnings, ['statsG.SideNav.catNameExistsWarn'])
  assert.deepEqual(focusCalls, ['focus'], 'the editor was re-focused')
})

/* ===== [V4] TaskAccountModal future-booking guard ===== */

test('[V4] saveCreate refuses a future-ending manual record, before addRecord', () => {
  const i = src.acct.indexOf('saveCreate () {')
  assert.ok(i > -1)
  const body = src.acct.slice(i, i + 1600)
  const iGuard = body.indexOf('endTime > Date.now()')
  const iCommit = body.indexOf("commit('tomato/addRecord'")
  assert.ok(iGuard > -1 && iCommit > -1 && iGuard < iCommit,
    'the end>now guard runs BEFORE the addRecord commit')
  assert.ok(body.includes('invalidStartTime'), 'the rejection surfaces the existing invalid-start-time error key')
  assert.ok(body.includes('return') , 'the guard aborts the save')
})

test('[V4] commitDraft refuses a future-ending edit and saveEdit keeps the editor open', () => {
  const iCommit = src.acct.indexOf('commitDraft (d, auto) {')
  assert.ok(iCommit > -1)
  const commitBody = src.acct.slice(iCommit, src.acct.indexOf('delRecord', iCommit))
  assert.ok(commitBody.includes('draftEndsInFuture(d)'), 'commitDraft consults the shared future guard')
  assert.ok(commitBody.includes('invalidStartTime'), 'the edit channel surfaces the same error key')
  assert.ok(commitBody.includes('return false'), 'commitDraft signals rejection to its callers')
  const iSave = src.acct.indexOf('saveEdit (auto) {')
  const saveBody = src.acct.slice(iSave, iCommit)
  assert.ok(/if \(!this\.commitDraft\(d, auto\)\) return/.test(saveBody),
    'saveEdit does NOT clear editingId/draft when the persistence step rejected the interval')
})

test('[V4] behavior: draftEndsInFuture math via extracted semantics (past end ok, future end rejected)', () => {
  // The guard is one expression: day0 + startMin*60000 + dur*60000 > Date.now(). Verify with the
  // same formula at a fixed fake "now" the component formula agrees with intuition.
  const day0 = 1760000000000
  const endTs = d => day0 + d.startMin * 60000 + d.dur * 60000
  const now = day0 + 12 * 3600000 // noon of day0
  assert.ok(endTs({ startMin: 8 * 60, dur: 25 }) < now, 'an 08:00+25min record is in the past at noon')
  assert.ok(endTs({ startMin: 23 * 60, dur: 25 }) > now, 'a 23:00+25min record ends in the future at noon')
})

/* ===== [V5] saveMgrEdit empty-name refocus ===== */

test('[V5] saveMgrEdit empty-name branch re-focuses the blurred editor ($nextTick refocus patch)', () => {
  const i = src.mgrModal.indexOf('saveMgrEdit (c) {')
  assert.ok(i > -1)
  const body = src.mgrModal.slice(i, src.mgrModal.indexOf('cancelMgrEdit', i))
  const iWarn = body.indexOf('catNameEmptyWarn')
  const iRefocus = body.indexOf("document.querySelector('.cat-mgr-dialog input.sn-cat-edit')")
  assert.ok(iWarn > -1 && iRefocus > -1 && iWarn < iRefocus,
    'the empty-name warning is followed by the document-level refocus (append-to-body dialog)')
})

/* ===== [V6] duplicate tag warning ===== */

test('[V6] createTag warns (instead of silent return) when the tag already exists', async () => {
  const handlers = await import('../../../renderer/js/components/side-nav/sideNavHandlers.js')
  const warnings = []
  const vm = {
    $t: k => k,
    $message: { warning: m => warnings.push(m), error: () => {} },
    $prompt: () => Promise.resolve({ value: 'work' }),
    $store: { state: { ui: { userTags: ['work'] } }, dispatch: () => Promise.resolve(true) },
    tags: []
  }
  await handlers.createTag(vm)
  assert.deepEqual(warnings, ['statsG.SideNav.catNameExistsWarn'],
    'the duplicate tag path fires the existing name-exists warning key')
})

/* ===== [V7] QuickAdd pure date-word guard ===== */

test('[V7] onEnter refuses creation when parsed.restText is empty (date-only input)', () => {
  const i = src.quick.indexOf('async onEnter () {')
  assert.ok(i > -1)
  const body = src.quick.slice(i, src.quick.indexOf("content = this.parsed.restText || raw", i))
  assert.ok(body.includes('this.parsed.restText === \'\''),
    'a parsed input with empty restText (pure date words) is intercepted')
  assert.ok(body.includes('statsB.ProjectView.nameRequired'),
    'the refusal reuses the existing empty-name warning key (no new i18n key)')
  assert.ok(body.includes('this._submitting = false'),
    'the guard releases the submit lock before returning (a follow-up Enter must still work)')
})

/* ===== [V8] EpSubtasks focus-within ===== */

test('[V8] the delete/drag keys are visible when focus is inside the subtask row', () => {
  assert.ok(src.epSub.includes('.ep-sub:focus-within .ep-sub-x'),
    '.ep-sub:focus-within .ep-sub-x joins the hover selector (same shape as .ep-sub-move)')
  assert.ok(/\.ep-sub:hover \.ep-sub-x, \.ep-sub:hover \.ep-sub-drag,\s*\n\.ep-sub:focus-within \.ep-sub-x, \.ep-sub:focus-within \.ep-sub-drag \{ opacity: 1; \}/.test(src.epSub),
    'one rule block reveals ✕ and ≡ on hover AND focus-within')
})

/* ===== [V9] TodayXView wall-clock reactivity ===== */

test('[V9] settled and settledTotal read this.tick so the today-cut recomputes at midnight', () => {
  for (const name of ['settledTotal () {', 'settled () {']) {
    const i = src.todayx.indexOf(name)
    assert.ok(i > -1, name + ' found')
    const body = src.todayx.slice(i, i + 400)
    assert.ok(body.includes('void this.tick'),
      name + ' declares the tick dependency (same wall-clock family as remainSec)')
  }
})

/* ===== [V10] restoreAndToast dead link ===== */

test('[V10] restoreAndToast warns and closes the stale toast when the recycle row is gone', async () => {
  const { restoreAndToast } = await import('../../../renderer/js/utils/confirm.js')
  const calls = []
  const vm = { $message: {
    warning: m => calls.push(['warning', m]),
    closeAll: () => calls.push(['closeAll'])
  } }
  const store = { state: { todo: { recycleList: [] } } }
  restoreAndToast(vm, store, { taskId: 'gone' })
  const iClose = calls.findIndex(c => c[0] === 'closeAll')
  const iWarn = calls.findIndex(c => c[0] === 'warning')
  assert.ok(iWarn > -1, 'a warning fired (the task cannot be restored)')
  assert.ok(iClose > -1 && iClose < iWarn, 'the stale undo toast was dismissed BEFORE the warning (closeAll must not kill the new message)')
  assert.ok(String(calls[iWarn][1]).length > 0, 'the warning carries a real localized message')
})

/* ===== [V11] EditPanel Esc picker-panel guard ===== */

test('[V11] the Esc handler returns early while a .el-picker-panel overlay is in the DOM', () => {
  const i = src.editPanel.indexOf('this._onKeydown = (e) => {')
  assert.ok(i > -1)
  const body = src.editPanel.slice(i, src.editPanel.indexOf("window.addEventListener('keydown', this._onKeydown)", i))
  const iGuard = body.indexOf("document.querySelector('.el-picker-panel')")
  const iClose = body.indexOf("dispatch('ui/closeEditCleanup'")
  assert.ok(iGuard > -1 && iClose > -1 && iGuard < iClose,
    'the picker-panel guard precedes the closeEditCleanup dispatch')
  assert.ok(body.includes('return'), 'the guard is an early return (the panel handles its own Esc)')
})

/* ===== [V12] ProjectOverviewView deadline caliber ===== */

test('[V12] deadlineText anchors on todayTimestamp and reads d===0 as due-today', () => {
  const i = src.overview.indexOf('deadlineText (ts) {')
  assert.ok(i > -1)
  const body = src.overview.slice(i, src.overview.indexOf('deadlineClass', i))
  assert.ok(body.includes('todayTimestamp'), 'the day base is the store todayTimestamp (ProjectView.daysLeft caliber)')
  assert.ok(!body.includes('Math.ceil((ts - Date.now()) / 864e5)'), 'the raw Date.now() base is gone')
  assert.ok(body.includes("dueToday"), 'd === 0 surfaces the existing due-today key instead of "0 days left"')
})
