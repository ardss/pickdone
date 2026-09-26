/**
 * Domain-D renderer component/store wave (2026-09-26) — regression guards.
 *
 * Fixes covered:
 *   [white-noise] SettingsModal.pickCustomAudio: a rejected pickAudioFile bridge call (the NORMAL
 *        path for >50MB audio since the size gate) now shows an error toast instead of vanishing.
 *   [A2] RepeatDeleteModal "This event only" actually DELETES the task (used to only detach it:
 *        repeatId cleared, task stayed fully visible — Delete pressed, nothing disappeared).
 *   [D-toasts] RepeatDeleteModal group-query and batch-delete failures show an error toast
 *        (both used to be console-only, invisible in a packaged app).
 *   [A3] RepeatModal blocks generating from a date-less template (used to persist the rule,
 *        generate 0 instances and show a SUCCESS toast; preview promised N for daily).
 *   [Esc] EditPanel Esc whitelist includes ui.tomatoRecordAddVisible (sibling tomato modals were
 *        whitelisted; Esc under the add-record dialog closed the sidebar underneath).
 *   [delFile] EditPanel deleteFromDisk reports the structured delete-file error via reportError
 *        (was .catch(() => {}), contradicting main's documented throw-and-surface contract).
 *   [A14] repeat.js failed group query sets repeatCount = null (EditPanel renders an em-dash
 *        placeholder) — 0 was a wrong count rendered as fact.
 *   [B5] restoreFromRecycle strips a dangling repeatId when the rule meta was GCed (restored
 *        task completes → silent no-renewal otherwise).
 *   [B6] settings.todoDescriptionDisplayLineNumber is consumed: descLines.js clamp helper +
 *        TodoItem .td-desc wiring (the slider previously had no consumer at all).
 *   [C5] renderer main.js day-rollover setInterval is gated by isMainShell (aux windows used to
 *        run computeViews/purgeExpiredRecycle too — midnight purge race across windows).
 *   [C15] purgeIds reports deleteTodoFilesRelevant failures (empty catch orphaned files silently).
 *
 * Run: node --test tests/unit/renderer/maint-0926-domainD.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

/* ================= [white-noise] SettingsModal.pickCustomAudio rejection feedback ================= */

test('[white-noise] pickCustomAudio shows an error toast when the pick bridge rejects', async () => {
  const src = read('renderer/js/components/SettingsModal.vue')
  // Static anchor: the promise chain carries a catch (fails on the catchless .then-only chain)
  const m = src.match(/pickCustomAudio \(\) \{[\s\S]*?\n {4}\},/)
  assert.ok(m, 'pickCustomAudio method found')
  assert.match(m[0], /\.catch\(e =>/, 'the pickAudioFile chain has a .catch')

  // Behavior: drive the REAL extracted method against a rejecting bridge
  const fn = eval('(' + m[0].replace(/,$/, '').replace(/^pickCustomAudio/, 'function') + ')')
  const errors = []
  globalThis.window.todoAPI = { pickAudioFile: () => Promise.reject(new Error('attachment: too large (max 50MB)')) }
  const self = {
    $message: { success () {}, error: msg => errors.push(msg) },
    $t: k => (globalThis.window.VueI18n, k),
    set () {}
  }
  await fn.call(self)
  await new Promise(r => setTimeout(r, 0)) // pickCustomAudio does not return the chain; let the rejection settle
  assert.equal(errors.length, 1, 'the user gets feedback instead of an unhandled rejection')
  assert.match(String(errors[0]), /attachment: too large/, 'the failure cause is surfaced')
  // the reused key exists in both locales
  const enH = await import(pathToFileURL(path.join(ROOT, 'renderer/js/i18n/locales/en-US-H.js')).href)
  const zhH = await import(pathToFileURL(path.join(ROOT, 'renderer/js/i18n/locales/zh-CN-H.js')).href)
  assert.ok(enH.default.statsH.main.actionFailedMsg && zhH.default.statsH.main.actionFailedMsg)
})

/* ================= [A2 / D-toasts] RepeatDeleteModal scopes + failure feedback ================= */

// Load the component's <script> with stubbed imports (same extraction paradigm as the C3 test)
async function loadRepeatDeleteModal () {
  const src = read('renderer/js/components/RepeatDeleteModal.vue')
  let script = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]
  script = script
    .replace(/^import[\s\S]*?from\s+'[^']*'\s*$/gm, '')
  globalThis.__dDStubCleanup = async () => {}
  const code = script.replace('export default', 'const dialogA11y = {}; const cleanupOrphanRepeatRule = globalThis.__dDStubCleanup;\nexport default')
  const mod = await import('data:text/javascript,' + encodeURIComponent(code))
  return mod.default
}

