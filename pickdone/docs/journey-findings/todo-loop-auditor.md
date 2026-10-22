# Todo core loop — real-user journey findings (todo-loop-auditor, 2026-10-22)

All findings below were produced by live driving of isolated real instances (bootJourney, CDP 9381),
screenshots under `.dev-data/journey-todo/`, plus DOM/store eval dumps quoted inline. Code reading
supplies root cause only.

Journeys walked: plain add/edit/complete/undo/delete/batch (J1), advertised NL syntax sweep (J2),
categories/tags/search/sort/filter (J3), 已达成/数据复盘/collapse/date-strip/empty states (J4),
tag-chip duplication (J5).

---

## [J1] P1 Quick-add on a selected non-today day silently lands the task on TODAY — the row is invisible on the day you are viewing

**Evidence**
- `j4b-01-add-on-day19.png`: day view 10月19日 selected (strip pill on 19, header "10月19日 周一"),
  empty state visible ("这一天没有安排，添加一个任务吧"). User types `19日的任务`, Enter.
  Toast: `已添加任务：19日的任务，已安排在今天` — **the view stays EMPTY**; the task does not
  appear on the 19日 view the user is looking at.
- Eval dump (same run):
  - after add on day 19: `rows:[]`, todo = `{c:"19日的任务", d:1792598400000}` (= today 10-22)
  - after add on day 25: `rows:[]`, todos both `d:1792598400000` (today) — same silent drop.
- Reproduces on past days and future days alike.

**Root cause**
- `renderer/js/components/QuickAdd.vue` `onEnter()` (line ~287) and `createLines()` (line ~186)
  resolve the payload date via `resolveQuickAddDate({ pickedDate: this.effDate, parsedTs: null,
  inTodoBox, todayTs: dayjs().startOf('day') })` — the selected day (`ui.daySelectedTs`,
  driven by DayDateStrip / TodayView route query) is never consulted.
- `renderer/js/utils/quickAddDate.js` only knows `inTodoBox`/`todayTs`; no view-day input.
- Meanwhile `TodayView.groups()` (line ~172-186) buckets rows by `daySelectedTs`, and the empty
  state copy (`statsE.TodayView.emptyDay` = "这一天没有安排，添加一个任务吧") invites adding a
  task for THAT day. CalendarView does it right (`createAt` creates at the clicked slot) — the
  day view is the odd one out. The toast is the only honest signal ("已安排在今天"), easy to miss.

**Proposed fix**
- `resolveQuickAddDate` gains `viewDayTs`: when set and `!== todayTs`, and no picked/parsed date
  and not inTodoBox, default to `viewDayTs` (pure function, unit-testable).
- QuickAdd passes `viewDayTs` (only meaningful on route `todo-list-today`: `$store.state.ui.daySelectedTs`)
  in both `onEnter` and `createLines`, and mirrors it into the toast's `d` fallback so the toast
  names the actual target day (both paths recompute `d` independently of `resolveQuickAddDate`).

**Status**: fixed + live-verified on the rebuilt renderer-dist — commit 694e3588 on journey-audit
(QuickAdd.vue + quickAddDate.js; unit tests extended in tests/unit/store/unit-quickadd.test.mjs).
Re-verification j6-01/02: day-19 add → row visible on 19, toast `已安排在10月19日`, d=10-19;
day-25 same; back-today plain add → today; box plain add → undated (regression guard held).

---

## [J2] P2 `10月30日 交房租` — explicit M月D日 + content silently drops the DATE: task lands today with the date text kept in the title

**Evidence**
- `j2-0*.png` sweep run. Typing `10月30日 交房租` shows NO date chip (`chipBefore={"value":"10月30日 交房租","chip":null}`),
  Enter → toast `已添加任务：10月30日 交房租，已安排在今天`, final row
  `{c:"10月30日 交房租", d:1792598400000 (today)}`. The user typed an explicit date; it silently
  became part of the title and the task is mis-dated to today.
- Contrast (same sweep, all correct): `明天下午3点 交报告 #工作` → 10-23 15:00; `明天/后天/下周三/周末/3天后`
  all parse; `晚上8点 看书`/`15:30 茶歇` parse; `10月30日` ALONE parses (chip appears).
