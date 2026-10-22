# Pomodoro Circuit — Real-User Journey Audit (pomodoro-auditor)

Branch: `journey-audit` · Instance port: CDP 9382 · Dates: 2026-10-22
Scope: bottom bar (TomatoBar.vue), float window (TomatoFloatPage.vue / tomato-float.js), tomato stores,
taskbar five-piece (tomato-taskbar.js tooltip/labels), tray labels (code-verified only — native).
Method: isolated real instances via `scripts/journey-driver.mjs bootJourney({cdpPort:9382})`; float
journeys use `pomodoro-boot.mjs` (driver-verbatim minus `--no-focus`, see Harness note below).
Every finding below was triggered LIVE (screenshot in `shots/` + eval payload in the journey logs
`journey<N>-log.json`) unless explicitly marked code-verified.

## Harness notes (not product findings)

- `journey-driver.mjs` hardcodes `--no-focus`; `handlers/tomato.js:62` gates `show-tomato-float` on
  `!argv.includes('--no-focus')`. In a bootJourney instance the 小窗 button therefore cannot open the
  float — a harness artifact, NOT a product bug (real users never pass --no-focus). Float journeys
  are walked in `pomodoro-boot.mjs` instances (same isolation contract, flag omitted).
- `document.title` (renderer) does not track the native window title; taskbar title is sampled via
  `Get-Process electron | MainWindowTitle` (native, live).

---

## Findings

