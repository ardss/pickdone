/**
 * Domain-A renderer wave (2026-09-27): timer/search/quickadd/account/chrome fixes.
 *
 * Covers: fix 1 TomatoFloatPage abandon-confirm "focused for" clock read a nonexistent `this.now`
 * (NaN → stuck 00:00), fix 7 SearchView silently dropping undated tasks under a date range,
 * fix 8 QuickAdd error toast clipped in the 480x64 standalone window (quiet inline failure),
 * fix 9 TaskAccountModal fmtDate dropping the year on previous-year ledger rows, fix 10 openAdd
 * booking a future "completed" focus before 00:25, fix 13 calendar day cells without an
 * accessible name, fix 14 per-resize-event isMaximized IPC storm, fix 16 cancelled drags leaving
 * a stale quadrant highlight.
 *
 * SFC scripts are evaluated with the same new Function harness as tomato-abandon-modal-ime.test.mjs.
 *
 * Run: node --test tests/unit/renderer/maint-0927-domainA.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => readFileSync(path.join(ROOT, p), 'utf8')

/* ---- env mocks (before renderer imports; no electron, no real %APPDATA%) ---- */
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} }
if (!globalThis.window) globalThis.window = { location: { hash: '' }, todoAPI: {} }

const dayjsMod = await import('dayjs')
const dayjs = dayjsMod.default
globalThis.dayjs = dayjs
globalThis.window.dayjs = dayjs