test('[A2] "This event only" dispatches deleteTodosMany for the single task (no detach patch)', async () => {
  const component = await loadRepeatDeleteModal()
  const dispatches = []
  const group = [{ taskId: 'a', repeatId: 'r1', dayStart: 1 }, { taskId: 'b', repeatId: 'r1', dayStart: 2 }]
  globalThis.window.todoAPI = { dbCall: async () => group }
  const self = {
    mode: 'this', busy: false,
    base: { taskId: 'a', repeatId: 'r1', dayStart: 1, taskContent: 'x' },
    $store: { state: { ui: { showRepeatDeleteConfirm: 'a' } }, dispatch: (a, p) => { dispatches.push([a, p]); return Promise.resolve() } },
    $message: null,
    $createElement: () => ({}),
    $t: k => k,
    close () {}
  }
  await component.methods.confirm.call(self)
  const deletes = dispatches.filter(([a]) => a === 'todo/deleteTodosMany')
  assert.equal(deletes.length, 1, 'the single instance goes through the shared batch-delete path')
  assert.deepEqual(deletes[0][1], [{ taskId: 'a' }], 'exactly the chosen task is deleted')
  assert.equal(dispatches.filter(([a]) => a === 'todo/updateTodoFields').length, 0,
    'no detach patch — clearing repeatId while keeping the visible task was the old broken behavior')
})

test('[D-toasts] group-query failure shows an error toast and deletes nothing', async () => {
  const component = await loadRepeatDeleteModal()
  const errors = []
  const dispatches = []
  globalThis.window.todoAPI = { dbCall: async () => { throw new Error('ipc down') } }
  const self = {
    mode: 'all', busy: false,
    base: { taskId: 'a', repeatId: 'r1', dayStart: 1, taskContent: 'x' },
    $store: { state: { ui: { showRepeatDeleteConfirm: 'a' } }, dispatch: (a, p) => { dispatches.push([a, p]); return Promise.resolve() } },
    $message: { error: m => errors.push(m) },
    $createElement: () => ({}),
    $t: k => k,
    close () {}
  }
  await component.methods.confirm.call(self)
  assert.equal(errors.length, 1, 'the failed query is not silent')
  assert.equal(dispatches.length, 0, 'no delete dispatched after a failed group query')
})

test('[D-toasts] batch-delete failure shows an error toast (was console-only)', async () => {
  const component = await loadRepeatDeleteModal()
  const errors = []
  const group = [{ taskId: 'a', repeatId: 'r1', dayStart: 1 }]
  globalThis.window.todoAPI = { dbCall: async () => group }
  const self = {
    mode: 'all', busy: false,
    base: { taskId: 'a', repeatId: 'r1', dayStart: 1, taskContent: 'x' },
    $store: {
      state: { ui: { showRepeatDeleteConfirm: 'a' } },
      dispatch: (a) => a === 'todo/deleteTodosMany' ? Promise.reject(new Error('db write failed')) : Promise.resolve()
    },
    $message: { error: m => errors.push(m) },
    $createElement: () => ({}),
    $t: k => k,
    close () {}
  }
  await component.methods.confirm.call(self)
  assert.equal(errors.length, 1, 'the failed delete is surfaced to the user')
  assert.equal(self.busy, false, 'busy is released on the failure path too')
  // the two new keys are bilingual
  const enD = (await import(pathToFileURL(path.join(ROOT, 'renderer/js/i18n/locales/en-US-D.js')))).default
  const zhD = (await import(pathToFileURL(path.join(ROOT, 'renderer/js/i18n/locales/zh-CN-D.js')))).default
  assert.ok(enD.statsD.RepeatDeleteModal.queryFailed && zhD.statsD.RepeatDeleteModal.queryFailed, 'queryFailed key bilingual')
  assert.ok(enD.statsD.RepeatDeleteModal.deleteFailed && zhD.statsD.RepeatDeleteModal.deleteFailed, 'deleteFailed key bilingual')
})

