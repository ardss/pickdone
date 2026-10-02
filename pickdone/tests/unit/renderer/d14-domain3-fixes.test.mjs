/**
 * [D14 domain-3 fixes — renderer views/components, 2026-10-02]
 * A1  FeedbackModal: honest local-staging copy + warn on oldest-entry overwrite (no fake "submitted")
 * A2  FeedbackModal: attach-log checkbox disabled + tooltip (renderer cannot read the log tail)
 * A3  TodoItem: overdue chip no longer fires on the due day (day-level compare, dueStateOf semantics)
 * A4  RecycleBinView: purge/clearAll rejections no longer swallowed by the cancel-catch
 * A5  DepView: waiting-on chips beyond the 3-cap show a "+N" truncation chip
 * A6  TodayXView: settled badge shows the true count while the visible list stays capped
 * A7  TomatoFloatPage: attach menu shows a truncation notice past the 30-item cap
 * A8  DayDateStrip: popover auto-close timer does not fire while focus is inside (focusout closes)
 * A9  QuickAddPage: Esc discards the draft (aligned with main-window QuickAdd J1)
 * A10 ContextMenuHost: Tab roving + Home/End (Tab used to walk focus out of the open menu)
 * A11 FeedbackModal: type selector is a real radiogroup (role=radio + aria-checked + arrows)
 * A12 SnManageCategoriesModal: blank rename warns instead of silently restoring the old name
 * A13 SettingsDataTab: runAutoBackupNow has the sibling busy-flag guard
 * A14 EpAttachments: invoke-level open failure toasts (was log-only silent)
 * A15 RecycleBinView: context menu gains the pick-date restore item
 * A16 FeedbackModal/MilestoneEditModal: X announces "close", not the dialog title
 * B5  buckets.js: honors expiredCompletedTodoRange, inclusive R1-th-day boundary (BEHAVIOR TESTS)
 * C4  ProjectDocs: abandoned cross-project write flips saveFailed instead of vanishing silently
 * Run: node --test tests/unit/renderer/d14-domain3-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import '../../setup.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const url = p => 'file://' + path.join(ROOT, p).replace(/\\/g, '/')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

/* ---------------- B5: behavior tests (fail without the fix) ---------------- */

test('B5: buildCompletedBuckets honors expiredCompletedTodoRange (was a dead hard 30-day cap)', async () => {
  const { buildCompletedBuckets } = await import(url('renderer/js/utils/buckets.js'))
  const day = 864e5
  const today = +new Date(2026, 9, 2) // local midnight
  const mk = (agoDays) => ({ taskId: 't' + agoDays, complete: true, completedAt: today - agoDays * day })
  // '7d' setting: day-10 completion must be dropped (previously shown until day 30)
  const g7 = buildCompletedBuckets([mk(10)], today, '7d')
  assert.equal(g7.length, 0, 'day-10 completion dropped under 7d range')
  // '15d': day-10 survives, lands in the last bucket
  const g15 = buildCompletedBuckets([mk(10)], today, '15d')
  assert.equal(g15.length, 1)
  assert.equal(g15[0].key, 'done-d30')
})

test('B5: the R1-th day is INCLUDED (boundary matches expiryGroups dayStart >= today - R1 days)', async () => {
  const { buildCompletedBuckets } = await import(url('renderer/js/utils/buckets.js'))
  const day = 864e5
  const today = +new Date(2026, 9, 2)
  // with '30d', a completion exactly 30 days ago must appear (old code: `agoDays >= 30` dropped it,
  // while expiryGroups included dayStart === today - 30d — the row showed on one page, not the other)
  const g = buildCompletedBuckets(
    [{ taskId: 'edge', complete: true, completedAt: today - 30 * day }], today, '30d')
  assert.equal(g.length, 1, 'day-30 completion included under 30d range')
  assert.equal(g[0].todos.length, 1)
})

