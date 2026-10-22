# Config-Surface Journey Audit — config-surface-auditor

Auditor: config-surface-auditor (real-user journey audit, 2026-10-22).
Scope: settings modal (all tabs), onboarding wizard, security lock, data location, account area, reminder scheduling smoke.
Instrument: `scripts/journey-driver.mjs` bootJourney on CDP 9383, one isolated instance per journey, `end()` after each. Dist rebuilt by the lead at 15:54:46 (carries 8ac982ee) — J6 ran on fresh dist; J1–J5 on the prior dist (none of the findings below depend on the diff).
Shots + machine results: `%TEMP%\journey-config-auditor\shots\` (01–31 PNGs, j1/j2/j3/j4/j5b/j6 result JSONs, j5b stdout log).

Commits on branch `journey-audit`:
- `8ac982ee` — fix(settings): security-lock password row reachable while lock is OFF (J2, P1) + stale replayOnboarding comment corrected (J3 hazard [b]).
- `d1f8393e` — fix(onboarding): first-journey stage A guides instead of ambushing (J3, P3) — popover-fire live verification rides rebuild #2.

---

## [J1] WONTFIX (P1 candidate withdrawn) — first-run onboarding wizard is unreachable for real new users
**Status: wontfix — documented product call (commit c363da31, same evening as the "restore" commit). Do NOT flip the flag.**

Evidence (J1, virgin boot, fresh data dir, empty db, no localStorage):
- boots straight into `#/todo-list/today`; `.ob-mask` absent; localStorage `onboardingDone` silently backfilled to `'1'` at boot;
- after `localStorage.removeItem('onboardingDone')` + reload → still no wizard, flag re-backfilled;
- db meta `onboardingDone` stays `null` (the disabled path never dual-writes it); `countAll` = 0;
- shots `01-virgin-boot.png`, `02-after-reload.png`.

Root cause (full gate chain):
1. `renderer/js/components/Onboarding.vue:78` — `const ONBOARDING_ENABLED = false` (hardcoded; NOT a config.json key, so seedConfig can never reach it).
2. `Onboarding.vue:92` mounted() — `if (!ONBOARDING_ENABLED) { localStorage.setItem('onboardingDone','1'); return }` — the early return precedes EVERY flag read (LS flag, `settingsState`, db meta `onboardingDone`, `countAll>0` backfills). No seed value, config key, or db state can summon the wizard.

Promise vs behavior: commit `ecf5c81b` (Sep 8 19:07) "restore first-run onboarding wizard and add a 4th step" was reversed 20 minutes later the same evening by `c363da31` (Sep 8 19:27): "user call: keep the first-run wizard disabled; the settings switch plus a one-shot tray balloon cover discoverability" (src/main/close-behavior.js + `closeTrayNotice`, present at HEAD, code-verified). So this is a deliberate, same-day, documented disable — not a silent regression. The wizard is documented dead-until-enabled code ("re-enabling is a one-line flip"; existing-user backfills protect upgrades if ever flipped).

Hazards recorded around it:
- [a] TODAY's d6 batch (`5233bc6d`) polished the dead wizard (Esc-step-back + `onboarding.escSkipConfirm` i18n) — evidence the team treats it as alive. Filed only; that commit belongs to the parallel session, touched by nobody here.
- [b] `SettingsModal.vue` replayOnboarding comment claimed "today-page spotlight" while the code runs the full `runJourney(true)` hands-on tour. FIXED in `8ac982ee` (comment now matches live behavior).
- [c] Auto micro-tours are also off: `renderer/js/utils/onboardingTours.js:8` `AUTO_TOURS_ENABLED = false` ("v0.1 release decision"). The only live onboarding surface = Settings → 新手引导 → 重看引导 (see J3).

---

## [J2] P1 (FIXED — commit `8ac982ee`) — security lock was unenableable through the UI: password row hidden behind the very switch that demands it
**Status: fixed + live-verified end-to-end on fresh dist (J6).**