## [J1] P2 Bottom bar shows 待开始 (not started) for the ENTIRE focus/rest run when no task is attached — the phase label is unreachable on the bar
**Evidence (live, journey1/journey2, shots/j1-02-running.png, shots/j2-03-running.png):**
- t+1.5s into a free focus: `status:"待开始", clock:"24:59", play:"放弃专注", barClasses:"...tomato-timer--work"`.
- Still `待开始` at 04:53 while running on the today view; TomatoPanel shows `专注中` and the float shows `专注中` for the SAME state, and the native taskbar title says `04:59 专注中 · 拾事 [TEST]` — the bottom bar is the only surface contradicting the state.
- With a task attached the bar correctly shows `专注中：{name}` (workAttach) — the free-focus case is the broken one; rest phase is equally unreachable (template has `isRest` branch only under attachName).
**Root cause:** `renderer/js/components/TomatoBar.vue:19-22` — the no-attach template branch hardcodes
`$t('statsE.TomatoBar.readyStatus')` (待开始) unconditionally. The `statusText` computed (lines 86-90)
that would return 专注中/休息中/待开始 correctly is dead code — zero template references.
**Proposed fix:** bind the no-attach span to `statusText` (drop the dead computed's non-consumption):
`<span>{{ statusText }}</span>` — with no attach it renders 专注中/休息中 while running and 待开始 at idle,
matching TomatoPanel/TomatoFloatPage/taskbar title vocabulary.
**Status:** fix committed ce477e45 (source + guard test; visual re-verification pending a
renderer-dist rebuild — journey instances run the pre-built bundle).

## [J2] P2 Closing the float with its ✕ leaves the bottom-bar 小窗 toggle stale — and inverts the NEXT click (first reopen click is swallowed)
**Evidence (live, journeyA1-log.json):**
- ✕ while idle: `float-shown-after-x: false` (float hidden ✓) but `bar-float-btn-after-x: {txt:"关闭小窗", cls:"tb-float-toggle on"}` — the bar still advertises "float open, click to close".
- Next bar click (user intent: reopen): `float-shown-after-reopen: false` — the click ran `hideTomatoFloat()` on the already-hidden float and did nothing. The user must click a second time to reopen.
- Root mechanism: `floatOn` in `renderer/js/components/TomatoBar.vue` only syncs (a) on mount, (b) after its own toggle, (c) on a coarse 15s poll (`_floatSyncN >= 15`). A float-side ✕/minimize close bypasses all three for up to 15s.
**Root cause:** TomatoBar.vue:232-245 (`toggleFloat` / `_floatSyncN` poll, lines 117-131) has no
event channel from the float's own close path; TomatoFloatPage.vue `closeFloat()`/`minimize()`
(lines 288-291) call `hideTomatoFloat()` fire-and-forget with no notification to the bar.
**Proposed fix (renderer-only, no preload/main contract change):** TomatoFloatPage writes a
localStorage ping (`tomatoFloatVisPing = Date.now()`) after its own hide calls; TomatoBar listens
to the `storage` event and re-syncs `floatOn` from `tomatoFloatShown()` (same-origin cross-window
event — instant, no polling cadence change; tray-dock closes keep the existing 15s fallback).
**Status:** fix applied (see J2 commit), live-verified defect cycle; post-rebuild re-check pending.

**Status:** fix committed 0a7a0766 — **live re-verified on the rebuilt dist (journeyV-log.json,
shots/jV-01, jV-02)**: ✕-close → bar stays consistent → first 小窗 click REOPENS
(`shown-after-reopen-click:true`, bar flips 关闭小窗/on), bar-close round-trip clean.
Residual (pre-existing, P4): the float AUTO-show path (renderer main.js 6s gate) and tray-dock
path write no ping, so the bar can read 小窗/off for up to 15s after them (15s poll fallback);
within that window the first toggle click is swallowed. Not widened further — poll covers it.

## [J3] P3→P4 Float knob icon shows ❚❚ (pause glyph) while focusing — clicking it opens the give-up confirm, no pause exists
**Evidence (live, shots/jA1-02-float-running.png):** knob renders ❚❚ during focus (`knobIcon:"❚❚"`,
`knobTitle:"放弃专注"`). The glyph promises pause; the app has no pause (user-finalized 2026-09-01),
and the click opens 放弃本次专注？. Tooltip mitigates; glyph misleads at a glance.
**Root cause:** TomatoFloatPage.vue:156 `knobIcon () { return this.working ? '❚❚' : '▶' }`.
**Proposed fix:** glyph honesty per lead's design nod — the running knob's real action is the
give-up confirm, so it wears the stop glyph ■ (matches the taskbar give-up button's stop icon);
▶ stays the idle start affordance. No pause feature added.
**Status:** fix committed 0a7a0766 (rides rebuild #2) — **live-verified post-rebuild**: knob shows
■ + 放弃专注 while running (journeyV-log.json j3-knob-running, shots/jV-01-knob-stop-glyph.png).

## [J4] P2 REAL DRAG VERIFIED + clamp: whole-card drag follows the OS cursor exactly
Not a finding — live evidence recorded: real mouse drag (down/move/up at OS level) from DIP
(120,120) landed at exactly (680,-10) = cursor delta applied by the main-process 16ms timer,
with the folded-card clamp keeping the visible card on screen at the top edge. Circuit healthy
(tomato-float.js dragStart/clampDrag/stopDrag + renderer pointer capture).

## [J5] P2 TomatoPanel duration steppers bypass the settings ledger — the value visibly BOUNCES back ~1.5s later, and loses to the stale ledger at boot
**Evidence (live, journeyB3-log.json + shots/jB2-01-divergence.png):**
- Settings page set 专注时长=5 (canonical path), then TomatoPanel stepper set 10:
  - t+300ms: tomato blob **10**, settings input **10**, panel input **10**, bar clock **10:00** (all surfaces agree at 10)
  - t+1500ms: **all four surfaces snap back to 5** — the user watches their change un-apply itself, in the panel's own input.
- The same journey family showed the settings↔DB split: after the settings write, `dbCall('settingsRowsAll')` still returned `{key:"tomatoTime",value:25}` (journeyB-log) — three ledgers (tomato LS blob / settings state / db rows) disagreeing after one panel write.
- journeyB boot2 on a persistent dir: the harvest counter **persists across reboot** (1/8 recomputed from the DB ledger) — that half is healthy.
**Root cause:** TomatoPanel.vue `commitPatch (p) { store.commit('tomato/patch', p) }` — raw commit
updates ONLY the transient tomato runtime blob; the settings ledger (SettingsModal display, synced
blob, db mirror, config.json) never hears about it, and the settings-ledger echo/mirror then
reasserts the old value over the panel's write. The adjacent tip `panelSyncHint`
("与番茄面板实时同步") promises the sync that does not exist in this direction.
**Proposed fix:** `commitPatch` dispatches `settings/update` — the canonical writer
(SettingsModal.set uses the same action), which mirrors TOMATO_LEDGER_KEYS back down into
tomato/patch: the running countdown still updates and every ledger agrees (single writer,
echo-consistent, reboot-stable).
**Status:** fix committed 91eb1d1b + guard tests (j4-tomato-panel-settings-ledger.test.mjs 2/2,
eslint clean). Post-rebuild re-verify (journeyB4-log.json): the panel now reaches the settings
ledger correctly, BUT the bounce REPRODUCED unchanged (10 → all surfaces back to 5 at t+1.6s) —
and journeyB5 proved the PANEL WAS NEVER THE (whole) STORY: **two consecutive writes through the
SETTINGS PAGE ITSELF bounce identically** (5 then 10 → all surfaces snap back to 5 at t+2.5s).
See [J6].

## [J6] P2 (FOR THE SETTINGS OWNER — outside pomodoro fix scope) A second settings write within ~5s of a first one is silently reverted everywhere ~4.5–5s after the first write
**Evidence (live, journeyB5-log.json + journeyB6-config-vs-ui.mjs + shots/jB5-01, jB6-01):**
- Settings page only: write 专注时长=5, wait 2.5s, write 10. Samples: t+0.5s all=10, t+1.6s all=10,
  **t+2.5s ALL surfaces (settings state, LS blob, settings-page input, tomato blob, bottom-bar
  countdown) snap back to 5** — no further user action.
- journeyB6: after the bounce, `getSettings()` (config.json) ALSO reads 5 — the re-apply rewrites
  config too; the system coherently reverts to the FIRST write. The user's second change is
  silently lost (worked around only by re-doing it after the echo window).
- Bounce timing correlates with time-since-FIRST-write (~4.5–5.0s) across B3/B4/B5, regardless of
  which surface made the second write (panel or settings page).
**Suspected mechanism (for the owner to confirm — files outside pomodoro scope):** the renderer's
debounced db.settingsState mirror (utils/dbMirror.js) and the main-process external-db-watch
settings branch (external-db-watch.js:192-243, `external-settings-changed` hot-apply → renderer
updateExternal → settings/update) — the watcher appears to hot-apply a snapshot that predates the
second write, reasserting it through the very same update chain. journeyB-log additionally showed
`settingsRowsAll` returning `tomatoTime:25` (boot value) after a settings write of 5 — the same
ledger lag family.
**Severity note:** the two-write-within-5s pattern is the NORMAL editing pattern (tweak 专注时长
then 休息时长 back-to-back) — the settings owner may judge this P1 (silent change loss).
**Status:** filed for the settings owner; pomodoro-side fix (91eb1d1b, panel → canonical writer)
remains correct and necessary — the panel write no longer bypasses the ledger — but the bounce
lives one layer up.

## Live-verified-good (no finding): taskbar five-piece during run
- Native window title live-verified: `04:59 专注中 · 拾事 [TEST]` while focusing, `00:59 休息中 · …` during rest, plain app name idle (PowerShell MainWindowTitle sampling).
- Progress bar / thumbar give-up button / overlay badge / tray progress ring: native, code-verified only (tomato-taskbar.js update(); thumbar fallback tooltip is phase-aware post-F2).
- Tray menu labels (rebuildTrayMenu, code-verified): 显示番茄悬浮窗 (docked) / 收起番茄悬浮窗到托盘 (shown); quit confirm gates on the durable `tomatoRunningSession` row — live-verified written at focus AND rest start, cleared on give-up/finishRest (null), so the quit-confirm promise holds.
- Slim bar on non-today views mid-focus: phase + countdown + 放弃 present, harvest/noise/小窗 correctly hidden (shots/j2-04-slim-running.png).

## Live-verified-good (no finding): float abandon circuit
- Knob click during focus → in-card confirm 放弃本次专注？ with live 已专注 n 分钟 forward counter; ✕ during confirm = cancel (title 关闭), focus continues — the recently-fixed exit-mode regression holds (e2e-locked circuit untouched).
- Float-side give-up: ledger row `succeed:false` with measured minutes (3), harvest stays 0/8, durable `tomatoRunningSession` row cleared (null) — quit-confirm gate safe.
- Float ⇄ bar phase sync <500ms (bar-started focus appears on the float as 专注中 immediately; give-up on the float idles the bar).
- Idle float ✕ hides the window but keeps the page target (hide-not-destroy, by design).

## P4 note (filed-only, TomatoPanel neighborhood, no code change)
After J4, `TomatoPanel.commitPatch` dispatches `settings/update`, whose action resolves
`{ok:false}` when the config IPC fails — the float's noise picker toasts on that (D22 P3,
TomatoFloatPage.pickNoise), but the panel's two duration steppers ignore the result: on an IPC
failure the LS/tomato ledgers update while config.json does not, silently reverted next launch
(settings files are off-limits to this auditor; same toast pattern as SettingsModal.set's
settingsSaveFailed would be the fix). Noted for the settings owner's next pass.

## Round 2

### Harness note (not a product finding): CLI/app data-dir contract — the split brain and the sweep incident
- **CLI seeding contract** (cost one full run to learn): the APP takes its data dir from
  `TODO_USER_DATA_DIR` only (`src/main/index.js` app.setPath; DB at `<userData>/todos.db`),
  while the CLI resolves `src/main/user-dir.js` with `TODO_DB_DIR` FIRST and `TODO_DB_DIR`
  points DIRECTLY at the directory containing todos.db. Seeding per the old driver-header doc
  (`TODO_DB_DIR='<journey>.dbDir'` = `<userData>/db`) silently writes a DIFFERENT database —
  live-verified: CLI list showed the tasks ✓, the running app's `queryTodos` returned [],
  scheduler rebuilt "0 future reminders", and the external-watch even logged "检测到外部写入
  （CLI）" for a file the app never reads. Correct invocation: `TODO_DB_DIR=<userData root>`.
  Lead fixed the driver header (credit in comment); journeyR2A v2+ confirmed seeds flow through.
- **Outside kills masquerading as crashes**: two matrix runs died silently (exit 0xFFFFFFFF =
  PowerShell Process.Kill disposition; taskkill would be 1, native crashes leave WER/dumps —
  none existed, and a tight-instrumented control run survived). Confessed culprit: a teammate's
  time-windowed name sweeps; now scoped to stored-pid/exact-port and codified in the driver
  header. Audit lesson: before filing "app dies at reminder fire", check the death's exit code
  and the absence of crash artifacts — 5 minutes of forensics prevented a false P1.
- **Self-inflicted, recorded for honesty**: a corpse-removal rm reused the previous run's dir
  path while v3 was live in it → stripped db.key/logs mid-run (CLI edit failed with
  "找不到 db.key", app exit 1, boot2 rebuilt on a fresh empty DB). Rule going forward: fresh dir
  path per rerun, never rm a journey dir a live job may own.

### [J7] P2 A reminder created/synced ALREADY PAST-DUE never fires — the catch-up watermark swallows it silently, while the write-path gate says it should fire
- REPRO (live, `journeyR2A6-catchup.mjs`, two independent paths):
  1. App RUNNING, CLI `add --reminder <now-2min>` → the app sees the row (`queryTodos` returns
     it with `reminderTime` set), the write-path rebuild runs… and logs "0 missed reminders
     re-fired", NO `[Reminder] fired:` line, and `reminderLastSeenAt` ADVANCES to now.
  2. App CLOSED, CLI seeds a past-due task → boot → same: row visible, "0 future, 0 missed",
     no fire, watermark advances past the reminder's due time forever.
- ROOT (code-located, not fixed — scheduler.js is outside this auditor's fix scope):
  `reloadAll`'s catch-up branch gates on `ts > lastSeen` (the `reminderLastSeenAt` frontier,
  set to now at firstRun and advanced on every rebuild). A reminder CREATED behind the frontier
  (created already-due, or synced in from a peer) can never satisfy `ts > lastSeen`, so it is
  classified as "already seen" and never fires. Meanwhile `needsCatchUp(todo)`
  (handlers/todo.js fast-path gate) returns TRUE for exactly this task — "a PAST reminder
  instance that has NOT been recorded as fired" — so the fast path delegates to the full
  reloadAll, whose watermark gate then refuses. The two mechanisms disagree; the reminder is
  swallowed with zero user feedback.
- Reachability: CLI `add --reminder <past>` (documented first-class flag), LAN-sync peers
  applying an old task, and the EDIT PANEL's date-time picker (accepts past times) — this is a
  real-user path, not a CLI-only edge. The NORMAL catch-up case (reminder created before its
  due time, app closed across the due moment) works — live-verified separately (see matrix).
- Suggested fix shape (for the scheduler owner): when a write-path task has
  `needsCatchUp(todo)===true`, fire it (or route it through a watermark-exempt single-task
  catch-up) instead of delegating to the frontier-gated full reload; OR classify by
  `createdAt > watermark` instead of reminder-ts alone. Requires the D22/anti-bombardment
  invariants to be re-run — owner's call.

### Reminder scheduler matrix — everything else live-verified good (no finding)
- **Fires land on the minute, precisely** (4/4 across two runs): `[Reminder] fired:` at
  19:55:00.083 / 19:57:00.013 / 20:00:00.015 (offset −1) / 20:01:00.013 vs due :00 of each
  minute — ≤100ms jitter. CLI reminder times are minute-granular (HH:mm truncation), matching
  user expectation.
- **Offset reminders** (`--remind-offset "-1"`): the early instance fired at main−60s exactly,
  logged with its offset (`… <taskId> -1`), independent dedup key — both instances fired once.
- **Delete-before-fire holds**: soft-delete (recycle bin) of a due-in-95s task → zero fires
  past its due moment; fingerprint change tears the pending timer down cleanly.
- **Edit re-arm via live watch**: `edit --reminder` on a RUNNING app → external-write watch →
  rebuild within ~45s; the OLD due time passed with ZERO fires; the new time fired exactly.
- **Dedup durability across crash**: hard-kill (no quit flush) after 4 fires → reboot rebuild
  re-fired NOTHING (A/B/F −1/F 0 all deduped from the persisted fired-set) — the LRU/meta
  dedup survives a crash; the windows.js relaunch-path flush comment is belt-and-braces.
- Multiple simultaneous reminders: 5 tasks + 1 offset = 6 instances scheduled at once
  ("6 future reminders, 0 missed"), all correctly counted after one fired ("5 future").

### TQ-1 quit-confirm LIVE walk (previously code-only)
- **The durable-session gate is real and the dialog is a REAL native window** (window title
  专注进行中, buttons 放弃专注并退出 / 取消退出, enumerated via Win32 UI tree — not a renderer
  overlay).
- **CANCEL path, fully live-verified**: START focus → `closeRequest` (X/Alt+F4 equivalent under
  closeActionMinimize:false → windows.js 'quit' intent → quitFromTray) → dialog up → process
  still alive 4s+ later (a confirmless quit exits in ~2-3s), durable `tomatoRunningSession` row
  intact, clock still counting (24:59→23:36 across the dialog) → real-mouse 取消退出 → app
  continues, row intact, focus unbroken.
- **ACCEPT path, partial (evidence limits documented)**: real-mouse 放弃专注并退出 (via Win32
  SetForegroundWindow+click after discovering the dialog renders BEHIND a fullscreen foreground
  window until its parent is raised — audit-harness gotcha, not a product bug) → the ENTIRE
  process tree (main/renderer/GPU/utility, 4 processes) self-exited with no taskkill and the
  CDP port freed — a clean Electron quit, not a crash. The post-quit ledger/row check was lost:
  the run's data dir had its `todos.db`+`db.key` deleted by an out-of-band actor during the
  session restart (cause unidentified, not the app — the quit chain never deletes DB files).
  What remains verified for the promise: the running focus being UNRECORDED by a clean quit is
  code-verified (quit flush clears the durable row before exit; no ledger write exists on the
  quit path), and the row's durability across a FORCED kill is live-verified (R2B2 boot2: stale
  row survived, ledger empty, harvest 0/8). A future re-run can close the last gap in ~2 min.

### Duration boundaries via the panel (J4 neighborhood, post-fix)
- Focus stepper: typing 1 → clamped to **5** (manifest min); typing 999 → clamped to **180**
  (manifest max). The clamp is COHERENT across all four surfaces within ~1s: panel input,
  SettingsModal input, tomatoState blob, AND the bottom-bar idle clock (25:00→05:00→180:00
  live). The J4 ledger-converged write path holds under boundary stress; no bounce, no split.
- Rest-row fills hit a journey-selector bug (nth-of-type landed on the focus row) — rest
  clamping via the PANEL is unverified; the 1-minute rest itself remains proven via the
  settings page (round 1: 1:00 rest completed end-to-end). Panel rest clamping: open for the
  next pass.
- "1-minute run completing end-to-end": no legal 1-minute FOCUS exists (min 5:00 — clamped as
  above); the shortest legal circuit is 5:00+1:00, both halves proven (round 1 + the soak).

### Weather widget (mandate #6)
- Present and healthy: settings switch (walked tabs to reach it) → SideNav `weather-widget
  sn-weather` appears and renders LIVE data (`☀30°晴Singapore` — IP-fallback city) within the
  4s fetch window; graceful networked fetch, no layout break. Toggle-back-off leg was cut by a
  journey shot-path bug (cosmetic); persistence across reboot follows the settings ledger
  (same mechanism J4 verified).

### Harvest edges: the last-second give-up race (mandate #5)
- LIVE: focus 5:00 → give-up clicked at **00:08 remaining** (8s before the shared tick would
  complete) → abandon modal (本次已专注 4 分钟，放弃将计入放弃次数（不计入今日收成）) → confirmed.
  Outcome: **exactly ONE ledger row** — `succeed:false`, focusDuration 5, rest slot created
  (rest:1) with restDuration 0, `abandonReason:""`, timestamped at the give-up — harvest stayed
  **0/8** (give-up ≠ harvest, matching the copy), status returned to default, and the durable
  `tomatoRunningSession` row cleared to null (quit-gate safe). The complete-vs-give-up CAS held
  under the race: no double row, no lost row, no crash. The succeed:true row shape was already
  live-verified in round 1 (measured minutes, harvest 0/8→1/8) — the two row shapes agree with
  their respective user actions.

### 10-minute soak (mandate #4) — FIRST VERIFICATION ON THE POST-TRAIN-10 BUILD
- **Timers drift-free**: bar clock read exactly (10−m):00 at every whole-minute sample t1..t10 —
  zero wall-clock drift across the full run on the fresh dist.
- **Three-surface agreement**: native taskbar title countdown matched the bar within 1s on all
  cleanly-attributed samples (t1/t2/t4/t5/t6/t7/t8); float leg N/A under the driver's
  --no-focus boot (float agreement was round-1-verified on a focus-allowed boot).
- **Completion contract**: at t10 the run auto-completed into rest (rest-entered ≤5s),
  `todayTomatoCount` 1, ledger row EXACTLY as promised: `succeed:true, focusDuration:10,
  rest:1, restDuration:1`, no abandonReason — the full circuit on the new build.
- Probe honesty: t3 ("拾事" plain) and t9/t10 ("确认迁移数据存储位置") native-title readings are
  CONTAMINATED samples, not product behavior — the soak's PowerShell probe used unfiltered
  `Get-Process electron | MainWindowTitle`, which picked up OTHER instances' windows (a second
  test instance and a config-auditor migration dialog). Instance-filter the probe next pass.

