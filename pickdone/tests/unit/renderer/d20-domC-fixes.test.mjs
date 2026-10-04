/**
 * D20-DOM C renderer fixes — regression guards (source-anchor pins + two store-behavior tests).
 * Fixes covered:
 *   [A1]  RepeatModal reuses the series' persisted rule + repeatId when editing (no silent fork)
 *   [A2]  ProjectView.recomplete guards a failed reschedule with the CategoryView error toast
 *   [A3]  ProjectOverviewView.createProject narrows the outer catch to prompt-cancel only and
 *         rolls back the placeholder category on a real failure
 *   [A4]  category.updateCategory returns a Promise<boolean>; ProjectView toasts success only on
 *         a confirmed write (rename + color)
 *   [A5]  QuickAdd calendar shell is a keyboard-activatable button-like control (Enter/Space)
 *   [A6]  HabitView check-in Undo restores the pre-action snapshot via habits/setCheck
 *   [A7]  EpReminders row delete splices by row reference (indexOf), not the captured v-for index
 *   [A8]  EditPanel tag-remove undo captures the index per call (no shared _removedTagAt slot)
 *   [A9]  QuickAdd multi-line paste during an in-flight submit falls through to the native paste
 *   [A10] DepView wires render BELOW the task cards
 *   [A11] ProjectOverviewView card demotes its role=button (pill keeps the button role)
 *   [A12] StatisticsView errorCaptured surfaces one visible inline note
 *   [A13] StatisticsView timeline band key is index-based (no identical-percentage collision)
 *   [A14] DepView cycle detection traverses the full live list, not inScope
 *   [A15] RepeatModal shows a visible "cancelling…" state while a generation is being cancelled
 * Run: node --test tests/unit/renderer/d20-domC-fixes.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')
const importMod = p => import(pathToFileURL(path.join(ROOT, p)).href)

/* ---------- [A1] RepeatModal series reuse ---------- */

