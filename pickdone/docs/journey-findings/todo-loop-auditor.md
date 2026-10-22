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

**Status**: filed (P3, lead decides).

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

**Status**: filed (P3, lead decides).

---

## Healthy (no finding)

- Plain add from 今日待办 → lands today, toast names the day; add from 待办箱 → lands undated with
  `已放入待办箱` toast (J1 screenshots + dumps).
- Complete from box dot → moves to 已完成 with undo `<a>撤销</a>` toast that actually restores
  (verified completed→undone via toast click).
- Context-menu 删除到回收站 works; batch select/安排到今天/移动到分类/删除(带确认弹窗) all work,
  aggregate undo toast restores the whole group (j1c-*, j1b-*).
- Category create (sidebar +, inline edit), rename (hover pencil), delete-with-todos (tasks move to
  未分类, honest undo toast naming counts), undo restores category AND task assignments (j3-01..03).
- Tag view (`#工作` chip click) and search (周报) return the right rows (j3-04/05).
- 待办箱 category filter=工作 correctly empties with 暂无日程 + 去新建任务 (j3-08).
- 已达成 lists today's completions; 数据复盘 renders canvases with coherent counts (完成2/新增3/达成率67%).
- Sidebar collapse/expand; date-strip day navigation; 回到今天 button; per-day empty states
  (j4-01..07).
- Date-only input (`明天`) is politely refused with a dedicated message (F3) — by design.