- So the failure is exactly "date phrase followed by content" for the M月D日 form — the single most
  natural Chinese way to write a dated task.

**Root cause**
- `shared/nl-date-core.mjs` standalone M月D日 branch (line ~183): regex is
  `^M月D日(?:\s*TIME)?$` — full-string only. Content after the date kills the match; the fall-through
  returns `date:null, restText:wholeText`, so QuickAdd creates the raw text undated→today.
- `M月D日` is an advertised syntax of the quick-add NL parser (`renderer/js/utils/nlDate.js` header
  line 185 documents it; the quick-add placeholder itself demonstrates the "date + content" pattern).

**Proposed fix**
- Allow a trailing-content suffix: keep the optional time group, replace the `$` anchor with a
  boundary lookahead (`(?=$|\s|[,，。.、!！?？])`), `restText = (captured time + remainder)`.
  Sibling branches (N天后/下周X) already use exactly this slice-the-remainder idiom.
- Keep the calendar-validity rejects and the past-date rolls-next-year behavior.

**Status**: fixed + live-verified on the rebuilt renderer-dist — commit 087b448a on journey-audit
(shared/nl-date-core.mjs; cases added to tests/unit/cli/f6-date-time-compose.test.mjs — the shared
core's existing test home; renderer + CLI share the module by design, lead formally extended scope
to this file). Re-verification j6-03: `10月30日 交房租` now shows the `10月30日` chip while typing,
toast `已添加任务：交房租，已安排在10月30日`, row `{c:"交房租", d:<Oct 30>}`; NL regression
spot-checks (明天下午3点/明天/下周三/晚上8点/纯10月30日/3天后) all unchanged.

---

## [J3] P3 待办箱 "按截止日期" sort can never differ from "按创建日期" — the box only ever holds undated rows

**Evidence**
- `j3-06/07` run: box rows `["箱任务 丁","箱任务 丙","箱任务 甲"]`; switching sort to 按截止日期 →
  identical order. DOM/store eval confirms every box row has `dayStart:0`.
- Code: `renderer/js/store/helpers/todoComputeViews.js` line ~100: `box = noDateList.filter(t => !t.complete)`
  (no-date only), and line ~108: `dueOf = t.todoTime || t.createTime` — for undated rows todoTime is 0,
  so 按截止日期 degenerates to createTime ordering, i.e. exactly 按创建日期. The control promises an
  ordering distinction that is unreachable by construction.