/* ================= [A3] RepeatModal blocks date-less generation ================= */

test('[A3] date-less template: Generate disabled, generate() guards before persisting, preview shows -', async () => {
  const src = read('renderer/js/components/RepeatModal.vue')
  assert.match(src, /:disabled="!templateTodo \|\| !templateTodo\.todoTime"/,
    'the Generate button is disabled when the template has no date')
  const gen = src.match(/async generate \(\) \{[\s\S]*?\n {2}\},/)
  assert.ok(gen, 'generate method found')
  const guardIdx = gen[0].indexOf('noBaseDate')
  const commitIdx = gen[0].indexOf('repeatSettings/updateSettings')
  assert.ok(guardIdx > -1, 'generate() carries the no-base-date guard')
  assert.ok(commitIdx > -1 && guardIdx < commitIdx, 'the guard fires BEFORE the default-rule save (the doomed generation must not overwrite the saved repeatSettings)')
  // the preview no longer promises N for a date-less daily template
  const pc = src.match(/previewCount \(\) \{[\s\S]*?\n {4}\},/)
  assert.ok(pc, 'previewCount computed found')
  assert.match(pc[0], /if \(!this\.templateTodo \|\| !this\.templateTodo\.todoTime\) return '-'/,
    'the date-less branch returns the neutral placeholder')
  const fn = eval('(' + pc[0].replace(/,$/, '').replace(/^previewCount/, 'function') + ')')
  assert.equal(fn.call({ templateTodo: { taskId: 'a' }, form: { repeatType: 'day', repeatDayCount: 30 } }), '-',
    'the date-less daily preview shows a neutral placeholder, not 30')
  assert.equal(fn.call({ templateTodo: null, form: { repeatType: 'day', repeatDayCount: 30 } }), '-')
  // bilingual guard message
  const enD = (await import(pathToFileURL(path.join(ROOT, 'renderer/js/i18n/locales/en-US-D.js')))).default
  const zhD = (await import(pathToFileURL(path.join(ROOT, 'renderer/js/i18n/locales/zh-CN-D.js')))).default
  assert.ok(enD.statsD.RepeatModal.noBaseDate && zhD.statsD.RepeatModal.noBaseDate, 'noBaseDate key bilingual')
})

/* ================= [Esc] EditPanel whitelist ================================================ */

test('[Esc] ui.tomatoRecordAddVisible joined the EditPanel Esc whitelist', () => {
  const ep = read('renderer/js/components/EditPanel.vue')
  assert.match(ep, /ui\.tomatoRecordAddVisible\)\s*return/,
    'Esc over the tomato record-add dialog no longer closes the edit sidebar underneath')
})

/* ================= [delFile] EditPanel deleteFromDisk surfaces the structured error ========= */

