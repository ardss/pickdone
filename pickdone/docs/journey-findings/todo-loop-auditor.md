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
updated to the new contract. Live verify queued on train #7's rebuild.

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
source. Pins: tests/unit/components/j4-tag-title-dedup.test.mjs (RED-first verified). Live verify
queued on train #7's rebuild.

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