**Proposed fix** (lead's call — filed only)
- Either drop the 按截止日期 option in the box, or give dueOf a real signal (e.g. the date chip /
  scheduled ts a task carries if any future feature adds dates to box rows). Alternatively relabel
  to reflect what it does.

**Status**: fixed — commit ed58139d. Decision context presented at review: relabel is incoherent
here (dueOf falls back to createTime, so a truth-label would read 按创建时间 next to an identical
按创建时间 option) → dropped. TodoBoxView offers created + difficulty only; a legacy persisted
'due' sorts by createTime (comparator default branch) and labels 按创建时间, never the raw key.
Pins: tests/unit/components/j3-box-due-sort-honesty.test.mjs (RED-first verified) + unit-more4
updated to the new contract. Live-verified on rebuild train #7 (j11-01/02.png): the dropdown
offers 按创建日期/按预计工作量 only; a legacy persisted 'due' renders 按创建日期 in the trigger —
the raw key is gone.

---

## [J4] P3 Row title renders `#工作` AND a separate `#工作` chip — visual duplication of the same tag

**Evidence**
- `j2-91-tomorrow-view.png`: row shows title `交报告 #工作` and directly below it a `#工作` chip.
- Eval: row title textContent `交报告 #工作`; tags list `["工作"]`.
- Code: `renderer/js/components/TodoItem.vue` line 34 renders `{{ todo.taskContent }}` verbatim
  (tags live inside the content string by design), while line 52 renders `#{{tg}}` chips from
  `extractTags(todo.taskContent)`. Same token, twice, in one row.

**Proposed fix** (lead's call — filed only)
- Strip tag tokens from the displayed title (keep them in the stored content), or stop rendering
  the chip when the title already visibly carries it. Stripping at display time is the common
  resolution (title CSS-truncation also counts the tag text against the budget today).

**Status**: fixed — commit 5041db7b. `utils/search.js` gains `stripTagTokens` (same TAG_RE
contract as extractTags, whitespace-collapsed, '' when nothing survives); TodoItem renders the
stripped `displayTitle` in both title branches, an only-tag title falls back to the raw content
(row never blanks), tooltip/aria-label keep the raw text, and `highlightedTitle` highlights the
stripped title so a query cannot re-import a stripped token. Store content stays the single
source. Pins: tests/unit/components/j4-tag-title-dedup.test.mjs (RED-first verified). Live-verified
on rebuild train #7 (j11-03/04.png): `交报告 #工作` renders title 交报告 + a single #工作 chip, the
tooltip keeps the full content, and searching 交报告 highlights the kept text with no token
re-imported into the title.

---

## [J5s] P1 数据复盘 上周 tab: computed threw on every click — the UI kept showing THIS week's data under the 上周 pill, with zero error feedback

**Evidence**
- `j5-02-stats-lastweek.png` (pre-fix): 上周 pill selected (dark), range label still 「10.19 - 10.22」,
  KPIs 完成事件3/新增4/达成率75%, 完成最多的一天 3个 **10/22** — a day outside last week, presented
  as last week's best day.
- `j6c` state probe (pre-fix): hash correctly became `#/todo-list/statistics?period=lastWeek`
  (the `period` watcher/syncQuery fired), the label/KPIs did not move, and the console captured
  `TypeError: s.add is not a function at periodBounds` — once per click.
- Post-fix (`333f9ec7`, rebuilt bundle, `j6d-01-lastweek-fixed.png`): 上周 → label 「10.12 - 10.18」,
  KPIs all zero, review headline 「上周共完成 0 个事件、专注 0分钟，以休整为主」, no console errors;
  上月 label now inclusive 「09.01 - 09.30」 (was 09.01-10.01); 近30天 unchanged (regression held).

**Root cause**
- `renderer/js/views/statistics/chartModels.js` `periodBounds()` lastWeek branch:
  `const s = isoWeekStart(...)` — `isoWeekStart()` (`utils/weekGrid.js:27`) returns an epoch
  **number**; `s.add(7, 'day')` threw on every 上周 click. thisWeek's branch only reads `.start`
  from the same helper, which is why the default view worked and masked it.
- The label additionally displayed the **exclusive** `end` as if it were a covered day: 上周
  10.12-10.19 (real last day 10.18), 上月 09.01-10.01 (real last day 09.30), custom to=10.07
  showed 10.07. Fixed by formatting `end - 1` (wall-clock ends unaffected at MM.DD resolution).

**Audit-class note (recurring silence pattern — lead asked this be recorded)**: `errorCaptured`
does **not** see descendant **computed** throws. A computed that throws leaves Vue serving the last
successfully cached value; no toast, no error note (`cardError` stayed false), route/pill state
moved while the data silently froze. The evidence chain — route hash moved + label didn't + console
TypeError — is the proof template for this class: **thrown computed → stale cached computed → UI
gaslights the user**. Any "control updates but data doesn't" report should check the console for a
swallowed computed throw before blaming reactivity wiring.

**Fix**
- `chartModels.js` lastWeek: pure number math `start + 7 * DAY_MS` (same exclusive-end contract).
- `StatisticsView.vue` `periodRangeLabel`: format `min(end, endOfToday) - 1`.

**Status**: fixed + live-verified on the rebuilt renderer-dist — commit 333f9ec7 (files:
renderer/js/views/statistics/chartModels.js, renderer/js/views/StatisticsView.vue; test pin in
tests/unit/components/w5-stats-chartmodels.test.mjs; 46/46 stats unit tests green, eslint clean).

---

## [J1r] P2 Quick-add never sets reminders — a time-bearing NL input ("后天 09:30 写周报") renders a 09:30 chip but creates reminderTime: 0

**Origin**: cross-team handoff (config-surface-auditor live proof; their reminder circuit verified
healthy end-to-end — a typed reminder fired at +117s). Purely the quick-add handoff:
`QuickAdd.vue` hardcoded `todoReminderTime: 0` in the onEnter payload while stripping the consumed
time phrase from the content. The placeholder invites exactly this input; the chip shows the time;
the reminder silently never happens.

**Fix (option a — pass the parsed time through)**, commit efec4cea:
- `renderer/js/utils/quickAddDate.js` gains `reminderTsFromParse({ pickedDate, parsed })`: both
  parser branches append a trailing `HH:mm` to the parse label exactly when a time-of-day phrase
  was consumed (Chinese core + English branch), making the label a reliable time-bearing signal.
  Guards: a manual date chip (`pickedDate != null`, including explicit-clear 0) wins the date, so
  the NL time never becomes a reminder on a different day; date-only / no parse → 0.
- `renderer/js/components/QuickAdd.vue` onEnter payload: `todoReminderTime = parsedReminderTs`.
  `createLines` (multi-line paste) stays 0 — its contract skips NL parsing per line.

**Tests**: tests/unit/store/unit-quickadd.test.mjs pins CN date+time / time-only / EN labels and
date-only ×3 / chip-override / no-parse → 0. Regression suites green (same 4 documented
maint-0927-domainA pre-existing reds).

**Status**: fixed — commit efec4cea; live verification (reminder ts + visible row chip + full J1/J2
regression matrix, since efec4cea touches QuickAdd.vue again) queued on rebuild train #4.

---

## [J10] P2 待办箱批量「安排到今天/移动到分类」的撤销是静默空操作 — undo toast closes, nothing reverts (persists through reload)

**Evidence (live classification protocol, `j9-undo-defect.mjs` → j9-0*.png)**
- Seed 3 undated rows → select all → 安排到今天 → all rows `{d: today}`; click 撤销 → wait 3.5s →
  **rows still `{d: today}`**, box still empty; `location.reload()` (renderer re-hydrates from the
  DB = second-path check) → **still `{d: today}`**. Not a UI-refresh bug: the undo never wrote the
  old values anywhere. Rows still exist (no row loss) — the PRE-MOVE state is silently
  unrecoverable via the promised control → undo-as-silent-no-op.
- Control: single-item complete→undo restores correctly in the same session (undated row back in
  the box, undone) → the defect is batch-specific, pinning the batch handlers.
- batchCat (移动到分类) carries the same construction → same no-op.
- Impact note (lead-requested): a batch mis-move is exactly when 撤销 matters most — every user who
  batch-moved rows and hit 撤销 has been silently stranded in the moved state since the batch
  feature shipped, with the toast actively promising a revert that never happens.

**Root cause** — snapshot-after-dispatch on a row mutated in place:
- `TodoBoxView.batchToday`: `snap.push({ id, revert: crossDayRevertPatch(raw, patch) })` runs AFTER
  `await this.$store.dispatch('todo/updateTodoFields', …)`, and `updateTodoFields` →
  `upsertLocal` mutates the live row in place (`store/todo.js` `Object.assign(list[i], todo)`,
  its own comment: "capture BEFORE upsertLocal mutates the row in place"). So `raw` is already
  the NEW row when the snapshot reads it: revert = the move itself.
- `batchCat`: same ordering — `snap.push({ id, categoryId: raw.categoryId })` after the await.
- In-repo precedent documenting this exact live-ref class: `side-nav/categoryDelete.js` ("without
  the copy the pre-delete snapshot the undo restores from would already be overwritten — a silent
  no-op"); correct shape: `utils/core.js rescheduleExpired` (snapshots BEFORE the dispatch).

**Fix (snapshot before the awaited dispatch, both paths)**
- batchToday: `snap.push({ id, revert: crossDayRevertPatch(raw, patch) })` moved BEFORE the
  `await`; dispatch failure pops the entry so a dead row never gains a phantom undo (per-row
  failure isolation unchanged).
- batchCat: `const prevCatId = raw.categoryId` captured before the `await`.

**Tests**: tests/unit/components/j9-batch-undo-snapshot.test.mjs — 4 pins: (1) snapshot holds the
undated pair + the real revert closure restores it; (2) a second apply/undo pair does not
double-apply (no drift); (3) batchCat snapshot holds the pre-dispatch categoryId; (4) a failed
dispatch leaves no phantom undo entry. Verified red on the pre-fix view (stash) / green after.
Adjacent suites (navgate/d4/d-wave) 18/18 green; eslint clean.

**Status**: fixed — commit a6b902e9 (renderer/js/views/TodoBoxView.vue +
tests/unit/components/j9-batch-undo-snapshot.test.mjs); live re-verified on rebuild train #6
(j10b-undo-reverify.mjs, j10b-0*.png): batchToday undo → rows back to `d:0`, box badge restored 2;
batchCat undo → categoryId back to 0 (未分类); batch-delete undo (first-ever coverage) → both rows
restored from the recycle path, box badge 2.

---

## Healthy (no finding)

- Plain add from 今日待办 → lands today, toast names the day; add from 待办箱 → lands undated with
  `已放入待办箱` toast (J1 screenshots + dumps).
- Complete from box dot → moves to 已完成 with undo `<a>撤销</a>` toast that actually restores
  (verified completed→undone via toast click).
- Context-menu 删除到回收站 works; batch select/安排到今天/移动到分类/删除(带确认弹窗) all execute —
  but their aggregate undo was a silent no-op for batchToday/batchCat (see [J10], fixed); batch
  delete undo was not separately verified.
- Category create (sidebar +, inline edit), rename (hover pencil), delete-with-todos (tasks move to
  未分类, honest undo toast naming counts), undo restores category AND task assignments (j3-01..03).
- Tag view (`#工作` chip click) and search (周报) return the right rows (j3-04/05).
- 待办箱 category filter=工作 correctly empties with 暂无日程 + 去新建任务 (j3-08).
- 已达成 lists today's completions; 数据复盘 renders canvases with coherent counts (完成2/新增3/达成率67%).
- Sidebar collapse/expand; date-strip day navigation; 回到今天 button; per-day empty states
  (j4-01..07).
- Date-only input (`明天`) is politely refused with a dedicated message (F3) — by design.

---

# Round 2 (2026-10-22 evening) — mandate A2

## [K1] Quick-add durability — CLOSED AS PROBE ARTIFACT, zero product defect

The P0 candidate (quick-add rows gone after reboot) did not survive forensics. My write-chain
trace (Enter → `todo/addTodo` → `upsertLocal` + `safeUpsert` → pending queue + localStorage mirror
→ `commitCommand('todo','put')` → `commands:commit` → op `upsert`, success-spliced) is confirmed
healthy end-to-end, and config-surface-auditor's corrected smoke-v3 (a921e3d0) proved the full
4-flavor matrix (today/box × crash-0-dwell/graceful) SURVIVES: graceful quit checkpoints the DB;
crash-riding rows fold in from the WAL at resume. Round-1 lesson re-earned: my session-2 "getAll
empty / pending blob absent" read was a probe-shape bug (promise serialized inside
JSON.stringify; view/selector mismatch), not a store truth. D15 crash-proof queue analysis stands.
Renderer chain + durable store: healthy at every link.

## [J15] P2 清空回收站 always reported failure while actually purging — ids-array contract vs `=== true`

**Evidence (j14b/j14c)**: the full triple-confirmation keyword flow completed, then the honest
wait-for-success rule toasted 清空失败：回收站数据未删除，请重试 — while a direct
`window.todoAPI.purgeRecycleBin()` probe returned the purged-id ARRAY and the next getAll came up
empty (rows hard-deleted; the in-memory bin "revived" until reboot). Per-item 彻底删除 was
unaffected (purgeIds → hardDelete path) — the bin looked half-working. Root cause: db.purgeRecycleBin
returns the physically purged ids (row-granular contract, oplog tombstone expansion); store/todo.js
checked `=== true`.

**Fix** (commit 81b5aaf8): accept `res === true || Array.isArray(res)`; rejections keep the
honest-failure path. **Tests**: tests/unit/store/j15-purgeall-ids-contract.test.mjs (ids-array ACK
clears the in-session bin, empty-array ACK, rejection stays failure) — RED on the old check,
verified.

## [J17] P3→dispositioned 子任务 auto-complete 撤销 ate the user's own child checks

**Evidence (j13)**: check 子一 (1/2) → check 子二 (2/2, parent auto-completes with undo toast) →
undo → parent incomplete AND both children unchecked (0/2). Root cause: the toast's undo closure
re-dispatched `toggleComplete` (a blind re-toggle); with isCompleteWithSubtasks ON the re-toggle's
uncheck cascade wiped both children — reverting more than the system did and eating the user's own
click. **Disposition (lead)**: snapshot-revert.

**Fix** (commit ad1207d6): `toggleCompleteWithUndo` snapshots the exact pre-toggle completion
surface (complete/completedAt/subtasks) BEFORE the dispatch; the undo restores it via
`updateTodoFields` (a revert, not a second toggle), and now returns the dispatch promise
(awaitable). The F4 double-click guard and honest-feedback paths kept; cascade-OFF isolation
unchanged. **Tests**: tests/unit/components/j17-complete-undo-snapshot.test.mjs — four directions
(child-driven auto-complete / parent-driven cascade / uncomplete restore / cascade-OFF);
scenarios 1+3 verified RED on the old re-toggle (stash check). Live re-verify queued on the
round-2 rebuild.

## Round 2 — healthy so far

- Subtask add/counts/cascades (j13): add 2 subs → 0/2; parent complete → children checked 2/2;
  uncomplete → unchecked 0/2; child-driven auto-complete fires at 2/2; 已达成 reflects the state;
  isCompleteWithSubtasks=false isolates (parent completes, children untouched, no reverse cascade).
- Recycle bin walk (j14): quick-del + Shift+Delete both bin with deletedAt stamped (durable
  verified); bin view count; 恢复到今天 returns the row to today; complete-inside-bin keeps the
  deleted state; single 彻底删除 hard-deletes durably; retention aging (backdated deletedAt past
  N days → force purge removes from store AND durable; fresh row kept — deletedAt-only trust
  confirmed live).
- Probe-shape lessons recorded: raw settings pokes do not dispatch computeViews (order checks
  belong at unit level); synthetic contextmenu cannot drive the task-menu builder (real-input
  path verified separately); `window.todoAPI` is frozen (op sniffing needs a main/preload hook).

## Round 2 — undo edge matrix (j16/j16b): all green

- Expiry: after 6.5s the toast is gone and the completion persists (link dead = no hidden revert).
- Undo after an unrelated add: only its own row reverts; the unrelated task survives.
- Double-click 撤销: exactly one revert (F4 guard + idempotent snapshot-revert).
- Undo after reload: toast gone, undoStack cleared to 0, the completion itself persisted.

## Round 2 — search 搜索 deep (j18): all green

- Field coverage: title hit + description hit both return with the term highlighted; tag-only
  rows are found via `#tag` queries (verified WITH J4's stripped titles — the chips index, not
  the title text, so the dedup fix does not hollow out search).
- No-results: 共 0 条 + a named-query empty state ("… 没有找到相关日程") + 清除筛选并重搜 escape
  hatch; cleared-state returns to the previous route with rows restored; whitespace-only queries
  are ignored (no search route entered).

## Round 2 — 日程概览 walk (j19b): all green

- Month grid renders (custom grid, Monday start), today cell highlighted, seeded event pill
  visible; month nav `<`/`>` cycles 2026年10月 → 11月 → back; event click opens the edit panel;
  月/周/时间块 view switcher works (week title 2026年9月28日 · 周日, `?view=week`).

## Round 2 — 数据复盘 seeded truth + 300-row smoke (j20/j21): all green

- Seeded via cli/lib.js in-process (TODO_DB_DIR = userData root per the corrected env split):
  5 dated-today + 1 expired-undone + 1 future + 300 undated 压测行; 2 completed today. CLI
  overview locked the truth (today 5/2 done, overdue 1, noDate 300, upcoming 1).
- App on the same dir (bootJourney `dataDir:` — first run used the wrong option key `resumeDir`
  and silently booted a fresh db; the driver option is `dataDir`, alias `resumeDir` is internal):
  复盘 shows 完成事件 2 / 新增 307 / 达成率 33% (= 2 done ÷ 6 dated-today+overdue — reconciles
  exactly), trend window 10.19–10.22.
- 300-row smoke: box renders 300/300 rows, six scroll sweeps ~1.6s total, quick-add + complete
  land within ~1s rounds, ZERO console errors.

## Round 2 — i18n flip en-US (j22): surfaces green; html-lang red = d2's fix pending rebuild

- en-US: nav (Today/Calendar), quick-add placeholder, and the add toast all render English;
  zh-CN flip-back restores everything.
- `<html lang>` stays `zh-CN` under en-US on the train-8 bundle — the exact d2-HTMLLANG defect
  already fixed on-branch (ea8a8a09, boot-time lang application); live re-check queued on the
  round-2 rebuild. Cross-check, not a new finding.

## Round 2 — train #10 triple verify + addenda closures

- **J15 ✓ LIVE** (train #10): purge-all → success toast 已永久清空回收站（1 条任务）, no
  清空失败, bin empties in-session (j23-01).
- **J17 ✓ LIVE** (train #10): child-driven auto-complete → undo → child checks survive [T,T],
  parent back to incomplete — snapshot-revert works in the real app (j23-02).
- **html-lang ✓** with the assertion corrected per the lead's verdict: ea8a8a09 sets the BCP47
  short form `en`, not `en-US` — my j23 leg-3 expectation was the artifact; no product change.
- **[dw3 day-caliber] REAL REGRESSION from my round-1 merges — fixed 66a86011, not re-anchored.**
  The counted ratchet (no additive/multiplicative ms day-step in renderer/js) caught MY J5 stats
  repair: chartModels.js lastWeek used `end: s + 7 * DAY_MS`. `s` is always a local midnight, so
  `+dayShift(s, 7)` is semantically identical and calendar-exact — the sanctioned primitive, same
  as the file's own line-61 window builder. Caliber suite 15/15, f1-stats-fixes 8/8, eslint clean.
- **[ENV] lan-sync-journey spawn stripped of ELECTRON_RUN_AS_NODE (d91eab72)** — this DSH host
  exports it (=1 confirmed); J1 standalone green after the fix. e2e-exit-close F1 already strips
  (line 131) and passes standalone; its observed red is host-load flakiness on the closeRequest
  quit races, not env. Known pre-existing: full lan-sync-journey hits the 300s runner cap at J5+
  under load (J1–J4 green individually).

## [J7] P2 a reminder born ALREADY PAST-DUE never fires — the two mechanisms disagreed — FIXED 8c889c07

pomodoro R2 located the root (scheduler.js was outside their scope); this lane fixed it.
`needsCatchUp(todo)` returns true for a past unfired instance, so the write path delegates to the
full reloadAll — whose catch-up gate `ts > lastSeen` can never cover a main reminder created
behind the frontier (the watermark predates the row). Swallowed with zero feedback; the frontier
then advanced past it forever.

**Fix (reloadAll catch-up branch)**: exemption for the MAIN instance (offset 0) whose row
`createTime > lastSeen` — never seen by any sweep → fires once through the same fire-then-watermark
path. Guardrails: peer-synced history (createTime ≤ lastSeen) stays swallowed (D22 anti-bombardment);
offset/extra instances keep never-fire-past semantics (a degenerate past offset on a future anchor
is an anchoring artifact); firstRun still skips everything; failed fires still roll the frontier to
ts−1 (D22 P3) and firedReminders still dedups forever. **Tests**
(tests/unit/main/j7-born-past-due-reminder.test.mjs): fire-once + no-re-fire, history-not-fired,
degenerate-offset-not-fired, failed-fire-retry-eligibility — 1+4 RED on the old gate, 2+3 green
guards; all 8 scheduler suites 37/37; eslint clean. Known residual (needs a reminder-modified row
stamp to do right): re-aiming an OLD task's main reminder into the past via the edit panel stays
unfired — filed, not fixed, to keep the sync-history guarantee.

---