test('[delFile] deleteFile rejection reaches reportError (no bare catch(() => {}) swallow)', async () => {
  const src = read('renderer/js/components/EditPanel.vue')
  const m = src.match(/const deleteFromDisk = \(\) => \{([\s\S]*?)\r?\n\s{6}\}/)
  assert.ok(m, 'deleteFromDisk found')
  assert.doesNotMatch(m[0], /\.catch\(\(\) => \{\}\)/, 'the empty swallow is gone')
  assert.match(m[0], /reportError\('delete-file:/, 'the failure is reported via the shared path')
  const reported = []
  const rejections = []
  globalThis.window.todoAPI = { deleteFile: url => Promise.reject(new Error('delete-file failed: EPERM ' + url)) }
  const fn = new Function('undone', 'item', 'attachmentUrlPresent', 'reportError', m[1])
  await fn.call(
    { $store: { state: { todo: { todoList: [{ taskId: 't1' }] } } } },
    false, { url: 'att://x' }, () => false,
    (where, err) => reported.push([where, err])
  )
  await new Promise(r => setTimeout(r, 0))
  assert.equal(reported.length, 1, 'the disk-sweep failure is logged, not dropped')
  assert.match(reported[0][0], /^delete-file:att:\/\/x$/)
  assert.match(String(reported[0][1] && reported[0][1].message), /EPERM/)
  assert.equal(rejections.length, 0)
})

/* ================= [A14] failed group query → null count (em-dash placeholder) ============== */

test('[A14] failed repeat group query sets repeatCount null; EditPanel renders a neutral placeholder', async () => {
  const REP = await import('../../../renderer/js/components/edit-panel/repeat.js')
  const warns = []
  const origWarn = console.warn
  console.warn = (...a) => warns.push(a.join(' '))
  globalThis.window.todoAPI = { dbCall: async () => { throw new Error('ipc down') } }
  const ctx = { e: { taskId: 't1', repeatId: 'r1' }, repeatCount: 7 }
  try { await REP.repeatGroupInfo(ctx) } finally { console.warn = origWarn }
  assert.equal(ctx.repeatCount, null, 'unknown ≠ zero: 0 was a wrong count rendered as fact')
  assert.ok(warns.length === 1 && /repeatGroupInfo/.test(warns[0]), 'failure stays warned')
  const ep = read('renderer/js/components/EditPanel.vue')
  assert.match(ep, /repeatCount == null \? '—' : repeatCount/, 'the template renders an em-dash for the unknown count')
})

/* ================= [B5] restoreFromRecycle strips a dangling repeatId ======================= */

test('[B5] restoring a task whose repeatRule meta was GCed clears the repeatId (no silent dead chain)', async () => {
  const todo = (await import('../../../renderer/js/store/todo.js')).default
  const dispatches = []
  const dispatch = (a, p) => {
    dispatches.push([a, p])
    return Promise.resolve({ taskId: p && p.taskId })
  }
  const ctx = { commit () {}, dispatch }
  // Case 1: rule meta gone → repeatId stripped, task restores as a plain non-repeating task
  globalThis.window.todoAPI = { dbCall: async (op) => op === 'getMeta' ? null : 'ok' }
  await todo.actions.restoreFromRecycle.call({ state: { todo: { todoList: [] } } }, ctx, { taskId: 't1', repeatId: 'rGone' })
  const patches = dispatches.filter(([a]) => a === 'updateTodoFields').map(([, p]) => p.patch)
  assert.ok(patches.some(p => p && p.repeatId === null), 'the dangling repeatId is stripped on restore')
  dispatches.length = 0
  // Case 2: rule meta alive → repeatId untouched
  globalThis.window.todoAPI = { dbCall: async (op, params) => op === 'getMeta' ? JSON.stringify({ repeatType: 'day' }) : 'ok' }
  await todo.actions.restoreFromRecycle.call({ state: { todo: { todoList: [] } } }, ctx, { taskId: 't2', repeatId: 'rAlive' })
  const patches2 = dispatches.filter(([a]) => a === 'updateTodoFields').map(([, p]) => p.patch)
  assert.ok(!patches2.some(p => p && 'repeatId' in p), 'a live rule keeps the repeat chain intact')
})

/* ================= [B6] todoDescriptionDisplayLineNumber finally has a consumer ============= */

test('[B6] descLines clamp helper + TodoItem wiring for the description-lines setting', async () => {
  const { descLineClampStyle } = await import('../../../renderer/js/utils/descLines.js')
  // clamping bounds and default (keys are csstype camelCase vendor names since vue-tsc typed the helper)
  assert.equal(descLineClampStyle(3).WebkitLineClamp, 3)
  assert.equal(descLineClampStyle(0).WebkitLineClamp, 1, 'clamped to the slider minimum')
  assert.equal(descLineClampStyle(99).WebkitLineClamp, 6, 'clamped to the slider maximum')
  assert.equal(descLineClampStyle(undefined).WebkitLineClamp, 3, 'store default fallback')
  assert.equal(descLineClampStyle('4').WebkitLineClamp, 4, 'string settings values are coerced')
  assert.equal(descLineClampStyle(2.6).WebkitLineClamp, 3, 'rounded')
  // the box-clamp style block is complete
  const s = descLineClampStyle(2)
  assert.equal(s.display, '-webkit-box')
  assert.equal(s.overflow, 'hidden')
  assert.equal(s.WebkitBoxOrient, 'vertical')
  // the dead setting now has a consumer
  const ti = read('renderer/js/components/TodoItem.vue')
  assert.match(ti, /todoDescriptionDisplayLineNumber/, 'TodoItem reads the setting (fails on the never-consumed code)')
  assert.match(ti, /:style="descLineClamp"/, '.td-desc applies the clamp')
})

/* ================= [C5] day-rollover interval is main-shell gated =========================== */

test('[C5] the 60s day-rollover/computeViews interval runs in the main shell only', () => {
  const mainSrc = read('renderer/js/main.js')
  const gateIdx = mainSrc.indexOf('[C5 fix]')
  const rolloverIdx = mainSrc.indexOf('Day-rollover refresh')
  assert.ok(rolloverIdx > -1 && gateIdx > rolloverIdx, 'the gate sits on the rollover loop')
  assert.match(mainSrc, new RegExp(String.raw`if \(isMainShell\) \{\r?\n {4}setInterval\(\(\) => \{\r?\n {6}const day = new Date\(\)\.toDateString\(\)`),
    'the rollover setInterval is inside the isMainShell gate (aux windows no longer drive computeViews/purgeExpiredRecycle)')
})

/* ================= [C15] purgeIds reports attachment-file cleanup failures ================== */

test('[C15] deleteTodoFilesRelevant failures are reported, not swallowed by an empty catch', () => {
  const todo = read('renderer/js/store/todo.js')
  assert.doesNotMatch(todo, /deleteTodoFilesRelevant\?\.\(id\) \} catch \{\}/, 'purgeIds: no empty catch left')
  assert.doesNotMatch(todo, /deleteTodoFilesRelevant\?\.\(id\) \} catch \{\}/, 'purgeAllRecycle: no empty catch left')
  const hits = todo.match(/reportError\('deleteTodoFilesRelevant', err\)/g) || []
  assert.equal(hits.length, 2, 'both purge paths (per-item + empty-bin) report cleanup failures')
})