Evidence (J3, pre-fix, live): Settings → 安全与隐私 → toggle 安全锁 with no stored password → toast `请先设置锁屏密码，再开启安全锁`, switch stays OFF (guard works as coded). DOM probe right after: **`NO-PW-ROW`** — the password input does not exist while the lock is off. After injecting a password via the same chain the hidden input uses (`encryptSecret` + `settings/update`), everything immediately worked: enable ✓, 立即锁定 ✓ (lock window appears), wrong pw → `密码错误` ✓, right pw → unlock ✓, disable ✓, password persists as `enc1:` ciphertext ✓ (shots `12`–`17`).

Root cause: `SettingsModal.vue:132` rendered the password form-item under `v-if="st.enableSecurityLock"`, while `onLockToggle` (line 514) refuses to enable until `st.securityLockPassword` is set. The ONLY password surface in the app (grep `securityLockPassword` across renderer: SettingsModal input + a legacy plaintext→enc1 boot migration in main.js:234) was therefore unreachable exactly when the guard demands it. A fresh user could never turn the lock on.

Fix (8ac982ee): password row renders unconditionally; 立即锁定 button gated on `st.enableSecurityLock`; hint reusing the existing `lockNeedsPassword` copy shows until a password exists; guard untouched. Tests: `tests/unit/components/j-audit-lock-password-reachable.test.mjs` (5 anchors).

Re-verification on fresh dist (J6, post-rebuild): password row visible with lock OFF + hint shown (`26-fix-pwrow-locked-off.png`) → typed `lockpw-9` via the real input → `enc1:` stored → enable with NO guard toast (`27`) → 立即锁定 appeared and locked (`lockWinOpen:true, isLocked:true`) → wrong pw `密码错误` (`28`) → right pw unlocked → disable: switch OFF, config false, row still visible, hint gone, button hidden (`29`). Every step matches the guard's promise.

---

## [J3] P3 (behavior FIXED — commit `d1f8393e`; popover-fire live verification rides rebuild #2) — 重看引导 is visually silent: a mystery sample task appears, then silently vanishes after 30s
Evidence (J2, live): click 重看引导 in Settings → modal closes → a seed task appears in the today list with **zero visible guidance** (`banner:false, driverPopover:false, items:0→1`); 2.5s later still nothing on screen and the stray task remains (`09-replay-exit.png`). Left alone, the 30s poll cap fires `finishAll` → the unadopted seed is silently soft-deleted — the user watched a task appear and disappear with no explanation.

Root cause: `runJourney` seeds the sample task and relays into `stageCreate` only after the seed has rendered, so `stageCreate`'s shortcut `if (document.querySelector('.td-item')) { armGrowth(); return }` always matched the SEED itself — the stage-A instruction popover (`jCreateTitle`/`jCreateDesc`) was unreachable dead code in the seeded path. The growth watch then sat invisible for up to 30s.

Fix (d1f8393e): stageCreate always shows the popover and always arms the watch; the growth baseline counts rows MINUS the seed (so creating your own task still auto-advances); new `pollCappedTour` wrapper re-arms the capped poll while a driver popover is on screen (open popover = user mid-tour, not stuck) and keeps the `finishAll` safe exit otherwise. `pollCapped`, seed dedup, `finishAll`/`cleanupJourneySeed` untouched — d7 + c-wave source anchors pass. Tests: `tests/unit/components/j-audit-stage-create-popover.test.mjs`.