test('[A1] RepeatModal hydrates the form from the series rule and reuses the existing repeatId', () => {
  const src = read('renderer/js/components/RepeatModal.vue')
  // created() must hydrate from the persisted series rule (getMeta repeatRule:<id>)
  assert.match(src, /hydrateSeries \(\)/)
  assert.match(src, /dbCall\('getMeta', 'repeatRule:' \+ tpl\.repeatId\)/)
  // confirm REUSES the template's repeatId; a fresh id is minted only when absent
  assert.match(src, /const repeatId = tpl\.repeatId \|\| `repeat_/)
})

test('[A1] RepeatModal hydrateSeries parses a string rule and merges it into the form', async () => {
  // Exercise the extracted method directly against a minimal component context
  const src = read('renderer/js/components/RepeatModal.vue')
  const m = src.match(/async hydrateSeries \(\) \{[\s\S]*?\n {4}\},/)
  assert.ok(m, 'hydrateSeries method exists')
  const fnSrc = m[0].replace(/\r/g, '').replace('async hydrateSeries () {', 'async function hydrateSeries () {').replace(/\}\s*,\s*$/, '}')
  const fn = new Function('window', 'return ' + fnSrc)(global.window) // eslint-disable-line no-new-func
  let queried = null
  global.window = global.window || {}
  global.window.todoAPI = { dbCall: async (op, key) => { queried = key; return JSON.stringify({ repeatType: 'week', repeatInterval: 2 }) } }
  const ctx = { templateTodo: { repeatId: 'rep1' }, form: { repeatType: 'day', repeatInterval: 1 } }
  await fn.call(ctx)
  assert.equal(queried, 'repeatRule:rep1')
  assert.equal(ctx.form.repeatType, 'week')
  assert.equal(ctx.form.repeatInterval, 2)
  // a template without a repeatId must not query at all
  const ctx2 = { templateTodo: { }, form: { repeatType: 'day' } }
  queried = null
  await fn.call(ctx2)
  assert.equal(queried, null)
})

/* ---------- [A2] ProjectView recomplete guard ---------- */

test('[A2] ProjectView.recomplete wraps the reschedule in try/catch with the CategoryView failure key', () => {
  const src = read('renderer/js/views/ProjectView.vue')
  const m = src.match(/async recomplete \(\) \{[\s\S]*?\n {4}\}/)
  assert.ok(m, 'recomplete method found')
  const body = m[0]
  assert.match(body, /try \{/)
  assert.match(body, /catch \(e\) \{/)
  assert.match(body, /statsE\.CategoryView\.rescheduleFailed/)
})

/* ---------- [A3] ProjectOverviewView createProject ---------- */

test('[A3] createProject swallow-catch covers only the prompt; real errors roll back + toast', () => {
  const src = read('renderer/js/views/ProjectOverviewView.vue')
  const m = src.match(/async createProject \(\) \{[\s\S]*?\r?\n {4}\}(?=\r?\n)/)
  assert.ok(m, 'createProject method found')
  const body = m[0]
  // the only bare catch belongs to the prompt block
  assert.match(body, /catch \{ return \/\* cancelled \*\/ \}/)
  // real-failure path rolls the placeholder back and toasts an error
  assert.match(body, /rollbackAdd/)
  assert.match(body, /createFailed/)
})

test('[A3] category store has a rollbackAdd mutation that hard-removes the row', async () => {
  const cat = await importMod('renderer/js/store/category.js')
  const muts = (cat.default && cat.default.mutations) || cat.mutations
  assert.equal(typeof muts.rollbackAdd, 'function')
})

/* ---------- [A4] confirmed-write contract for rename/color ---------- */

test('[A4] category.updateCategory returns persist() success; ProjectView gates toasts on it', async () => {
  // Behavioral: drive the real mutation with a stubbed IPC pipe
  const prevCall = global.window.todoAPI
  let failPut = false
  global.window.todoAPI = {
    ...(prevCall || {}),
    dbCall: async (op, params) => {
      if (op === 'putCategory' || op === 'put_category' || /categor/i.test(op)) {
        if (failPut) throw new Error('disk full')
        return null
      }
      return prevCall && prevCall.dbCall ? prevCall.dbCall(op, params) : null
    }
  }
  try {
    const cat = await importMod('renderer/js/store/category.js')
    const muts = (cat.default && cat.default.mutations) || cat.mutations
    const state = { list: [{ categoryId: 7, categoryName: 'Old', categoryColor: '#111', createTime: 1, listSort: 0, userId: 1, delete: false }], projectIds: [], projectMeta: {} }
    const ok = await muts.updateCategory(state, { categoryId: 7, categoryName: 'New' })
    assert.equal(ok, true, 'successful persist resolves true')
    assert.equal(state.list[0].categoryName, 'New')
    failPut = true
    state.list[0].categoryName = 'Again'
    const bad = await muts.updateCategory(state, { categoryId: 7, categoryName: 'Again' })
    assert.equal(bad, false, 'failed persist resolves false (was fire-and-forget undefined)')
  } finally {
    global.window.todoAPI = prevCall
  }
  const pv = read('renderer/js/views/ProjectView.vue')
  assert.match(pv, /const ok = await this\.\$store\.commit\('category\/updateCategory', \{ categoryId: this\.catId, categoryName: name \}\)/)
  assert.match(pv, /const ok = await this\.\$store\.commit\('category\/updateCategory', \{ categoryId: this\.catId, categoryColor: color \}\)/)
  // both failure branches toast the shared actionFailedMsg key
  assert.match(pv, /statsH\.main\.actionFailedMsg/)
})

/* ---------- [A5] QuickAdd calendar keyboard surrogate ---------- */

test('[A5] QuickAdd .qa-cal shell is a button-like control with Enter/Space synthesis', () => {
  const src = read('renderer/js/components/QuickAdd.vue')
  assert.match(src, /class="qa-cal" role="button" tabindex="0"/)
  assert.match(src, /@keydown\.enter\.prevent="openCal"/)
  assert.match(src, /@keydown\.space\.prevent="openCal"/)
  assert.match(src, /openCal \(\) \{[\s\S]*?querySelector\('input'\)[\s\S]*?inp\.click\(\)/)
})

/* ---------- [A6] HabitView undo snapshot ---------- */

test('[A6] habits/setCheck sets an explicit day value; HabitView undo uses it', async () => {
  const habits = await importMod('renderer/js/store/habits.js')
  const muts = (habits.default && habits.default.mutations) || habits.mutations
  const s = { habits: [{ id: 1, records: {} }], moments: [], savedAt: 0 }
  muts.setCheck(s, { id: 1, day: '2026-10-02', on: true })
  assert.equal(s.habits[0].records['2026-10-02'], true)
  muts.setCheck(s, { id: 1, day: '2026-10-02', on: false })
  assert.equal('2026-10-02' in s.habits[0].records, false)
  // the pre-existing toggle is untouched
  muts.toggleCheck(s, { id: 1, day: '2026-10-02' })
  assert.equal(s.habits[0].records['2026-10-02'], true)

  const src = read('renderer/js/views/HabitView.vue')
  const m = src.match(/check \(h\) \{[\s\S]*?\n {4}\},/)
  assert.ok(m, 'check method found')
  assert.match(m[0], /habits\/setCheck', \{ id: h\.id, day: this\.todayKey, on: was \}/)
  assert.ok(!/onClick[\s\S]{0,220}toggleCheck', \{ id: h\.id, day: this\.todayKey \}/.test(m[0]),
    'the undo closure must not re-toggle the current state')
})

/* ---------- [A7] EpReminders stale index ---------- */

test('[A7] EpReminders.removeRemindRow splices by row reference (indexOf), not the captured index', () => {
  const src = read('renderer/js/components/edit-panel/EpReminders.vue')
  const m = src.match(/removeRemindRow \(i\) \{[\s\S]*?\n {4}\},/)
  assert.ok(m, 'removeRemindRow found')
  const body = m[0]
  assert.match(body, /const at = this\.remindRows\.indexOf\(row\)/)
  assert.ok(!body.includes('clampInsertIndex'), 'the clamp helper path is replaced by reference lookup')
  assert.ok(!/this\.remindRows\.splice\(i, 1\)/.test(body), 'the raw captured index splice is gone')
})

/* ---------- [A8] EditPanel tag undo index ---------- */

test('[A8] removeTag captures the index per call; the shared _removedTagAt slot is gone', () => {
  const src = read('renderer/js/components/EditPanel.vue')
  const m = src.match(/removeTag \(name\) \{[\s\S]*?\r?\n {4}\}(?=\r?\n)/)
  assert.ok(m, 'removeTag found')
  const body = m[0]
  assert.match(body, /const removedAt = m \? m\.index : null/)
  assert.match(body, /Math\.min\(removedAt == null \? cur\.length : removedAt, cur\.length\)/)
  assert.equal(src.includes('this._removedTagAt'), false, 'the shared component-level slot must not survive anywhere')
})

/* ---------- [A9] QuickAdd busy paste ---------- */

test('[A9] onPaste checks _submitting BEFORE preventDefault', () => {
  const src = read('renderer/js/components/QuickAdd.vue')
  const m = src.match(/async onPaste \(e\) \{[\s\S]*?\n {4}\},/)
  assert.ok(m, 'onPaste found')
  const body = m[0]
  const guard = body.indexOf('if (this._submitting) return')
  const prevent = body.indexOf('e.preventDefault()')
  assert.ok(guard > -1 && prevent > -1 && guard < prevent,
    'the busy check must precede preventDefault so an in-flight submit keeps the native paste')
})

/* ---------- [A10] DepView wires z-order ---------- */

test('[A10] .depv-wires render below .depv-task cards', () => {
  const src = read('renderer/js/components/DepView.vue')
  const wires = src.match(/\.depv-wires \{[^}]*\}/)[0]
  const task = src.match(/\.depv-task \{[^}]*\}/)[0]
  const wz = Number((wires.match(/z-index:\s*(\d+)/) || [])[1])
  const tz = Number((task.match(/z-index:\s*(\d+)/) || [])[1])
  assert.ok(!Number.isNaN(wz) && !Number.isNaN(tz), 'both rules declare a z-index')
  assert.ok(tz > wz, `cards (z=${tz}) must stack above wires (z=${wz})`)
})

/* ---------- [A11] ProjectOverviewView nested button ---------- */

test('[A11] project card has no role=button; the status pill keeps its own', () => {
  const src = read('renderer/js/views/ProjectOverviewView.vue')
  const card = src.match(/v-for="p in filteredProjects"[^>]*class="proj-card"[^>]*>/)
  assert.ok(card, 'card open tag found')
  assert.ok(!card[0].includes('role="button"'), 'card must not carry role=button (pill nests inside)')
  assert.match(card[0], /tabindex="0"/, 'card stays keyboard-openable')
  assert.match(src, /class="proj-status"[^>]*role="button"/, 'the status pill keeps role=button')
})

/* ---------- [A12] StatisticsView visible error note ---------- */

test('[A12] errorCaptured flips a reactive flag that renders an inline card-error note', () => {
  const src = read('renderer/js/views/StatisticsView.vue')
  assert.match(src, /errorCaptured \(err, vm, info\) \{[\s\S]*?this\.cardError = true/)
  assert.match(src, /v-if="cardError" class="stat-card-error" role="alert"/)
  assert.match(src, /cardError: false/, 'the flag is reactive data')
  // bilingual copy present
  assert.match(read('renderer/js/i18n/locales/en-US-A.js'), /cardError:/)
  assert.match(read('renderer/js/i18n/locales/zh-CN-A.js'), /cardError:/)
})

/* ---------- [A13] timeline band key ---------- */

test('[A13] timeline band v-for keys on row+index identity, not left/width percentages', () => {
  const src = read('renderer/js/views/StatisticsView.vue')
  assert.match(src, /v-for="\(b, bi\) in \(row\.bands \|\| \[\]\)" :key="row\.dateKey \+ '_' \+ bi"/)
  assert.ok(!src.includes(":key=\"b.left+'_'+b.width\""), 'the collision-prone key is gone')
})

/* ---------- [A14] DepView cycle pool ---------- */

test('[A14] addDependency builds the cycle-traversal pool from the full live list', () => {
  const src = read('renderer/js/components/DepView.vue')
  const m = src.match(/addDependency \(target, prereqId, prereqTask, dependentTask\) \{[\s\S]*?\n {4}\},/)
  assert.ok(m, 'addDependency found')
  assert.match(m[0], /var byId = this\.allLiveById\(\)/)
  assert.ok(!/this\.inScope\.forEach\(x => \{ byId\[x\.taskId\] = x \}\)/.test(m[0]),
    'the inScope-only pool must be gone')
})

/* ---------- [A15] RepeatModal cancelling state ---------- */

test('[A15] RepeatModal shows a visible cancelling state and ships bilingual copy', () => {
  const src = read('renderer/js/components/RepeatModal.vue')
  assert.match(src, /generating && genCancelled \? \$t\('statsD\.RepeatModal\.cancelling'\)/)
  assert.match(read('renderer/js/i18n/locales/en-US-D.js'), /"cancelling": "Cancelling…"/)
  assert.match(read('renderer/js/i18n/locales/zh-CN-D.js'), /"cancelling": "正在取消…"/)
})
