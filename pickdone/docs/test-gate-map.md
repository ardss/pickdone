# Test Gate Map — stage inventory, dependencies, budgets, load classes

Status: LIVE MAP (v1, 2026-10-23). Purpose: end the diagnose-by-archaeology
pattern — when a stage reds, read THIS first. Every incident appends to the
stage's history instead of becoming folklore.

Related: perf-debt-ledger.md (debt history, D1-D9),
test-runner-modernization-design.md (D1 pilot + runner economics),
AGENTS.md (iron laws).

## 1. Stage inventory (check:all = 31 stages, three concurrent pools)

### ① Static pool (load-immune, pure compute)

22 gates: vite build / fingerprint / licenses / tokens / file-size /
boot-order / css-freeze / cache-stamp / commit-identity / op-feedback /
ipc-op-coverage / command-bus / sync-matrix / dualwrite / schema /
esm-graph / i18n ×2 / media-lang / hover-contrast / scheduler-lru /
eslint / vue-tsc.

- Needs: node_modules (complete), nothing else.
- Load class: IMMUNE (slow down under load, never flake).
- Budgets: 15min default stage ceiling.
- Incidents: none load-related on record.

### ② Unit tier (run-all, core tier, conc 4 default; 8 = quiet-window opt-in)

754 files / ~4774 cases. Mixed composition — see load classes below.

- Needs: node_modules; isolated temp dirs (self-managed); TEST_CONCURRENCY
  optional.
- Load classes INSIDE the tier (known members):
  - IMMUNE: pure unit specs (majority of the 754).
  - TOLERANT (retry-once absorbs): most timing asserts with margin.
  - FRAGILE (fixed budgets a burst can outrun in both passes):
    lan-sync drill convergence (mesh / scale / 4-pair),
    C14/D19 sleepBackoff real-delay assert,
    C4 transport-buffer socket timing,
    E2E F1 exit/tray closeRequest race,
    H1 capacity/timing cases,
    CSPRNG exit-134 + 0xC0000409 native startup/teardown crashes
    (random file, rerun-once doctrine).
- Budgets: per-file child ceilings, pool budget, retry-once, watchdogs per
  suite (lan-sync-journey 900s — raised from 300s same day, see ledger).
- Incidents: D6/D7/D8 (force-exit two faces, c1 spawn storm — resolved),
  evening burst 2026-10-23 (drills + J4 + C4 + F1 rotating reds, all green
  in isolation; conc-8 default reverted to 4 with evidence).

### ③ Electron live pool (5 stages; FRAGILE — boots and CDP round-trips)

- integration-ui / integration-updater-ui: own Electron boot each;
  readiness probe 60s×2 attempts; isolated userData; random CDP port.
- UI 交互池 (tests/run-interactions-shared.mjs): ONE shared instance for
  six targets (ui-smoke / e2e / keyboard-e2e / cssom / ui-coverage /
  overlay), sequential; per-target verdicts; instance respawned once.
- cli-smoke: no Electron.
- Needs: electron dist (node_modules), free random CDP ports, a shell that
  does NOT export ELECTRON_RUN_AS_NODE (stripped centrally in check-all
  since ea71d439), desktop session able to spawn windows.
- Budgets: CDP send 20s, page-reset probe 20s, boot attempts 3×15s,
  stage ceiling 20min (pool) / 30min (shared).
- Incidents: 2026-10-23 morning — all 9 lanes died to the env trap (fixed
  centrally); Runtime.enable 8s stall under burst (fixed to 20s).

### ④ Web visual lane (1 stage; ENVIRONMENT-HEAVY + FRAGILE)