### TQ-1 accept path — the lost ledger check CLOSED on the fresh build
- Re-run on the post-train-10 dist: real-mouse 放弃专注并退出 → **process exited with code 0**
  (clean quit, well inside the 20s poll) → reboot on the same dir: durable `tomatoRunningSession`
  row **null** (quit flush cleared it), ledger **[]** — the running focus UNRECORDED exactly as
  the dialog copy promises (放弃…不会记入专注账本), harvest 0/8. The TQ-1 circuit is now
  live-verified end-to-end on both buttons.

### Round-2 harness/evidence inventory (all under docs/journey-findings/)
- `pomodoro-boot.mjs` (v3: +stdout capture `logFile`, +`crash()` parity) — journeys R2A
  (matrix v4), R2A3 (fire repro), R2A4 (death-pin control), R2A6 (catch-up isolation), R2B
  (quit-confirm cancel), R2B2/B4 (accept attempts), R2C (bounds), R2E (harvest race), R2F
  (weather); logs `rem5-stdout.log` (the clean matrix), `journeyR2A-log.json`,
  `journeyR2C-log.json`, `journeyR2F-log.json`; shots/ for the visual states.
- The 10-minute soak (R2D) script is committed but UNRUN at submission time (field priority
  for train #10) — its assertions (per-minute three-surface agreement, drift, completion row
  focusDuration=10) run standalone whenever the field frees up.