test('B5: no setting passed -> legacy 30-day cap preserved (back-compat for other callers)', async () => {
  const { buildCompletedBuckets } = await import(url('renderer/js/utils/buckets.js'))
  const day = 864e5
  const today = +new Date(2026, 9, 2)
  const g = buildCompletedBuckets([{ taskId: 'old', complete: true, completedAt: today - 40 * day }], today)
  assert.equal(g.length, 0, '40-day completion still dropped by the legacy default')
})

test('B5: CompletedView passes the setting into the bucket builder', () => {
  const src = read('renderer/js/views/CompletedView.vue')
  assert.match(src, /buildCompletedBuckets\(this\.list,[^)]*expiredCompletedTodoRange\)/,
    'CompletedView groups() feeds settings.expiredCompletedTodoRange to the builder')
})

/* ---------------- A1/A2/A11/A16: FeedbackModal honesty + a11y ---------------- */

test('A1: submit no longer fakes "submitted"; staging is surfaced and overwriting warns', () => {
  const src = read('renderer/js/components/FeedbackModal.vue')
  assert.ok(!src.includes("$t('feedback.submitted')"), 'the fake success copy is gone from submit()')
  assert.match(src, /submittedLocal/, 'honest local-staging copy is used')
  assert.match(src, /dropped \+ \+|dropped\+\+/, 'oldest-entry overwrite is counted')
  assert.match(src, /pendingDropped/, 'and warned to the user')
  assert.match(src, /pendingCount/, 'local queue size is surfaced in the modal')
  for (const f of ['renderer/js/i18n/zh-CN.js', 'renderer/js/i18n/en-US.js']) {
    const loc = read(f)
    for (const key of ['submittedLocal', 'pendingNote', 'pendingDropped']) {
      assert.match(loc, new RegExp('"' + key + '":'), `${key} exists in ${path.basename(f)}`)
    }
  }
})

test('A2: attach-log checkbox is disabled with an explanatory tooltip (renderer cannot read the log)', () => {
  const src = read('renderer/js/components/FeedbackModal.vue')
  assert.match(src, /type="checkbox" v-model="attachLog" disabled/, 'checkbox disabled — it attaches nothing')
  assert.match(src, /attachLogPending/, 'tooltip key wired')
  const zh = read('renderer/js/i18n/zh-CN.js')
  const en = read('renderer/js/i18n/en-US.js')
  assert.match(zh, /"attachLogPending":/, 'zh tooltip key exists')
  assert.match(en, /"attachLogPending":/, 'en tooltip key exists')
})

test('A11: type selector is a real radiogroup (role=radio, aria-checked, arrow-key roving)', () => {
  const src = read('renderer/js/components/FeedbackModal.vue')
  assert.match(src, /role="radio"/, 'options carry role=radio')
  assert.match(src, /:aria-checked="type===t\.key/, 'selection state is announced')
  assert.match(src, /onTypeKeydown/, 'arrow-key roving handler is bound')
  assert.match(src, /ArrowLeft[\s\S]*ArrowRight[\s\S]*ArrowUp[\s\S]*ArrowDown/, 'all four arrows handled')
})

test('A16: modal X buttons announce "close", not the dialog title', () => {
  const fb = read('renderer/js/components/FeedbackModal.vue')
  const header = fb.match(/modal__header[^\n]*\n/)
  assert.ok(header && !header[0].includes(":aria-label=\"$t('feedback.title')\""), 'FeedbackModal X no longer reuses the title')
  assert.match(fb, /\$t\('feedback\.close'\)/, 'FeedbackModal X uses a close label')
  const ms = read('renderer/js/components/MilestoneEditModal.vue')
  assert.match(ms, /:aria-label="\$t\('statsB\.ProjectView\.close'\)"/, 'MilestoneEditModal X uses statsB close label')
  // combined-file rule: both labels exist in their locale files
  for (const f of ['renderer/js/i18n/zh-CN.js', 'renderer/js/i18n/en-US.js']) {
    const loc = read(f)
    assert.match(loc, /"feedback": \{[\s\S]*?"close":/, `feedback.close exists in ${path.basename(f)}`)
  }
  for (const f of ['renderer/js/i18n/locales/zh-CN-B.js', 'renderer/js/i18n/locales/en-US-B.js']) {
    const loc = read(f)
    assert.match(loc, /ProjectView"?: \{[\s\S]*?close"?:/, `statsB.ProjectView.close exists in ${path.basename(f)}`)
  }
})

/* ---------------- A3: overdue chip ---------------- */

test('A3: the deadline chip is overdue only after the due DAY has passed (not on the due day)', () => {
  const src = read('renderer/js/components/TodoItem.vue')
  assert.ok(!src.includes('todo.deadlineTs < Date.now()'), 'raw now-compare removed from the chip')
  assert.match(src, /deadlineOverdue \(\)[\s\S]*?startOf\('day'\)\.valueOf\(\) < dayjs\(\)\.startOf\('day'\)\.valueOf\(\)/,
    'day-level compare matches dueStateOf (days<0 = overdue)')
  assert.match(src, /\{overdue: deadlineOverdue\}/, 'chip class uses the new computed')
})

/* ---------------- A4 + A15: RecycleBinView ---------------- */

test('A4: purge/clearAll rejections surface unless they are user cancels', () => {
  const src = read('renderer/js/views/RecycleBinView.vue')
  const purgeCatch = src.match(/purgeIds[\s\S]*?\}\)\.catch\((e|err|\(e\))[\s\S]*?\}\)/)
  assert.ok(purgeCatch, 'purge catch exists')
  assert.match(src, /e !== 'cancel' && e !== 'close'/, 'cancel/close strings are filtered, everything else toasts')
  assert.ok(src.split(`e !== 'cancel' && e !== 'close'`).length >= 3, 'both purge and clearAll filter cancels')
})