- Needs (ALL gitignored, per-checkout — a fresh worktree is NOT runnable
  without setup): browser-dev/node_modules (npm i; sirv is a hard dep of
  the vite config), tests/.artifacts/visual-web/*.png baselines (25, from
  the blessed checkout), a settled browser profile (fresh profile = first-
  run wizard, whose dismissal used to re-stamp the locale over the pin —
  fixed 95505825: dismiss FIRST, pin locale LAST).
- Mechanics: self-spawned vite (90s readiness probe: 5s fetch ×3 streak;
  raised from 2s/40s — first-transform starvation under in-gate load),
  resident agent-browser daemon, 14 scenes × light/dark, pixelmatch 0.4%,
  pdFreeze clock pin, D23 viewport pin 1254×564.
- Load class: FRAGILE (probe starvation, scene settle under load) AND
  environment-sensitive (baselines are machine-state).
- Budgets: probe 90s, scene retry ×1, stage ceiling 30min.
- Incidents: 2026-10-23 — five-layer onion (missing sirv → missing
  baselines → locale re-stamp → probe starvation), each misattributed once
  before evidence; uniform ~0.6% diff at matching geometry = language or
  rasterization drift, NEVER product logic.

### ⑤ Coverage ratchet (rides the unit stage)

- full-pool calibration ONLY (node --test, --experimental-test-coverage);
  refuses to evaluate when the unit stage failed (aborted runs overstate
  coverage). Vitest coverage is compare-only (D1 pilot, acceptance 4).

## 2. Triage protocol (the checklist I should have had all along)

When a stage reds, IN ORDER — evidence before attribution:

1. READ the stage's own log/artifact (every stage now writes one; the
   vite-spawn.log pattern is the standard). No exception.
2. Check the stage's needs above (deps present? baselines present? env
   var? port free?) — 30 seconds, catches the whole checkout-env class.
3. Solo-run the failing suite/lane (gate-equivalent flags: run-all
   children carry --test-force-exit; a bare `node --test` run hangs on
   handle leaks and lies to you).
4. Green solo under burst = load class (document in this map's incident
   list; do NOT rerun the full gate as a dice roll).
5. Red solo = RED-first real regression: failing assert or hang; fix
   forward, never bundle an unexplained red into another change.
6. Attribution without artifact = forbidden (2026-10-23: "load" was my
   scapegoat twice on the same symptom before the log was read).

## 3. Budget registry (calibration conditions on record)

| Budget | Value | Calibrated against | Last change |
|---|---|---|---|
| lan-sync-journey watchdog | 900s | in-gate wall ≈ 2-3× solo under burst; covers ~3× solo worst | 2026-10-23 (300→600→900) |
| visual readiness probe | 90s / 5s fetch | in-gate first-transform starvation | 2026-10-23 (40s/2s) |
| shared-pool CDP send | 20s | burst round-trip stall past 8s | 2026-10-23 (8s) |
| shared-pool page-return probe | 20s | reload interactivity | unchanged |
| live-lane boot readiness | 60s ×2 | Electron boot under load | unchanged |
| unit per-test timeout (vitest) | 120s | node:test has none; capacity cases >5s | 2026-10-23 (pilot) |
| stage ceilings | 15-30min | named red instead of silent kill | unchanged |
| retry-once | 1 | absorbs ≤1 rotating victim per pool per pass | unchanged |

Rule: any budget change cites its measured worst path here. A budget that
"passed once" is not calibrated.

## 4. Load-tier policy (proposal, needs one quiet-window cycle to prove)

The gate's ambient-load label (S4) samples CPU at start. Extend it to
SELECT, not just warn:

- load < 50%: run everything (today's form).
- load ≥ 50% (burst): run ① + ② IMMUNE/TOLERANT + ③; DEFER the FRAGILE
  set (named loudly, never silently) to the nightly quiet-window job —
  which already exists as a scheduled run. Development never blocks on
  dice; validation truth never depends on load luck.

## 5. Open debts that gate development velocity (ranked)

1. Full-gate wall under load (D9 tail): visual stage is the last big
   serial chunk; 31/31 stamp pending a quiet-window single run.
2. D1 decision: vitest proven compatible but per-directory economics are
   NEGATIVE (fixed worker boot dominates small slices) — pool-scale
   cutover or shelve. Decision blocked on one quiet-window pool-scale
   measurement.
3. D2 import-graph scope precision: planned AFTER D1 by design.
4. Per-child spawn timeouts mechanical pass (~15 cli suites, execFileSync
   without timeout = permanent-block hazards).
