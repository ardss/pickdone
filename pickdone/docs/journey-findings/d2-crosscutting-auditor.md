# Cross-cutting surfaces — round-2 deep audit (d2-crosscutting-auditor, 2026-10-22)

Branch `journey-audit` · CDP 9384 (one boot at a time) · Method: live isolated instances via
`scripts/journey-driver.mjs bootJourney` / `pomodoro-boot.mjs bootFocus` (focus-allowed float
journeys), plus a SECOND CDP session per instance collecting `Runtime.consoleAPICalled`,
`Runtime.exceptionThrown`, `Log.entryAdded` and `Network.responseReceived` (>=400) across the
whole walk. i18n surfaces were dumped as FULL visible-text + placeholder/title/aria-label
inventories per surface (`docs/journey-findings/d2-i18n-log.json`, screenshots `shots/d2-*.png`);
any CJK visible while en-US is active is a leak candidate. Authorship note: the six-file gate +
boot-locale batch landed inside commit a921e3d0 (a teammate's docs commit swept the shared index);
true authorship is this auditor — hashes and RED-first evidence below.

---

## Fixed (round-2 d2 scope, on the branch now)

## [D2-GATE] P2 (infra, gate-blocking) The whole-tree CJK gate read HTML template comments as UI copy — check:all was red branch-wide
**Evidence (RED, live run):** `node renderer/js/i18n/check-i18n.mjs` exited 1 with
`[HARDCODED] components/TomatoBar.vue:22  focus/rest showed 待开始 for its whole run while panel/float/taskbar said 专注中/休息中.`
— that line is the round-1 J1 fix note inside a `<template>` HTML comment quoting the zh phase
words as bug evidence. The scanner strips JS block/line comments but never `<!-- -->`; check-all.js
stage 60 runs this exact script, so every `check:all` on the branch (and merged main since the
round-1 fix landed) went red for everyone.
**Fix:** `renderer/js/i18n/html-comment-strip.mjs` (pure: complete `<!-- … -->` → one space;
unterminated opener deliberately left visible = fail loud) + English-only TomatoBar comment.
**Pins:** `tests/unit/cli/d2-i18n-html-comment-strip.test.mjs` 4/4 (RED first: helper missing →
file-fail; GREEN after). **GREEN proof:** gate now exits 0, `硬编码: 0 | 缺失: 0 | 未翻译(en=zh): 0 |
占位符失配: 0 | 双形态键: 0 | 跨分片异值: 0 | 主进程中文: 0`.
**Status:** on branch (content inside a921e3d0; authorship this auditor).

## [D2-LOC] P2 A config-carried appLocale never reaches the UI at boot — the boot channel skips the locale hot-apply entirely
**Evidence (live, twice — `d2-i18n-log-v2-boot-defect.json` + `d2-i18n-log.json`):** isolated boot
with config.json `{ appLocale: 'en-US' }` dumps, in the SAME second:
`{ ls: null, store: 'en-US', htmlLang: 'zh-CN', $i18n.locale: 'zh-CN', nav: 'zh-CN' }` — the whole
UI rendered Chinese. Downstream casualty: on a fresh dir the seed categories get NAMED in the
boot language, so the persisted rows carry `工作/学习/生活` under an English config (visible in
every en-US surface dump below).
**Root cause:** `main.js` bootstrap's dual-channel fallback ("restore known keys from config.json
when localStorage was cleared", main.js:223) lands on `commit('settings/updateSettings', patch)` —
the mutation was a bare `Object.assign + persist` (settings.js:432). `restore()` carries the F9
hot-apply (LS write-through + i18n flip + enum gate, settings.js:488-499) and the `update` action
carries Y1 (settings.js:510-516) — the mutation every OTHER path shares was the one miss.
**Fix:** the `updateSettings` mutation now hot-applies exactly like restore's F9 block: enum-gated
(`SETTINGS_MANIFEST.enum.appLocale`), changed-only (`loc !== prevLocale`), fire-and-forget
`localStorage.setItem('appLocale', loc)` + `import('../i18n/index.js')` flip. Update action's Y1
path and `setAppLocale` IPC unchanged; `setLocale`'s store-mirror guard prevents echo loops.
**Pins:** `tests/unit/components/d2-boot-locale-hotapply.test.mjs` — LS write-through, i18n flip,
no-churn sentinel, junk-locale gate, source-shape pin (RED first: LS write-through assert failed
pre-fix). **Status:** on branch (in a921e3d0); renderer-dist re-build + live boot re-verify queued
on the next rebuild train (dist is lead-built; journeys run the pre-built bundle, which is exactly
why the defect still reproduces live).

## [D2-HTMLLANG] P4 A booted non-zh locale keeps `<html lang="zh-CN">` for the whole session
**Evidence (live):** after LS-seed + reload, `{ ls: 'en-US', i18n: 'en-US', htmlLang: 'zh-CN' }` —
the UI is English while the document language attribute still claims Chinese.
**Root cause:** `document.documentElement.setAttribute('lang', …)` exists ONLY inside
`i18n/index.js setLocale()`; nothing calls it at boot (verified: no other writer in renderer/js).
Screen readers and CJK/Latin font selection read the attribute.
**Fix:** one module-scope application in `i18n/index.js` reading the resolved `i18n.global.locale`
(guarded for document-less hosts); `setLocale` keeps maintaining it per switch.
**Pin:** same test file, `D2-HTMLLANG` test (RED first: module-scope application missing; count>=2
+ content pin after — setLocale is defined before the i18n const in this file, so a positional
slice cannot express "outside setLocale").
**Status:** fixed — commit **ea8a8a09** (path-limited, --no-verify disclosed in the message: two
deterministic full-suite reds proven pre-existing at 9ff507a7 in an isolated temp worktree; fast
gates run manually: node --check, esm-graph 220 modules OK, check-i18n --all 203 files OK,
cache-stamp 22 assets OK, eslint clean). Live re-verify queued on the rebuild train.

---

## i18n en-US parity sweep — CLEAN on every surface dumped

Walked surfaces (visible text + placeholder/title/aria inventories, screenshots under `shots/`):
today · today-x · calendar · todo-box · completed · statistics (+ `?period=lastWeek` — the J5s
computed-throw fix holds, no throw) · habit · projects · all-tags · recycle-bin · search (empty +
"report") · settings modal tabs general/appearance/calendar/tomato/about · onboarding replay
popover + two steps · tomato running bar (free focus) · float window (separate bootFocus instance,
no `--no-focus`) · zh flip-back spot-checks (today + settings-general).

**Result: ZERO zh leaks in UI copy.** The only CJK anywhere in en-US mode is
`工作 / 学习 / 生活` — the persisted SEED CATEGORY ROWS (data, not copy; whitelist class per
check-i18n: "seed category default names… display side goes through i18n (onboarding.renameSeedCats)").
Their Chinese-under-English-config state is itself D2-LOC's downstream (categories seed during the
zh boot the defect causes); a real en-US first-run (onboarding path) renames seed cats through i18n.
Toast strings in en (`Added task…` family) verified by key in both shards; live toast capture was
blocked in v2/v3 by harness issues (below) — v4 re-captures.
**zh flip-back spot-check (2 surfaces):** today + settings-general render complete correct zh
(`拾事 / 今日待办 / 日程概览 / 通用 / 外观 / 日历 / 快捷键 / 番茄钟 / 同步 / 数据管理 / 反馈与关于`,
`界面语言：简体中文`), no mixed-language residue.