Popover live verification (J8+J9, train #5 dist 17:27:39): **FIXED & VERIFIED.** Root cause ran one level deeper than d1f8393e: the seeded `if (!td-item)` block early-returned ABOVE `let ending` / `const singleStep` / `const finishAll` / `const stageCreate` — its async relay called `stageCreate()` with those consts in TDZ, throwing a swallowed ReferenceError inside the poll interval. Every code version (old and d1f8393e) died silently: seed appears, no popover, no advance, no cleanup (J8 on trains #2/#4 reproduced exactly this; the "stale dist" call at the time was wrong — the lead's minification note explains the false-negative bundle grep, but the live behavior was this TDZ). `9645e378` moved the seeded block below all stage closures and ordered stageCreate popover-first (singleStep's clearWatch would kill a watch armed before it). Live on train #5: popover 「创建你的第一个任务」 fires at ~1s (`39-stageA-early.png`); creating 审计自建任务 auto-advances to 「选中它」 (`40`); closing recycles the untouched seed — remaining tasks = [审计自建任务] only (`41`). Also fixed for the same train: singleStep now passes `prevBtnText` (the disabled first-step back button rendered driver.js's English 「← Previous」 in the zh UI — P4).

---

## [J4] P2 (FIXED UPSTREAM `efec4cea` — LIVE-VERIFIED on trains #4/#5) — quick-add silently dropped the parsed TIME: no reminder could ever come from quick-add
Evidence (J5, live): quick-add input `后天 09:30 写周报` → chip renders `后天 09:30` → task created as `写周报` on 后天 with **`reminderTime: 0`** (`22-quickadd-timedrop.png`). The parsed time is used for the landing date, shown in the chip, stripped from the content — and never becomes a reminder.

Root cause: `renderer/js/components/QuickAdd.vue:301` — `todoReminderTime: 0` is hardcoded in the add payload. The scheduler then correctly ignores the task (`scheduler.js reminderInstances`: no `reminderTime`, no `reminderExtra` → nothing scheduled).

Promise/behavior gap: a Chinese user typing 「明天下午3点 交报告」 (the app's own placeholder suggests exactly this) sees the time confirmed in the chip and reasonably believes a reminder is set; nothing anywhere says quick-add ignores times. Target class: silent promise divergence.

Proposed fix (owner: todo-views auditor / quick-add owner): when `parseNaturalDate` consumed a time (`parsed.date` carries a time-of-day), pass `todoReminderTime: parsed.date.valueOf()` instead of the hardcoded 0; if product wants "time = deadline only", the chip must say so (e.g. chip suffix 免提醒) so the promise stops diverging.

Related verified-good: the reminder circuit itself works end-to-end (J5b): undated quick-add → row click → EditPanel → EpReminders date/time pickers (typed `2026-10-22` / `16:12` + Enter) → `reminderTime=1792656720000` persisted → stdout `[Reminder] fired: tid_840001ZgyCtV_1792656596472 0` 117s later, with scheduler rebuild lines present (`30`/`31` PNGs, `j5b-stdout.log`). Note: the `firedReminders:` watermark flush (60s debounce, plus quit-flush) had not run at readback time — the stdout fire line is the authoritative artifact.

---

## [J5] P3 (OPEN — file only; src/main/data-location.cjs is outside this auditor's write scope) — invalid migration targets surface English engineering reasons to Chinese users
Evidence: code review of the live dialog chain (the native picker itself is not CDP-reachable; isolation-guard path live-verified instead, see J6-note).
- Real-user path: `data:relocate` → `data-location.cjs validateTarget` returns English reasons — `'target exists and is neither empty nor a valid data directory (todos.db + db.key)'`, `'target volume has insufficient free space (… MB < … MB)'`, `'target must be an absolute path: …'` (data-location.cjs:99–127). The renderer toasts `迁移失败：<english reason>` (`SettingsDataTab.relocateData` + `dataLocationFailPrefix`).
- Picking a non-empty folder is the MOST likely real-user rejection, and the toast is untranslated dev copy. The confirm dialogs and progress copy themselves ARE properly i18n'd (`dataLocProgress*`, quit-focus confirm), which makes the raw-error toast stand out.

Proposed fix: map `validateTarget` reasons to i18n keys (zh/en) in the renderer, or have main return reason codes the renderer translates; keep the raw detail as a second line.

**J6-note (not a user bug):** in isolated/test instances (`TODO_USER_DATA_DIR`/`TODO_DB_DIR` set), 更改存储位置… is structurally refused (system.js:216 D1 #1 guard — protects the real install) with toast `迁移失败：relocation is disabled in isolated/test instances` (live-verified, `21-data-location-dialog.png`). Guard is correct; the copy is env-specific dev English. No change required for real users.

Data-location promises verified clean: current-dir display + boot-redirect suffix (`dataLocationRedirected`) present; migration modal is unclosable by design with phase copy 拷贝/校验/切换启动位置; the old "export xlsx → import back" promise was already corrected (B2 comment, `exportXlsxTip` promises viewing/archive only).

---

## Verified-clean coverage (no findings — walked and proven)

Settings persistence pattern (flip → config.json → `location.reload()` → UI sticks), all live-verified:
- closeActionMinimize: ON default; flip→`closeActionMinimize:false`→reload→UI OFF; hint text accurate (`开启：点 × 最小化到托盘（提醒照常）；关闭：点 × 直接退出应用`); flip back → config true. (`cam.*` steps, shots 03/05)
- `hideMainWindowOnStartup`, `enableHardwareAcceleration`, `isCompleteWithSubtasks`, `weatherEnabled` (source+city cascader reveal ✓), `developerMode` (4 experimental switches reveal ✓), `taskFlyAnimation`, `isCompleteCheckboxColorFollow`, `isShowSubTask`, `isShowCalendarPrivacyMode`, `enableTomatoFloating`, `isCalendarDimUncompleted`, `runWhenComputerStart` (ON→config true→OFF→config false, no OS residue), `calendarFontSize` (large), `weekStartDay` (sun), `dailyTomatoTarget` (10), `appLocale` (zh→en: LS + config + `html[lang]=en`, restore ok). Every value matched config.json after reload.
- 8 tabs walked with full DOM dumps (账户/基础/新手引导/默认行为/任务列表/侧边栏天气/安全与隐私/开发者模式/列表显示/日历显示/快捷键/番茄钟/自动备份/数据存储/数据管理/危险区/反馈与关于) — `j2-result.json` tabDumps.
- Sweep part 2 (J7/J7b/J7c): radios 通知停留时长→30秒 (`notificationTimeoutInterval:30000`), 重复任务组上限→5, 颜色模式→深色 (`colorMode:'dark'`, `html[data-theme=dark]`), 备份间隔→10分钟 (`autoBackupIntervalMin:10`), 回收站自动彻底删除→7天 (`recycleBinAutoDeleteDays:7`); number inputs 专注30/休息10/负载20 (`tomatoTime/restTime/dailyLoadWarnThreshold`); selects 新任务默认添加到→底部 (`bottom`), 新建任务默认分类→工作 (`100001`), 主视图排序→按预计工作量 (`difficulty`), 过期已完成→30天 (`30d`), 过期未完成 (`90d`), 未来待办范围, 完成提示音 (`confirm4`), 近期保留份数; username rename 旅程审计员 (store + sidebar + toast, survives reload); **shortcuts capture flow end-to-end**: capture button → armed → synthesized ctrl+alt+h captured → 保存快捷键 → toast 快捷键已保存 → `shortcutKeySettings.toggleMainWindow:'ctrl+alt+h'` in config → label stuck after reload. All of the above persist → reload → stick.
- Not live-flipped: 描述显示行数 slider (synthetic EP slider drag did not commit; the @change→set() path is the same verified wiring as every other control) and the 天气城市 cascader (display verified only; 3-level cascader drive skipped as low-value). The 自动下载更新 switch is `v-if="updActive"` and correctly absent in dev/isolated instances (no updater), so it was not reachable — by design, not a gap.
- Account area: sync icon → spinning + success notification `同步完成 / 已写入本地数据库，并更新安全备份` (fast-poll captured, `19-sync-retest.png`) — not a no-op; trash → `#/todo-list/recycle-bin` ✓; gear → settings ✓; 离线用户 row is a plain `<span>` with no click handler (no promise broken).
- Security lock circuit: enable guard, 立即锁定, wrong-pw rejection (`密码错误`), right-pw unlock, disable, password persistence (`enc1:`) — J3 + J6.
- Reminder circuit: UI-set reminder fires on time (J5b above).

## [J6] P2 (FIXED `8caae2e6` — live verify rides train #6) — two quick tomato-duration writes: the first write silently bounces back on every surface, config.json included

Evidence (my J10 repro, DB forensics; corroborates pomodoro journeyB5/B6): settings page, 专注时长 5 then 10 written ~2.3s apart. t+2.8–3.8s all surfaces = 10 ✓; **t+4.35s store/LS/UI/config.json ALL revert to 5**, and the DB blob reads `{tomatoTime:5, _savedAt:t+2.0}` — the pre-second-write snapshot, landing late; t+4.9s the second blob lands and 10 re-applies. The user sees their change flap back to the old value and (per pomodoro B6's later reads) the flap can settle on the stale value.

Root cause: the renderer's own debounced db.settingsState mirror (persist 2s + dbMirror 2s ≈ DB write 4s after the change) lands in the SAME DB channel the external-db-watch settings branch hot-applies for CLI coexistence. A stale mirror generation landing after a newer state has `_savedAt >` the watcher watermark, so the watcher treats OUR OWN mirror as a fresh external change, diffs it against its previous snapshot, and broadcasts `{tomatoTime:5}` back — the renderer hot-applies it (updateExternal → update action → config IPC), reverting everything. Not LS ping-pong: it is mirror-generation reordering consumed as an external write.

Fix (`8caae2e6`, D1 preserved): dbMirror records the newest `_savedAt` this window queued per key (`isOwnMirrorStamp`); the watcher sends the origin stamp as a 2nd arg on `external-settings-changed`; preload/main.js thread it into `settings/updateExternal`, which skips patches covered by our own watermark. Foreign stamps (CLI/LAN peer) are newer and still apply; no-origin callers (LAN-sync rows, DB restore) and aux windows (never mirror) are untouched. Tests: `tests/unit/store/j-audit-echo-suppression.test.mjs` + 146 green across watcher/dualwrite-shape/settings suites.

**Pre-existing gate red (not mine):** `cli/check-dualwrite.cjs` fails on HEAD for `TomatoFloatPage.vue::tomatoFloatVisPing:300` — LS write point landed unregistered with pomodoro's `0a7a0766`; needs the tomato owner's ledger registration.

**Self-audit: <5s flip pairs in my earlier stick-verifications (suspects until re-verified on the fixed build):**
- J7: 开机自启动 ON→OFF ~1.1s apart (same key twice) — post-reload read showed false, but the read happened well after the 4.3s bounce window, so a transient bounce-and-restore (or a settle-on-stale) would have been invisible. SUSPECT.
- J7c: 专注时长 30 → 休息时长 10 → 负载 20, three different keys ~0.5–1s apart — different keys means blob#2's diff could have carried a stale tomatoTime back; final reload read was ≥5s later. SUSPECT.
- All other flips were ≥5s apart or single-write-per-key and are NOT suspects.
Re-verification of both suspect sequences queued on train #6.

## Test-infrastructure notes
- **`document.visibilityState` does NOT track Electron `BrowserWindow.hide()` in this Electron/CDP setup** — control test J3c: even the e2e-proven close-to-tray hide keeps the page reporting `visible` (8/8 samples). Any hide-oracle in journeys/e2e must read window state (`win.isVisible()` main-side), never page visibility. (J3's "main window stayed visible while locked" was this artifact; the lock's hide uses the same `win.hide()` as the e2e-locked close-to-tray path.)
- El-tabs child panels (shortcuts/sync/data) mount lazily (v-if) — DOM dumps must visit the tab first; the dump helper's fallback text match can grab a sibling panel (拼装错误 in J4's sync dump, corrected by reading tab dumps per-tab in J2).
- The `firedReminders:` meta watermark is debounced 60s and quit-flushed; a hard `taskkill /F` journey teardown loses it — use stdout fire lines for fire assertions.
- Hard-kill electron leaves the native directory-picker dialog to die with the process — J4 clicked 更改存储位置… in the guarded isolated env only (no picker opened).

## Method notes
- One isolated instance at a time (ports: 9383 exclusive), `end()` in every finally. J5/J5b booted their own electron with the driver's env pattern (journey-driver.mjs untouched) to capture stdout.
- Every finding above is live-triggered (screenshot + eval data); code reading supplied root cause only. Code-verified-only items are marked inline (J5 real-user toast path, tray balloon existence).