/** Evaluate a .vue <script> block with its imports injected (same harness family as tomato-abandon-modal-ime) */
function loadSFC (rel, inject = {}) {
  const src = read(rel)
  const m = src.match(/<script[^>]*>([\s\S]*?)<\/script>/)
  assert.ok(m, rel + ': <script> block not found')
  const code = m[1]
    .replace(/^\s*import\s+.*$\n?/gm, '')
    .replace(/\bas\s+any\b/g, '')
    .replace(/:\s*any\b/g, '')
    .replace(/export\s+default\s*\{/, 'return {')
  const names = Object.keys(inject)
  return new Function(...names, code)(...names.map(k => inject[k]))
}

/* ================= Fix 1: abandon-confirm "focused for" clock ================= */

test('fix1 focusedElapsedSec: valid startedAt yields the focused-seconds string (was NaN → 00:00)', async () => {
  const shared = await import('../../../renderer/js/utils/tomatoShared.js')
  const now = Date.now()
  assert.equal(shared.focusedElapsedSec(now - 65000, now), 65)
  assert.equal(shared.formatMMSS(shared.focusedElapsedSec(now - 65000, now)), '01:05')
  assert.equal(shared.focusedElapsedSec(now + 5000, now), 0, 'clock skew clamps to 0')
  assert.equal(shared.focusedElapsedSec(0, now), 0, 'missing startedAt is 0, never NaN')
})

test('fix1 TomatoFloatPage.displayClock: uses the ticked this.now field, not a nonexistent one', async () => {
  const shared = await import('../../../renderer/js/utils/tomatoShared.js')
  const Comp = loadSFC('renderer/js/views/TomatoFloatPage.vue', {
    formatMMSS: shared.formatMMSS,
    focusedElapsedSec: shared.focusedElapsedSec,
    NOISES: [],
    remainSecOfAnnounce: () => 0
  })
  const now = Date.now()
  const displayClock = Comp.computed.displayClock.call({
    abandoning: true, working: true, clock: '23:00', remaining: 100,
    st: { startedAt: now - 65000 }, now
  })
  assert.equal(displayClock, '01:05')
  const fallback = Comp.computed.displayClock.call({
    abandoning: false, working: true, clock: '23:00', remaining: 100,
    st: { startedAt: now - 65000 }, now
  })
  assert.equal(fallback, '23:00', 'non-abandoning state keeps the countdown')
})

test('fix1 static anchors: data() declares `now`, the refresh loop ticks it', () => {
  const src = read('renderer/js/views/TomatoFloatPage.vue')
  assert.match(src, /now: Date\.now\(\)/, 'data() must declare now (the old code read an undefined field)')
  assert.match(src, /refresh \(\) \{\s*\n\s*this\.now = Date\.now\(\)/, 'the 500ms refresh loop must tick now')
  assert.match(src, /focusedElapsedSec\(this\.st\.startedAt, this\.now\)/)
})

/* ================= Fix 7: SearchView undated tasks hidden by a date range ================= */

const { matchTodo } = await import('../../../renderer/js/utils/search.js')
const rbkMod = await import('../../../renderer/js/utils/roleButtonKey.js')
const SearchComp = loadSFC('renderer/js/views/SearchView.vue', { matchTodo, dayjs, TodoItem: {}, EmptyState: {}, roleButtonActivate: rbkMod.roleButtonActivate })

function searchCtx (tasks, range) {
  return {
    q: '',
    settings: { searchDateRange: range, searchComplete: '', searchCategory: '' },
    $store: { state: { todo: { todoList: tasks }, category: { list: [] } } }
  }
}

test('fix7 SearchView.matchTasks: undated rows are excluded by a range AND counted in undatedHidden', () => {
  const inRange = { taskId: 'a', taskContent: 'dated', dayStart: +dayjs().startOf('day'), todoTime: Date.now() }
  const undated = { taskId: 'b', taskContent: 'floating' }
  const { list, undatedHidden } = SearchComp.methods.matchTasks.call(searchCtx([inRange, undated], 'last7'))
  assert.deepEqual(list.map(t => t.taskId), ['a'], 'undated row cannot satisfy a date range')
  assert.equal(undatedHidden, 1, 'the hidden undated task must be counted, not silently dropped')
})

test('fix7 no range set: undated tasks stay in the list and undatedHidden is 0', () => {
  const undated = { taskId: 'b', taskContent: 'floating', todoTime: Date.now() }
  const { list, undatedHidden } = SearchComp.methods.matchTasks.call(searchCtx([undated], ''))
  assert.equal(list.length, 1)
  assert.equal(undatedHidden, 0)
})

test('fix7 static anchors: hint line renders the count with a clear-range action; locale keys exist', () => {
  const src = read('renderer/js/views/SearchView.vue')
  assert.match(src, /v-if="undatedHidden"/)
  assert.match(src, /statsC\.Search\.undatedHidden/)
  assert.match(src, /patch\('searchDateRange',''\)/, 'hint must offer clearing the range')
  const en = read('renderer/js/i18n/locales/en-US-C.js')
  const zh = read('renderer/js/i18n/locales/zh-CN-C.js')
  assert.match(en, /undatedHidden:/)
  assert.match(en, /clearDateRange:/)
  assert.match(zh, /undatedHidden:/)
  assert.match(zh, /clearDateRange:/)
})

/* ================= Fix 8: QuickAdd quiet error path ================= */

const { parseNaturalDate } = await import('../../../renderer/js/utils/nlDate.js')
const { resolveQuickAddDate } = await import('../../../renderer/js/utils/quickAddDate.js')
const quickAddPaste = await import('../../../renderer/js/utils/quickAddPaste.js')
const QuickAddComp = loadSFC('renderer/js/components/QuickAdd.vue', {
  parseNaturalDate, dayjs, FMT: { date: 'YYYY-MM-DD', cnDate: 'YYYY-MM-DD' }, resolveQuickAddDate,
  splitPasteLines: quickAddPaste.splitPasteLines, ensureTagSuffix: quickAddPaste.ensureTagSuffix,
  // [A9] the date-chip key handler now routes through the shared factory (this harness strips imports)
  roleButtonActivate: (await import('../../../renderer/js/utils/roleButtonKey.js')).roleButtonActivate,
  // onEnter's calendar-ref resolution also needs $elOf (imports are stripped by this harness)
  $elOf: (await import('../../../renderer/js/utils/el.js')).$elOf
})

function quickAddCtx (quiet, dispatch) {
  const message = { error: 0, success: 0 }
  return {
    ctx: {
      text: 'some task', parsed: null, quiet, failed: false, _submitting: false,
      effDate: undefined, inTodoBox: false, routeTag: '', routeCategoryId: null,
      $route: { name: 'home', params: {} },
      $store: { dispatch },
      $t: k => k,
      $message: {
        error () { message.error++ },
        success () { message.success++ }
      },
      $emit () {},
      $announce: null
    },
    message
  }
}

test('fix8 quiet submit failure: no (clipped) $message.error, inline failed flag set instead', async () => {
  const { ctx, message } = quickAddCtx(true, async () => { throw new Error('store rejected') })
  await QuickAddComp.methods.onEnter.call(ctx)
  assert.equal(message.error, 0, 'quiet mode must not fire the toast the 64px window clips')
  assert.equal(ctx.failed, true, 'inline failure flag set')
  assert.equal(ctx.text, 'some task', 'input kept for retry')
})

test('fix8 non-quiet submit failure still toasts; next input clears the flag', async () => {
  const { ctx, message } = quickAddCtx(false, async () => { throw new Error('store rejected') })
  await QuickAddComp.methods.onEnter.call(ctx)
  assert.equal(message.error, 1)
  assert.equal(ctx.failed, false)
})

test('fix8 static anchors: failed class binding, inline alert div, cleared on input', () => {
  const src = read('renderer/js/components/QuickAdd.vue')
  assert.match(src, /'qa-failed': failed/)
  assert.match(src, /@input="failed = false"/)
  assert.match(src, /class="qa-error" role="alert"/)
  assert.match(src, /if \(this\.quiet\) this\.failed = true/, 'error path mirrors the success path quiet contract')
})

/* ================= Fix 9: TaskAccountModal fmtDate keeps the year for past years ================= */

const AccountComp = loadSFC('renderer/js/components/TaskAccountModal.vue', {
  FMT: { date: 'YYYY-MM-DD' }, dayjs, dialogA11y: {}, FOCUS_MAX_MINUTES: 600
})

test('fix9 fmtDate: previous-year ledger rows keep YYYY-MM-DD; current-year rows stay MM-DD', () => {
  const fmtDate = AccountComp.methods.fmtDate
  const past = fmtDate.call(null, { endTime: +dayjs('2024-05-03 12:00') })
  assert.equal(past, '2024-05-03', 'the year must survive on previous-year rows')
  const cur = dayjs().month(5).date(3).hour(12)
  assert.equal(fmtDate.call(null, { endTime: +cur }), cur.format('MM-DD'), 'current-year abbreviation unchanged')
})

/* ================= Fix 10: openAdd never books a future "completed" focus ================= */

test('fix10 manualDraft: at 00:10 the draft is {startMin:0, dur:10}, not a 25-min block ending 00:25', () => {
  const manualDraft = AccountComp.methods.manualDraft
  assert.deepEqual(manualDraft.call(null, 0, 10), { startMin: 0, dur: 10 })
  assert.deepEqual(manualDraft.call(null, 14, 30), { startMin: 845, dur: 25 }, 'normal times keep the full 25')
  const midnight = manualDraft.call(null, 0, 0)
  assert.equal(midnight.startMin, 0, 'never a negative start')
  assert.ok(midnight.dur >= 1, 'still a recordable duration')
})

test('fix10 static anchor: openAdd builds its draft through manualDraft (no Math.max(25,...) floor)', () => {
  const src = read('renderer/js/components/TaskAccountModal.vue')
  assert.match(src, /this\.manualDraft\(now\.getHours\(\), now\.getMinutes\(\)\)/)
  assert.doesNotMatch(src, /Math\.max\(25, now/, 'the future-booking floor is gone')
})

/* ================= Fix 13: calendar day cells carry an accessible name ================= */

const StripComp = loadSFC('renderer/js/components/DayDateStrip.vue', { dayjs, DAY_MS: 86400000 })

test('fix13 calCellLabel: full YYYY-MM-DD accessible name with month context', () => {
  const label = StripComp.methods.calCellLabel.call({ $t: k => k }, { key: +dayjs('2026-03-05'), hasTasks: false })
  assert.equal(label, '2026-03-05')
})

test('fix13 static anchor: ds-cal-cell buttons carry title + aria-label like the nav buttons', () => {
  const src = read('renderer/js/components/DayDateStrip.vue')
  const cell = src.match(/<button v-for="c in calCells"[\s\S]*?>/)
  assert.ok(cell, 'calendar cell button found')
  assert.match(cell[0], /:aria-label="calCellLabel\(c\)"/)
  assert.match(cell[0], /:title="calCellLabel\(c\)"/)
})

/* ================= Fix 14: WinControls coalesces the resize IPC storm ================= */

test('fix14 resize burst of 50 events costs at most one trailing isMaximized IPC', async () => {
  const Comp = loadSFC('renderer/js/components/WinControls.vue')
  const realWindow = globalThis.window
  let calls = 0
  globalThis.window = {
    todoAPI: { isMaximized: () => { calls++; return Promise.resolve(true) } },
    addEventListener () {}, removeEventListener () {}
  }
  try {
    const ctx = { maxed: false, ...Comp.methods }
    Comp.mounted.call(ctx)
    assert.equal(calls, 1, 'initial state poll only')
    for (let i = 0; i < 50; i++) ctx._onMax()
    assert.equal(calls, 1, 'burst coalesced: no IPC per resize event (was 50)')
    await new Promise(r => setTimeout(r, 250))
    assert.equal(calls, 2, 'exactly one trailing poll per burst')
    assert.equal(ctx.maxed, true, 'trailing poll still updates the icon state')
    Comp.beforeUnmount.call(ctx)
  } finally {
    globalThis.window = realWindow
  }
})

test('fix14 static anchor: pending poll timer is cleared on unmount', () => {
  const src = read('renderer/js/components/WinControls.vue')
  assert.match(src, /scheduleMaxPoll \(\)/)
  assert.match(src, /clearTimeout\(this\._maxTimer\)/)
})

/* ================= Fix 16: cancelled drags clear the quadrant highlight ================= */

const MatrixComp = loadSFC('renderer/js/components/MatrixGrid.vue', {
  dayjs, FMT: { cnDate: 'YYYY-MM-DD' },
  roleCheckboxActivate: rbkMod.roleCheckboxActivate // [A8] the complete checkbox now uses the shared factory
})

test('fix16 endDrag: dragend resets BOTH dragId and overKey (cancelled drag no stale highlight)', () => {
  const ctx = { dragId: 't1', overKey: 'q1' }
  MatrixComp.methods.endDrag.call(ctx)
  assert.equal(ctx.dragId, null)
  assert.equal(ctx.overKey, null, 'the field dropOn resets but dragend used to skip')
})

test('fix16 static anchors: template routes dragend through endDrag; dropOn keeps its reset', () => {
  const src = read('renderer/js/components/MatrixGrid.vue')
  assert.match(src, /@dragend="endDrag"/)
  assert.doesNotMatch(src, /@dragend="dragId=null"/, 'the asymmetric inline reset is gone')
  const dropOn = src.match(/dropOn \(q\) \{[\s\S]*?\n {2}\}/)
  assert.ok(dropOn && /this\.overKey = null/.test(dropOn[0]), 'drop path still clears overKey')
})