test('A15: context menu carries the pick-date restore item', () => {
  const src = read('renderer/js/views/RecycleBinView.vue')
  assert.match(src, /btnPickDate'\), fn: \(\) => this\.openRowPicker/, 'menu has the 4th item')
  assert.match(src, /openRowPicker \(t, e\)[\s\S]*?\.rc-pick input/, 'it opens the row-embedded picker')
})

/* ---------------- A5/A6/A7: truncation honesty ---------------- */

test('A5: DepView waiting-on shows a +N chip past the 3-item cap', () => {
  const src = read('renderer/js/components/DepView.vue')
  assert.match(src, /missingTotalOf/, 'uncapped counter exists')
  assert.match(src, /depv-miss--more/, '+N chip rendered')
  assert.match(src, /waitMore/, 'truncation notice text wired')
  const zh = read('renderer/js/i18n/locales/zh-CN-A.js')
  const en = read('renderer/js/i18n/locales/en-US-A.js')
  assert.match(zh, /waitMore: '[^']*\{n\}/, 'zh waitMore declares {n}')
  assert.match(en, /waitMore: '[^']*\{n\}/, 'en waitMore declares {n}')
})

test('A6: TodayXView settled badge shows the true count, list stays capped', () => {
  const src = read('renderer/js/views/TodayXView.vue')
  assert.ok(!src.includes('settled.length }}</span>'), 'badge no longer reads the sliced array')
  assert.match(src, /\{\{ settledTotal \}\}/, 'badge uses the uncapped counter')
  assert.match(src, /settledTotal \(\)[\s\S]*?return n/, 'counter walks the full record list')
  assert.match(src, /\.slice\(0, 6\)/, 'visible list stays capped at 6')
})

test('A7: float-window attach menu shows a truncation notice past the 30-item cap', () => {
  const src = read('renderer/js/views/TomatoFloatPage.vue')
  assert.match(src, /tasksTruncated/, 'truncation flag computed')
  assert.match(src, /menuTruncated/, 'notice rendered in the menu')
  const zh = read('renderer/js/i18n/locales/zh-CN-B.js')
  const en = read('renderer/js/i18n/locales/en-US-B.js')
  assert.match(zh, /menuTruncated: '[^']*30/, 'zh notice mentions the cap')
  assert.match(en, /menuTruncated/, 'en notice exists')
})

