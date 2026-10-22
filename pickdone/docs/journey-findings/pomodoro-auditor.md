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