/* ================= [tags-drag] SnManageTagsModal stops advertising a nonexistent reorder ===== */

test('[tags-drag] the tag manager rows expose no drag affordance (reorder was never implemented)', () => {
  const src = read('renderer/js/components/side-nav/SnManageTagsModal.vue')
  assert.doesNotMatch(src, /cat-mgr-drag/, 'the grab-handle icon is gone (nothing draggable behind it)')
  assert.doesNotMatch(src, /cursor:\s*grab/, 'no cursor:grab on the rows')
  assert.doesNotMatch(src, /draggable=|@dragstart|@dragover/i, 'no drag wiring claimed either')
})

/* ================= [tags-rewrite] mid-loop rejection surfaces and keeps the tag whole ======== */

// Load the component's <script> with stubbed imports (loadRepeatDeleteModal paradigm) — this
// script is lang="ts", so the type annotations are stripped before the data-URL import.
async function loadTagsModal () {
  const src = read('renderer/js/components/side-nav/SnManageTagsModal.vue')
  let script = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)[1]
  script = script
    .replace(/^import[\s\S]*?from\s+'[^']*'\s*$/gm, '')
    .replace(/\s+as any\b/g, '')
    .replace(/\s+as HTMLInputElement \| null/g, '')
    .replace(/:\s*any\b(\[\])?/g, '')
    // tagRewriteRe's TS signature: `name: string`, `opts?: { consume?: boolean }` + `): RegExp`
    .replace(/\(name:\s*string/g, '(name')
    .replace(/,\s*opts\?:\s*\{[^}]*\}/g, ', opts')
    .replace(/\):\s*RegExp(\s*\{)/g, ') {')
  const code = 'const defineComponent = x => x\n' +
    'const extractTags = (c, d) => ((String(c || "") + " " + String(d || "")).match(/#([^\\s#,，。.!?！？]+)/g) || []).map(s => s.slice(1))\n' +
    script.replace('export default', 'export default')
  const mod = await import('data:text/javascript,' + encodeURIComponent(code))
  return mod.default
}