/* ---------------- A8/A9/A10: keyboard behavior ---------------- */

test('A8: DayDateStrip popover auto-close skips while focus is inside; focusout closes', () => {
  const src = read('renderer/js/components/DayDateStrip.vue')
  assert.match(src, /focusInCal \(\)[\s\S]*?pop\.contains\(document\.activeElement\)/, 'focus guard exists')
  assert.match(src, /calLeave \(\) \{[\s\S]*?if \(this\.focusInCal\(\)\)/, 'mouse-leave timer not armed under keyboard users')
  assert.match(src, /@focusout="calFocusOut"/, 'focusout closes the popover')
})

test('A9: QuickAddPage Esc discards the draft (aligned with main-window QuickAdd)', () => {
  const src = read('renderer/js/views/QuickAddPage.vue')
  const onKey = src.match(/onKey \(e\) \{[\s\S]*?\n[ ]{4}\}/)
  assert.ok(onKey, 'onKey handler found')
  assert.match(onKey[0], /removeItem\(DRAFT_KEY\)/, 'Esc clears the stored draft')
  assert.match(onKey[0], /qa\.text = ''/, 'Esc clears the input text')
  assert.ok(!onKey[0].includes('persistDraft'), 'Esc no longer persists the draft')
  assert.match(src, /blur', this\.persistDraft\)/, 'accidental-hide (blur) persistence retained')
  assert.ok(!src.includes('D6-F12: persist the draft before hiding'), 'stale D6-F12 comment fixed')
})

test('A10: ContextMenuHost keeps Tab inside the menu and supports Home/End', () => {
  const src = read('renderer/js/components/ContextMenuHost.vue')
  assert.match(src, /e\.key === 'Tab'/, 'Tab is intercepted')
  assert.match(src, /e\.key === 'Home'/, 'Home jumps to first')
  assert.match(src, /e\.key === 'End'/, 'End jumps to last')
})

/* ---------------- A12/A13/A14: warn/busy/toast parity ---------------- */

test('A12: blank category rename warns instead of silently restoring the old name', () => {
  const src = read('renderer/js/components/side-nav/SnManageCategoriesModal.vue')
  assert.ok(!src.includes('|| c.categoryName'), 'the silent fallback is gone')
  assert.match(src, /catNameEmptyWarn/, 'empty-name warning (existing SideNav convention) is wired')
})

test('A13: runAutoBackupNow has the sibling busy-flag guard', () => {
  const src = read('renderer/js/components/settings/SettingsDataTab.vue')
  const fn = src.match(/async runAutoBackupNow \(\) \{[\s\S]*?\n[ ]{4}\},/)
  assert.ok(fn, 'function found')
  assert.match(fn[0], /if \(this\.backingUp\) return/, 're-entry blocked')
  assert.match(fn[0], /finally \{ this\.backingUp = false \}/, 'flag always released')
  assert.match(src, /:disabled="backingUp" @click="runAutoBackupNow"/, 'button disabled while busy')
})

test('A14: EpAttachments invoke-level open failure toasts', () => {
  const src = read('renderer/js/components/edit-panel/EpAttachments.vue')
  const catchBlock = src.match(/open-file invoke failed[\s\S]*?\}\)/)
  assert.ok(catchBlock, 'catch block found')
  assert.match(catchBlock[0], /ElMessage\(/, 'failure reaches the user, not only the log')
  for (const f of ['renderer/js/i18n/locales/zh-CN-J.js', 'renderer/js/i18n/locales/en-US-J.js']) {
    assert.match(read(f), /attachmentOpenFailed/, `attachmentOpenFailed exists in ${path.basename(f)}`)
  }
})

/* ---------------- C4: ProjectDocs ---------------- */

test('C4: an abandoned cross-project docs write flips saveFailed instead of vanishing silently', () => {
  const src = read('renderer/js/components/ProjectDocs.vue')
  assert.match(src, /keyCat !== this\._docsCatId\) \{ this\.saveFailed = true; return \}/,
    'ownership mismatch marks the honest failed state (retryable via the next queueSave)')
})
