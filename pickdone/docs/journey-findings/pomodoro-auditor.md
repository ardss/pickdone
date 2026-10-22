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

**Status:** fix committed 0a7a0766 — full defect cycle live-verified pre-fix (journeyA1b-log.json:
`bar-btn-after-x-t1s {关闭小窗,on:true}` → `shown-after-click1:false` (swallowed) → `shown-after-click2:true`);
post-rebuild re-check pending (rides rebuild #2).

## [J3] P3→P4 Float knob icon shows ❚❚ (pause glyph) while focusing — clicking it opens the give-up confirm, no pause exists
**Evidence (live, shots/jA1-02-float-running.png):** knob renders ❚❚ during focus (`knobIcon:"❚❚"`,
`knobTitle:"放弃专注"`). The glyph promises pause; the app has no pause (user-finalized 2026-09-01),
and the click opens 放弃本次专注？. Tooltip mitigates; glyph misleads at a glance.
**Root cause:** TomatoFloatPage.vue:156 `knobIcon () { return this.working ? '❚❚' : '▶' }`.
**Proposed fix:** glyph honesty per lead's design nod — the running knob's real action is the
give-up confirm, so it wears the stop glyph ■ (matches the taskbar give-up button's stop icon);
▶ stays the idle start affordance. No pause feature added.
**Status:** fix committed 0a7a0766 (rides rebuild #2).

## [J4] P2 REAL DRAG VERIFIED + clamp: whole-card drag follows the OS cursor exactly
Not a finding — live evidence recorded: real mouse drag (down/move/up at OS level) from DIP
(120,120) landed at exactly (680,-10) = cursor delta applied by the main-process 16ms timer,
with the folded-card clamp keeping the visible card on screen at the top edge. Circuit healthy
(tomato-float.js dragStart/clampDrag/stopDrag + renderer pointer capture).

## Live-verified-good (no finding): float abandon circuit
- Knob click during focus → in-card confirm 放弃本次专注？ with live 已专注 n 分钟 forward counter; ✕ during confirm = cancel (title 关闭), focus continues — the recently-fixed exit-mode regression holds (e2e-locked circuit untouched).
- Float-side give-up: ledger row `succeed:false` with measured minutes (3), harvest stays 0/8, durable `tomatoRunningSession` row cleared (null) — quit-confirm gate safe.
- Float ⇄ bar phase sync <500ms (bar-started focus appears on the float as 专注中 immediately; give-up on the float idles the bar).
- Idle float ✕ hides the window but keeps the page target (hide-not-destroy, by design).