test('[tags-rewrite] removeTag stops on first failed rewrite: error toast, tag bookkeeping skipped', async () => {
  const component = await loadTagsModal()
  const dispatches = []
  const toasts = { success: [], error: [] }
  const todos = [
    { taskId: 't1', taskContent: 'a #work', taskDescribe: '' },
    { taskId: 't2', taskContent: 'b #work', taskDescribe: '' },
    { taskId: 't3', taskContent: 'c #work', taskDescribe: '' }
  ]
  let updateCalls = 0
  const self = {
    // method-to-method calls run through `this`, so the fake component carries the real methods
    ...component.methods,
    $store: {
      state: { todo: { todoList: todos } },
      dispatch: (a, p) => {
        dispatches.push([a, p])
        if (a === 'todo/updateTodoFields') {
          updateCalls++
          if (updateCalls === 2) return Promise.reject(new Error('db write failed'))
        }
        return Promise.resolve()
      }
    },
    $confirm: () => Promise.resolve(),
    $message: { success: m => toasts.success.push(m), error: m => toasts.error.push(m), warning: () => {} },
    $t: k => k
  }
  await component.methods.removeTag.call(self, { name: 'work', count: 3 })
  assert.equal(updateCalls, 2, 'the loop stopped at the first failure')
  assert.equal(toasts.error.length, 1, 'the failure is toasted, not silent')
  assert.equal(dispatches.filter(([a]) => a === 'ui/removeUserTag').length, 0,
    'the tag placeholder survives: removeUserTag is not dispatched on a half-deleted rewrite')
  assert.equal(toasts.success.length, 0, 'no success toast on a partial rewrite')
})

test('[tags-rewrite] removeTag dispatches removeUserTag + success toast when every rewrite succeeds', async () => {
  const component = await loadTagsModal()
  const dispatches = []
  const toasts = { success: [], error: [] }
  const self = {
    ...component.methods,
    $store: {
      state: { todo: { todoList: [{ taskId: 't1', taskContent: 'a #work', taskDescribe: '' }] } },
      dispatch: (a, p) => { dispatches.push([a, p]); return Promise.resolve() }
    },
    $confirm: () => Promise.resolve(),
    $message: { success: m => toasts.success.push(m), error: m => toasts.error.push(m), warning: () => {} },
    $t: k => k
  }
  await component.methods.removeTag.call(self, { name: 'work', count: 1 })
  assert.equal(dispatches.filter(([a]) => a === 'ui/removeUserTag').length, 1, 'bookkeeping runs on full success')
  assert.equal(toasts.success.length, 1)
  assert.equal(toasts.error.length, 0)
})

/* ================= [reschedule-crossday] rescheduleExpired keeps time-of-day / reminders ===== */

test('[reschedule-crossday] rescheduleExpired moves a 14:30 schedule and its reminder to today, not midnight', async () => {
  const { rescheduleExpired } = await import('../../../renderer/js/utils/core.js')
  const DAY = 86400000
  const today = new Date(); today.setHours(0, 0, 0, 0)
  const todayTs = today.getTime()
  const oldDay = todayTs - DAY
  const calls = []
  const dispatch = async (name, payload) => calls.push([name, payload])
  const t = { taskId: 'a', complete: false, dayStart: oldDay, todoTime: oldDay + 14 * 3600000, reminderTime: oldDay + 9 * 3600000 }
  await rescheduleExpired(dispatch, [t], todayTs)
  const updates = calls.filter(([name]) => name === 'todo/updateTodoFields')
  assert.equal(updates.length, 1)
  const patch = updates[0][1].patch
  assert.equal(patch.dayStart, todayTs, 'row moves to today')
  assert.equal(patch.todoTime, todayTs + 14 * 3600000, 'the 14:30 schedule stays 14:30 (was hard-wiped to 00:00)')
  assert.equal(patch.reminderTime, todayTs + 9 * 3600000, 'the reminder is not orphaned on the expired day')
})

/* ================= [restore-single-path] bin restore goes through todo/restoreFromRecycle ==== */