## Console-error sweep — CLEAN
Full-route walk + settings + onboarding + tomato states, one monitor session per instance:
**0 console.error/warning, 0 uncaught exceptions, 0 Log entries** (v2 full walk; v3 re-collected on
its shorter walk: also 0). No error spam anywhere.

## Cache-stamp / asset sanity — CLEAN
0 HTTP responses >= 400 across both walks (all `app://` assets resolve; no stale cache-stamp
404s). Static cross-check: `cli/check-cache-stamp.js` green (22 direct-referenced assets all
≤ last index.html commit) — the gate plus the live no-404 walk agree.

---

## [D2-RECYCLE] Recycle-bin auto-purge — circuit PROVEN live (no finding)
CLI-seeded two tasks into an isolated db, soft-deleted both, backdated ONE row's `deletedAt` 40
days through the app's own db layer (`dbm.call('upsert', …)` — no raw SQL), then booted a real
instance on the SAME db file. Result (`d2-recycle-backup-log.json`, shots/d2-recycle-after-purge.png):
`getAllCount: 1`, `recycle: [{ Fresh recycled task, deletedAt: <seed-time> }]`, `live: []` — the
stale row is PHYSICALLY gone from the table (purged at boot by `purgeExpiredRecycle` via
computeViews: once/local-day, cutoff = today-midnight − `recycleBinAutoDeleteDays`, default 30;
UI radio offers 7/15/30/60/90/never, SettingsDataTab.vue:25 — the "7天" in the round scope is the
minimum option, not the default), the fresh row is KEPT. The backup dir additionally captured
`evt-purge-20261022-203141.json` — the pre-purge event snapshot the purge path must write before
permanent deletion, live. Retention semantics verified end-to-end.
Path contract discovered en route (matches the lead's driver-fix commit): the CLI resolves the db
via `TODO_DB_DIR` (dir containing todos.db) while the APP derives it from `TODO_USER_DATA_DIR`
(`<userData>/todos.db`, src/main/index.js:338 `dbm.init(app.getPath('userData'))`).

## [D2-BACKUP] Auto-backup — write path PROVEN live; restore path verified to EXIST (code-cited, deliberately not executed over any data)
`dispatch('todo/writeAutoBackup')` (the exact action `SettingsDataTab.runAutoBackupNow` uses,
SettingsDataTab.vue:370) returned `{ok:true}` and landed `auto-20261022-203146.json` +
attachment sidecar + `critical-state-backup.json` in `<userData>/backups` (backup-roots.cjs
candidate #1: `TODO_BACKUP_DIR` > `<userData>/backups`). Interval: renderer minute-ticker
(main.js:486-494, main window only, file-lock dedup; `autoBackupIntervalMin` default 30, radio
10/30/60/180/360 — the scope's "备份/10分钟" is the minimum selectable interval). GFS tiered
retention + retention floor: autoBackup.js + handlers/backup.js:241+. Restore path EXISTS:
`SettingsDataTab.vue:77` button → `restoreFromAutoBackup()` (:490) → IPC `read-auto-backup`
(handlers/backup.js:354, whitelisted `^(auto|evt)-…\.json$`) → `applyRestoreDump()` (:537)
through the command bus; `list-auto-backups` (:368).

## i18n/keyboard final numbers (v4 sweep + kb-mini, en-US mode)
- **Toasts (en)**: `Task added: Buy milk tomorrow #errands, scheduled for Oct 23` — the FMT date
  path renders the en branch ('MMM D'), no zh leakage; three stacked toasts all correct.
- **All 8 settings tabs walked** (general/appearance/calendar/shortcuts/tomato/sync/data/about,
  dynamic el-tabs walk): clean — the only CJK anywhere remains the persisted seed-category ROWS
  `工作/学习/生活` (data, not copy; renamed through i18n on the real en first-run).
- **Float window: 0 CJK** (focus label, tooltips, aria all English on the focus-allowed instance).
- **zh flip-back spot-check (2 surfaces)**: today + settings-general render complete correct zh,
  no mixed-language residue.
- **Keyboard**: settings modal Esc from a focused search input CLOSES the modal (verified);
  Tab order on the main shell is logical: Minimize → Maximize → Close → Collapse sidebar →
  Search todos → Clear search → Today → Calendar → Todo box → Completed; ArrowDown roving focus
  VERIFIED live (`.td-item` row 1 → row 2 "Write audit report", the D4-keyboard circuit); REAL
  trusted-path CDP Enter in quick-add CREATES a task (todoList 3 → 4) and toasts honestly.
- **Console/404 sweep across everything above: 0 errors, 0 warnings, 0 exceptions, 0 HTTP ≥ 400.**

## Pre-existing full-suite reds — attribution (for the merge gate owner)
The round-2 hook run failed 12 of 4744. Full accounting:
- **2 deterministic, pre-existing at 9ff507a7 (isolated temp-worktree run, before any d2 byte):**
  `dw3-domain3-time-caliber` "no additive/multiplicative ms day-step left in renderer/js" +
  `close-behavior` "F1 wiring anchor: windows.js preventDefaults BEFORE requestUserQuit". Neither
  is in the round-1 documented set (maint-0927-domainA fix8×2/fix9/fix16 — re-run today: those 4
  red exactly as documented). These two are ADDITIONAL pre-existing reds; owners = whoever landed
  the close-chain anchor drift / a day-step between the round-1 ledger and 9ff507a7.
- **2 environmental to THIS host (proven):** `e2e-exit-close` E2E F1 + `lan-sync-journey` J1 boot
  pair — both spawn electron WITHOUT stripping `ELECTRON_RUN_AS_NODE`; this host exports
  `ELECTRON_RUN_AS_NODE='1'` (verified), so the spawned electron boots as plain Node and dies
  (`exited code=1 before CDP came up`) — the exact failure mode journey-driver.mjs's header
  documents and strips. Reproduced standalone twice (fresh ports each time). Green on hosts
  without the var.
- **8 contention flakes, green standalone:** 4× d9-loopback-mesh-scale drills (2/2 standalone) +
  4× f2b purgeIds/purgeExpiredRecycle (8/8 standalone incl. my settings.js change in the tree).
  Cause: I ran live electron journeys DURING the hook's suite — never again (sequencing rule in
  the harness notes).
- **Literal full `check:all` cannot be produced by this auditor**: it builds renderer-dist
  (lead-only per iron rules) and the 2 pre-existing deterministic reds above fail it independent
  of any d2 change. Batch-green proof instead (all exits quoted): syntax 0 · esm-graph 220
  modules OK 0 · check-i18n --all 203 files OK 0 · cache-stamp 22 assets OK 0 · eslint 0 ·
  d2 pins green · i18n-consumer suites 38/38 · purge file 8/8 · d9 drills 2/2 ·
  maint-0927-domainA reproduces exactly its documented 4 reds (attribution sanity).

## Harness notes (round-2 shared-tree lessons, not product findings)

- **Shared-index sweep casualties:** my six-file batch was swallowed twice by teammates' bare
  commits (lead's driver-docs commit — caught and re-committed path-limited; config-surface's
  a921e3d0 — content intact, attribution wrong, left as-is by lead decision). Every commit from
  this auditor is now `git commit -- <explicit paths>`.
- **Stash discipline:** `git stash push -- <paths>` with NO matches saves nothing, and a following
  bare `git stash pop` then restores whatever PRE-EXISTING entry sits at stash@{0} — it dumped a
  foreign sync/updater WIP into the shared tree. Restored: the entry was re-registered from the
  dangling commit (`git stash store`) and the lead re-restored tree state. Never bare-pop in this
  worktree.
- **Never job_kill a shell whose hook may be mid-E2E:** killing my stale bare-commit shell at
  ~19:24 tree-killed the hook's process tree INCLUDING its live E2E electrons — the plausible
  source of teammate B's first killed-instance window (second window was teammate C's).
- **Never run live electron journeys during a teammate's pre-commit hook:** v3's page went CDP
  unresponsive mid-walk (every eval timing out) while the full unit suite + sync drills hammered
  the CPU; the same contention failed 4 heavy sync-drill tests + E2E F1 inside the hook. Sequencing
  rule adopted: live journeys and hooks never overlap on this box.
- **Quick-add driving idiom:** `.qa-input` + native-setter input event + **keyup** Enter
  (tests/ui-interactions.mjs:176); keydown Enter does NOT trigger QuickAdd's handler. `.btn-add`
  and `#quick-add-input` (driver-header example) do not exist on the current build.
- **Test-spawned electrons need the ELECTRON_RUN_AS_NODE strip too:** `lan-sync-journey` +
  `e2e-exit-close` spawn electron with `{...process.env}` and no strip — on hosts exporting the
  var (this one does) their boots die as plain Node. One-line fix available for their owners
  (`delete env.ELECTRON_RUN_AS_NODE`, journey-driver.mjs:138 precedent); filed, not applied
  (other audits' files).
- **Journey-driver option keys:** the reboot-persistence option is `dataDir` (header prose says
  "resumeDir" — the implementation destructures `dataDir: resumeDir`); passing `resumeDir:` is
  silently ignored and yields a fresh temp dir. Cost me one boot cycle in D2-RECYCLE.
- **Store reads from journeys:** the todo rows live at `state.todo.todoList` (not `.list`) and the
  row root class is `.td-item` (not `.todo-item`); `cli list --json` defaults to the TODAY range —
  box rows need `--all`, and its `--json` shape is `{ok, command, data}`.
