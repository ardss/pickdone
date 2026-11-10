# LR-REPORT — Dev-3 (DESIGN line), S3 batch 1 — 2026-11-10

Branch: `lr/ux-20261110` (worktree `.wt-lr-ux-20261110`), baseline afeae379.
Scope: UX contract + desktop truth capture + shared/ui audit + matrix skeleton. No changes
to desktop feature sources, no changes to `shared/` (verified via pathspec commit below).

## Delivered

1. **Desktop truth capture (20 PNG + manifest)** — `.wt-lr-ux-20261110/ux-evidence/desktop/`
   - Isolated instance: `TODO_USER_DATA_DIR=K:/tmp/lr-ux-data` (scratch dir; real
     `%APPDATA%/pickdone` never touched), `node scripts/app-dev.mjs --remote-debugging-port=9333`.
   - Capture method: CDP `Page.captureScreenshot` against the app's own Electron (v39.8.10 /
     Chromium 142) — the historical "Chrome exit 21" external-Chrome toolchain failure did
     NOT apply; nothing BLOCKED.
   - 10 screens x light/dark at 1440x900 dpr=1: Today, TodayX, Inbox/TodoBox, Projects,
     Project detail (incl. Work-handoff section), Statistics, Completed, Settings modal,
     Settings > Sync & Devices, Empty state (Recycle Bin).
   - `manifest.json` per capture: viewport, theme, nav path, timestamp, source=real pixels.
   - Seed data created through the app's own command bus in the isolated DB (categories incl.
     demo project + one demo task) — isolated DB deleted after capture.
   - Verified visually: light and dark themes, settings modal (left tab rail) and sync tab
     all render correctly.

2. **UX contract** — `pickdone/docs/design/ux-contract-20261110.md`
   - SHA-256: `ad5ef2674b9c9e5b832116f669d23d8ef1387e39cd549ef6167abbdd72cbddfe`
   - Contains: extracted (not invented) design-token inventory from `assets/css/base.css`
     (2298 ln) + `theme-dark.css` (365 ln) incl. dark-theme fallback gaps (text-4,
     line-strong, danger/ok/warn unset in dark — flagged to fix BEFORE Wave 2 ports);
     IA mapping desktop<->mobile<->web with adaptation rules; §05 design-contract items
     current-vs-target table; normative mobile first screen with the four continuity zones
     (push-now / waiting-on-me / agent-working / blocked-conflict); empty/loading/error/
     offline specs; touch-target and WCAG 2.1 AA requirements; screenshot-matrix acceptance
     rules banning CSS-variable-equality pseudo-acceptance.

3. **shared/ui audit (read-only)** — contract §6. Key finding: `shared/ui` DOES NOT EXIST;
   `shared/` is logic-only. Desktop UI = Vue SFCs + gated global CSS (`check:tokens`,
   `check:css-freeze`, `check:i18n`). Gap table maps each Wave 2 primitive to its desktop
   counterpart. No shared/ui changes made (reserved to Dev-3, Wave 2 per §07).

4. **Matrix skeleton** — `pickdone/scripts/ux-capture/`
   - `capture-desktop.mjs`: runnable today; produced the evidence set above.
   - `matrix-skeleton.mjs`: 6-group (Today/Projects/Task-detail/Episode-Handoff/Sync-Conflict/
     Settings) x client (desktop/android/web) x viewport x theme x state plan generator with
     naming convention `{NN}-{group}--{client}--{viewport}--{theme}--{state}.png` and
     per-cell acceptance checklist stubs.

## Status

CODE_READY for: contract, desktop baseline evidence, matrix tooling.
Deferred (by design): Android/Web matrix cells, populated Episode/Handoff captures (need an
S1 journey), shared/ui extraction (Wave 2).

## Cleanup verified

- Isolated Electron processes killed (5 PIDs); `curl http://127.0.0.1:9333/json/version`
  refused afterwards; 0 electron processes remain.
- `K:/tmp/lr-ux-data` and all scratch scripts deleted. Real user data untouched.

## Next step

Wave 2: close dark-token gaps in desktop CSS first (small, gated), then freeze
`shared/ui/tokens.json` and hand matrix cells to Android (S4) / Web (S5) implementers.