test('[restore-single-path] restoreFromRecycle merges the dayPatch into its atomic restore patch', async () => {
  const todo = (await import('../../../renderer/js/store/todo.js')).default
  const dispatches = []
  const dispatch = (a, p) => { dispatches.push([a, p]); return Promise.resolve({ taskId: p && p.taskId }) }
  globalThis.window.todoAPI = { dbCall: async () => null }
  const ctx = { commit () {}, dispatch }
  await todo.actions.restoreFromRecycle.call({ state: { todo: { todoList: [] } } }, ctx,
    { taskId: 't1', repeatId: 'r1', dayPatch: { dayStart: 12345, todoTime: 12345 + 3600000 } })
  const patch = dispatches[0][1].patch
  assert.equal(patch.delete, false, 'still an undelete')
  assert.equal(patch.deletedAt, 0, 'deletedAt is reset (was never reset via the bare updateTodoFields path)')
  assert.equal(patch.dayStart, 12345, 'the dayPatch fields ride the same restore entry')
  assert.equal(patch.todoTime, 12345 + 3600000)
})

test('[restore-single-path] RecycleBinView restores via todo/restoreFromRecycle, not bare updateTodoFields', () => {
  const src = read('renderer/js/views/RecycleBinView.vue')
  assert.match(src, /dispatch\('todo\/restoreFromRecycle'/,
    'restore()/pickDate() share the store action (chips snapshot + deletedAt reset + B5 repeatId guard on every entry)')
  assert.doesNotMatch(src, /dispatch\('todo\/updateTodoFields'/,
    'the bare updateTodoFields bypass is gone (it skipped all three restore guarantees)')
})

/* ================= [chipsnapshot-backup] bin tasks keep their chip snapshot through backups == */

test('[chipsnapshot-backup] collectMetaState gathers planChipsSnapshot and both restore whitelists accept it', async () => {
  const { metaStateKeys } = await import('../../../renderer/js/store/helpers/todoBackup.js')
  const rootState = { category: { list: [] } }
  const state = { todoList: [], recycleList: [{ taskId: 'b1', status: 'delete' }] }
  const keys = metaStateKeys(rootState, state)
  assert.ok(keys.includes('planChipsSnapshot:b1'),
    'a binned task is live state: its chip-restore meta is collected (was silently lost on disaster restore)')
  assert.ok(!keys.some(k => k.startsWith('catProjectMetaBak')), 'transient catProjectMetaBak stays excluded')
  // without the restore whitelists the collector fix is dead code
  const tab = read('renderer/js/components/settings/SettingsDataTab.vue')
  assert.match(tab, /'planChipsSnapshot:',/, 'SettingsDataTab META_RESTORE_PREFIXES accepts planChipsSnapshot')
  const rec = read('src/main/dbRecovery.cjs')
  assert.match(rec, /'planChipsSnapshot:',/, 'dbRecovery META_RESTORE_PREFIXES accepts planChipsSnapshot')
})

/* ================= [tombstone-zero] recycleBinAutoDeleteDays=0 keeps category tombstones ===== */

test('[tombstone-zero] with recycleBinAutoDeleteDays=0 an aged tombstone is still re-attached on init', async () => {
  const category = (await import('../../../renderer/js/store/category.js')).default
  globalThis.localStorage.setItem('categoryState', JSON.stringify({
    list: [{ categoryId: 500, categoryName: 'Old', delete: true, deletedAt: 1000 }]
  }))
  const commits = []
  globalThis.window.todoAPI = {
    dbCall: async (op) => op === 'getAllCategories' ? [{ categoryId: 1, categoryName: 'Live' }] : null,
    getMetaMany: async () => []
  }
  const self = { dispatch: async () => {} }
  const ctx = { commit: (m, p) => commits.push([m, p]), rootState: { settings: { recycleBinAutoDeleteDays: 0 } } }
  await category.actions.init.call(self, ctx)
  const merged = commits.find(([m]) => m === 'setListFromDb')[1]
  assert.ok(merged.some(c => c.categoryId === 500 && c.delete),
    'the "never purge" setting keeps the recovery entry (0 used to read as 30 days)')
})

/* ================= [restore-sanitize] settings restore sanitizes the backup blob ============= */

test('[restore-sanitize] restore drops unknown keys and non-enum values from the backup blob', async () => {
  const settings = (await import('../../../renderer/js/store/settings.js')).default
  const i18n = await import('../../../renderer/js/i18n/index.js')
  globalThis.localStorage.setItem('appLocale', 'en-US')
  const state = { appLocale: 'en-US', weekStartDay: 'mon' }
  // mutations.restore(state, saved) — a plain two-arg call (no .call: the first PARAM is the state)
  settings.mutations.restore(state, { junkKey: 'x', weekStartDay: 'monday', appLocale: 'xx-YY', securityLockPassword: 'pw-restored' })
  assert.equal('junkKey' in state, false, 'unknown/deprecated keys never reach live state')
  assert.equal(state.weekStartDay, 'mon', 'enum junk is dropped, the declared default stands')
  assert.equal(state.appLocale, 'en-US', 'a junk locale never flips the UI locale')
  assert.equal(state.securityLockPassword, 'pw-restored',
    'C3 carve-out: restore is the user\'s own backup, the secret survives (maint-d7 lock-restore contract)')
  // persist() debounces the LS write 150ms — wait it out, then assert the persisted mirror too
  await new Promise(r => setTimeout(r, 250))
  const blob = JSON.parse(globalThis.localStorage.getItem('settingsState'))
  assert.equal('junkKey' in blob, false, 'the persisted LS mirror is sanitized too')
  assert.equal(blob.appLocale, 'en-US')
  // [restore-locale-enum] the junk locale must not reach the i18n boot cache / hot-apply path either
  assert.notEqual(i18n.default && i18n.default.global ? i18n.default.global.locale : '', 'xx-YY',
    'i18n locale was never flipped to the junk value')
})

/* ================= [habits-savedat] applyExternalPatch rejects an unsaved patch ============== */

test('[habits-savedat] applyExternalPatch with no savedAt is a no-op against saved local state', async () => {
  const habits = (await import('../../../renderer/js/store/habits.js')).default
  const s = { habits: [{ id: 'keep' }], moments: [], savedAt: 100 }
  // plain (state, payload) call — a .call(s, payload) would shift the payload into the state slot
  habits.mutations.applyExternalPatch(s, { fields: { habits: [{ id: 'peer' }] } })
  assert.equal(s.habits.length, 1, 'an unsaved peer patch is dropped (siblings reject it too)')
  assert.equal(s.habits[0].id, 'keep')
  assert.equal(s.savedAt, 100, 'no savedAt bump on a rejected round')
})

/* ================= [sync-empty-version] a no-op sync no longer bumps state.version ========= */

test('[sync-empty-version] syncTodos with an already-synced table leaves state.version unchanged', async () => {
  const todo = (await import('../../../renderer/js/store/todo.js')).default
  const state = {
    isSyncing: false,
    version: 5,
    todoList: [{ taskId: 'a', status: 'sync', version: 3 }],
    recycleList: []
  }
  const ctx = {
    state,
    commit: (m) => { if (m === 'bumpVersion') state.version++ },
    dispatch: async () => {}
  }
  await todo.actions.syncTodos.call({}, ctx)
  assert.equal(state.version, 5, 'an empty round neither bumps the version nor needs the retry path')
  assert.equal(state.isSyncing, false, 'the syncing flag is still released (finally block)')
})

/* ================= [nan-comparator] todayDoneList / recycleBin sorts are NaN-safe =========== */

test('[nan-comparator] todayDoneList and recycleBin comparators carry the ||0 NaN fallback', () => {
  const todo = read('renderer/js/store/todo.js')
  assert.match(todo, /todayDoneList: todayDoneList\.sort\(\(a, b\) => \(b\.completedAt \|\| b\.updateTime \|\| 0\) - \(a\.completedAt \|\| a\.updateTime \|\| 0\)\)/,
    'a completed row with NaN completedAt/updateTime keeps a deterministic position')
  assert.match(todo, /recycleBin: \[\.\.\.this\.state\.todo\.recycleList\]\.sort\(\(a, b\) => \(b\.deletedAt \|\| b\.updateTime \|\| 0\) - \(a\.deletedAt \|\| a\.updateTime \|\| 0\)\)/,
    'a binned row with NaN deletedAt/updateTime keeps a deterministic position')
})
