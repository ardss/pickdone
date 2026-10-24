# Test performance debt ledger (2026-10-23 night wave)

Doctrine: a debt item only leaves this ledger when its acceptance number is
MEASURED, not promised. Every item carries its current number, the plan, and
the acceptance line. (Lesson of 2026-10-22/23: an unmeasured promise — "4
minutes" — burned trust worse than the original slowness.)

## Baseline numbers (measured, this host = 12 cores, sustained ~100% ambient load)

| Pool | Before | After (2026-10-23) | When |
|---|---|---|---|
| Full pool (unit+integration+visual, conc 4) | 33-40min | unchanged (full gate only) | 2026-10-22 22:14 run: 36min |
| Core tier (727 files, conc 8) | n/a | **FALSIFIED**: 22.1min but 7 not-ok with OVERLAPPING victims across two consecutive passes (c1-parse-ux, d26 plan, purge family) — conc 8 widens the D6 lock race; default reverted to 4 | 2026-10-23 01:26 + 01:55 runs |
| Core tier (conc 4, post-D7-fix) | full pool 33-40min | **12.4min** quiet host (15% load), 23/23 gates green end-to-end, retry not engaged — the first full fast-gate green of the wave (2026-10-23 05:34 capstone run) | 2026-10-23 |
| Core tier (conc 4, loaded host ~100%) | n/a | ~25min (D5 quiet/loaded split still worth one loaded-window number) | pending |
| utils dir slice (6 files, streaming) | n/a | 19s wall, slowest test 8.6s (34.7x margin) | 2026-10-23 01:47 |
| pre-commit on scoped change (e.g. cli/*) | 15-40min (full pool) | ~1-3min expected (tests/unit/cli only), MEASURE PENDING | next natural commit |
| docs-only commit | 15-40min | seconds (loud skip) | by design |

## Debt items

### D1. Process model: one node process per test file (ARCHITECTURAL, the big one)
`node --test` spawns a fresh process per file: ~760 process boots + module
loads. In-process worker pools (vitest-class) remove most of it.
Plan: S5 design doc (docs/test-runner-modernization-design.md) — pilot
directory behind an opt-in flag first, full cutover only after the pilot
proves TAP-gate compatibility.
Acceptance: core tier ≤5min on the loaded host, ≤2min quiet, with zero gate
semantics change (fail=0 + skip ratchet + retry doctrine preserved).

### D2. Affected-scope precision: directory granularity (definite, safe)
Today a store change runs 3 whole test dirs (~200 files). An import-graph
scope would cut it further BUT must never miss fs-reading source anchors.
Plan: after D1 (a pooled runner makes per-file indexing cheaper), add a
verified import-graph layer: graph closure ∪ anchor-detection (tests that
fs-read source always run) — acceptance: scoped run ⊇ every suite that fails
when its mapped source breaks (proven by a mutation spot-check).
Acceptance: scoped pre-commit ≤60s on a quiet host with zero missed-failure
incidents over two audit waves.

### D3. Deep-tier quiet-window verification (borrowed from round-2 ledger)
The 11 deep suites have not had a quiet-window full pass since the round-2
audit. Acceptance: one full check:all green in a quiet window (also retires
the lan-sync known-debt bucket or converts it to named real reds).

### D4. Orphan process hygiene on killed gate runs (infra)
Harness job_kill does not tree-kill on Windows: the aborted runs left node
children burning CPU (confirmed 22:15 batch tonight). Plan: run-all keeps a
child-pid file (tests/.artifacts/runner-children.json) and `--cleanup` reaps
exactly those pids; hook scripts call it on trap. Acceptance: zero surviving
children 10s after a killed run.

### D7. Store-suite teardown "hang" was node:test premature force-exit (RESOLVED 2026-10-23, e36814e0)
Not a pending product promise and not a settle-contract gap: --test-force-exit
fires when root.waitingOn > root.subtests.length at ANY test's finalize
(node:internal/test_runner/test.js finalize → harness teardown →
root.postRun(cancelledByParent "Promise resolution is still pending…") →
process.exit()). f2b tripped it by registering tests AROUND a top-level
`await import('todo.js?f2b')`: 4 tests done > 4 registered while the import
was still resolving under load. Doctrine: a test file must register ALL its
tests before the first one starts — no test() above a module-level await.
Timer-based mitigations (watchdog races, keep-alive sleeps) cannot help —
process.exit() survives nothing — and were removed.
The "tombstone×3" co-symptom was a separate load flake: f4's module-load-time
future stamps (+1..5s) lost their LWW margin when db.init slowed past 1s, and
sync-apply's CORRECT local-wins LWW returned false; fixed with per-test
+60s stamps (deep inside the 10-min SKEW_CLAMP).
Acceptance met: repro context (pair + coverage + 10 CPU burners) 6/6 green
zero-cancelled (pre-fix 4/4 red on iteration 1); adjacent store+main dirs
1789/0/0; a full pre-commit core tier ran 4715 pass / 0 fail / 0 cancelled.
Residual inventory: 7 other test files register tests before a module-level
await import (c-wave-ui-20261013, component-fixes-renderer, d6-ux-fixes,
maint-0927-domainA, qc-ui-followup-store2, r-render-store-fixes,
fix-20261009-store-consistency) — same bomb shape, not yet tripped; same
one-move fix in a follow-up wave (see D8).

### D8. Premature-force-exit bomb shape in 7 more test files (RESOLVED 2026-10-23, d636d2a3 + 5e639a38)
All 7 files hoisted their module-body await imports above every test()
registration (the D7 doctrine). The investigation exposed a SECOND,
sneakier force-exit face: when the event loop drains with no unfinished
test at finalize, force-exit ends the child with EXIT 0 and every test
registered below the suspend point is silently NEVER RUN — the gate's
"6/6 green" on maint-0927-domainA was truncation false-green (file really
holds 18 tests; loaded repro pre-fix ran 54/95 across the 7 files). Post-fix
the loaded repro runs 95/95 every time.
The fix unmasked 4 PRE-EXISTING stale tests in maint-0927-domainA; triaged
(5e639a38) as product evolution, verified by git archaeology: b85b5ca8's
shake-replay markFailed path (ctx now binds the real method), the
locale-aware FMT.cnDate current-year branch in TaskAccountModal (harness
stub was missing cnDate), and dropOn's `e` param from the 2026-10-09
cross-view-drop fix (anchor regex tracked the signature). 18/18 green.
Acceptance: 7/7 files fully registered in loaded repro; maint suite 18/18;
adjacent dirs 1494 tests green after triage. Corpus capstone (2026-10-23
06:43, quiet host): fast gate 23/23 green, 11.9min, unit stage plans 4754
tests (the 41 previously-truncated ones now counted), retry not engaged.
Follow-up (small): add a golden/gate guard that fails any test file whose
test() registrations precede a module-level await import, so the bomb shape
cannot re-enter (apply the D8 doctrine check mechanically). → DONE:
tests/unit/cli/test-file-registration-order.test.mjs (corpus scan 1s, green).

### D6. c1-parse-ux 300s-ceiling burn (RESOLVED 2026-10-23, 50291813 — root cause RECLASSIFIED)
The "parent+CLI-child double-connection lock race" attribution was wrong:
c1's parent holds no db connection at all, no BUSY was reproducible (0/5
loaded iterations), and the one historical c2-integrity "database is locked"
warning has no second connection to blame (c2 spawns no children) — do not
hang it on this mechanism.
Pinned mechanism (spawn-trace preload in every node process of the loaded
repro): ~40 STRICTLY SEQUENTIAL real-CLI children whose per-child wall time
inflates 10-20x under full-suite process-creation contention (0.8-2.1s quiet
→ 5.8-22.6s loaded, measured inside spawnSync; parent gaps 1-4ms) — the
serial chain passed 300s and node --test executed the file at the ceiling
(2/2 pre-fix reds at 300.9s/324.0s).
Fix (suite execution model, all 17 test names + assertions verbatim):
per-test fixture dirs + 8 concurrent async spawn lanes + every child awaited
with captured stdio and a hard 120s kill timeout (the old C1-11 execFileSync
had NO timeout — a real forever-block hazard). c1 rejoined core (deep pool
12→11); one-character lever if a future full run trips it: lanes 8→12.
Numbers: isolated 17/17 ×3 (15.3-26.0s, was 49.5s serial); loaded repro ×3
green + 1 instrumented (c1 file-level 131.3s loaded = 2.3x margin); tier=
core --dirs=cli ×2 = 535/535; hook core tier ×2 passes c1 green.
ACCEPTANCE MET (2026-10-23 08:52): three consecutive full core runs with c1
green — the hook's two passes + the Lead's capstone fast gate (23/23 green,
24.3min total, unit stage passed on pass 1, retry not engaged, c1 "ok" in
core context).
Residual: ~15 sibling cli suites share the literal double-connection shape —
audited BENIGN (no BUSY captured, better-sqlite3 holds no locks between
statements, sibling walls ≤167s, no ceiling breach); follow-up: per-child
spawn timeouts as mechanical hardening (low harm evidence, wide churn).

### D5. Core-tier quiet-host baseline number (measurement debt)
The 22.1min number is a LOADED-host number. Acceptance: one quiet-window
core-tier timing recorded here; expectations for CI set from that, not from
guesses.

## Fixed this wave (2026-10-23, for the record)

- Deep 11-suite split: slow/load-sensitive suites re-routed out of the fast
  path (route, never drop — full pool unchanged).
- Fast gate coverage stage removed (coverage ratchet stays a full-gate
  instrument; core percentages are a different instrument and must never
  auto-raise the baseline).
- Budgets 15→40/22→45 (budget kills were landing at exactly the budget line
  with zero diagnostics — D10-wave precedent).
- Streaming TAP, ambient-load label, retry-once load-flake doctrine,
  affected-scope pre-commit, failing TAP kept in-tree.
- Size-ratchet baselines for the four round-1 merged main debt files;
  src/main/index.js trimmed back under its ratchet (comment-only).

## D9 - full-gate wall time (RESOLVED 2026-10-23)

Symptom: check:all ran 30-44min (unit tier mixed slow suites with fast ones;
live pool booted SIX private Electron instances for six interaction gates;
43min unit+coverage stage under ambient load; the morning full gate lost all
9 live lanes to the ELECTRON_RUN_AS_NODE host-shell trap).

Fixes shipped (journey-audit, merged through 95505825):
- ea71d439 central ELECTRON_RUN_AS_NODE strip in check-all (live pool boots
  from any host shell; suite-level strips stay belt-and-braces).
- b83435ea D4 orphan hygiene: child-pid registry + verified --cleanup
  tree-kill + exit-handler reap (killed gates no longer leak electrons).
- c0974a78 live-pool consolidation: ONE shared instance serves the six
  interaction gates sequentially (per-target verdicts, single respawn,
  canonical view per target). 6 boots -> 1; full pool 4:08, 6/6 green.
- 739716a6 core concurrency 4 -> 8 (deep stays 4) after the D6/D7/D8 flake
  roots were fixed; designated run 4774/4774 at 5:41 (was 11-13min at 4);
  new native class ncrypto::CSPRNG boot crash (exit 134) added to the
  rerun-once doctrine.
- 95505825 visual lane language pin ordering (dismiss onboarding first,
  write locale keys last); worktree checkouts need browser-dev npm i + their
  own blessed baselines (gitignored per-checkout machine state).

Numbers: full gate 44min -> 7.4min on the same loaded daytime box (31
stages: 30 green + visual red = worktree env debt, green after per-checkout
baseline re-bless); unit tier 6.4min in-gate; live pool 4.3min in-gate;
visual lane 14/14 self-consistent. Pre-commit slice runs: seconds-minutes.
Visual reuse idea honestly declined: the resident browser since c3f8524b IS
the determinism machinery; 2-scene parallelism hits the single-daemon/
single-profile wall. Remaining tail risk: the visual stage can still hit a
bad patch; the 5-6min ideal needs shaving it further.

### D9 appendix - evening burst-load evidence (2026-10-23 17:00-22:15)

Three full-gate runs under the day's worst ambient bursts red'd ROTATING
timing-sensitive suites (unit tier and live pool), every one green in
isolation immediately after: J4 lan-sync-journey (4/4, 66s gate-equivalent),
C4 transport-buffer-budget (3/3), F1 e2e-exit-close (3/3, 12s) - none of
them touched by the wave. Robustness fixes landed from the diagnoses:
- visual readiness probe 5s fetch / 90s window (vite first-transform
  starved the 2s budget in-gate only).
- shared-pool CDP resets 8s -> 20s (Runtime.enable round-trip stalled past
  8s under burst).
- lan-sync-journey global watchdog 300s -> 900s (in-gate suite wall is
  ~2-3x solo under burst; budget-must-cover-worst-path law).
- core concurrency default re-reverted to 4 (tally at 8: 2 green / 1 red
  depending on load - not a safe default on a family box; 8 stays available
  via TEST_CONCURRENCY for quiet windows).
Doctrine confirmed: full-gate reds under burst load are triaged by victim
(green-in-isolation = load class, documented; red-in-isolation = RED-first
fix). The 31/31 single-run stamp belongs to a quiet window, not a dice-roll
rerun under burst.

### D1 pilot results (2026-10-23 evening, main@725661fd)

Scope: tests/unit/utils (6 files, 25 cases) behind tests/pilot/
runner-shim.mjs — files re-point ONE import and run under BOTH runners;
outside vitest the shim is a transparent node:test pass-through (slice
25/25 green 7.2s through the shim, post-merge re-verified).

- Acceptance 1 (parity) PASS: 3 consecutive vitest runs 6/6 files green,
  same set as node --test. Required a runner-semantics alignment: vitest's
  5s default per-test timeout vs node's none (testTimeout 120s) — the
  5000-key capacity case needs >5s.
- Acceptance 2 (wall <=50%) FAIL at this granularity: vitest 11.7-14.5s vs
  node --test 7.4s on the same slice. Vitest's fixed worker-pool boot
  (~10s) dominates a 6-file slice; the process-boot win only amortizes at
  pool scale. CONSEQUENCE: the cutover is a pool-scale project (the
  760-file target), not incremental per-directory waves — the design's
  per-directory waves would each pay the fixed boot and lose.
- Acceptance 3 (gate contract) PASS: vitest's nested TAP is normalized by
  tests/run-pilot.mjs (adapter in the pilot, gate UNMODIFIED); the
  plan-anchored summary parses green, injected-fail negative self-test
  reds exit 1.
- Acceptance 4 (coverage) PASS: @vitest/coverage-v8 emits a parsable
  All-files line; compare-only — the ratchet's calibration stays on the
  full node --test pool (numbers not comparable across runners).

Verdict: compatibility PROVEN (isolation, TAP contract, parity); economics
NEGATIVE below pool scale. Next decision (needs a quiet-window pool-scale
measurement or a design revision): either a pool-scale vitest cutover wave
(one big-bang with dual-run fallback) or shelve D1 and bank the D9 wave.

## 2026-10-24 morning - size-ratchet split queue (baseline-registered, split next session)

The w7 wave + cross-wave growth left six files over their hard caps; baselines
registered per the gate's only-decrease escape hatch. Split queue (by debt weight):
1. cli/lib.js 874 (was 852) - w7 undo/repeatRule runtime; split the undo-renewal core out
2. renderer/js/store/tomato.js 780 (was 743)
3. renderer/js/views/StatisticsView.vue 817 (was 802)
4. src/main/db.js 830 (was 823)
5. src/main/dbRecovery.cjs 827 (no prior baseline)
6. renderer/js/store/settings.js 706 (no prior baseline; closest to its 700 cap - cheapest first)
Rule after registration: only decreases accepted; each split lands with its own slice gates.
## 2026-10-24 morning addendum - split-queue field notes

- Port census (post-F1 fix): no fixed-CDP stragglers remain. 9333 x8 are all the
  shared-pool family or inert references; unit-tier files do not spawn it. The
  F1 collision class is extinct, not just patched.
- settings.js (706) is NOT the cheap split the queue implied: 40 test files
  reference the store, several as SOURCE ANCHORS greping definition text
  (h8-3/daily-0924 style). Moving definitions breaks anchors one missed grep
  at a time. Split it only with a dedicated pass that re-points each anchor;
  suggested seam: lines ~98-310 (pure schema/helpers block) into
  settings-schema.js with re-exports keeping consumer imports stable.
- migrateData pool-only pair: unexplained but contained - the per-file flake
  retry absorbs it (file is solo-green); final28 ran without it failing at all.

## 2026-10-24 wave close - gate stability night (23:00-10:00)

Stamp: full gate 31/31, GATE_EXIT=0, 14.1min (final28 @ b36bffa4); core tier
4874/0 green again through the S2 fail-wide path @ 79644017. 28 full-gate
rounds total; every red was root-caused before the next run (no blind reruns).

Mechanisms landed this wave (see git log 4c836c60..2eb5449c for the full set):
- gate-doctor preflight + load-defer + exit contract (0/1/2/3)
- per-instance TODO_SYNC_PORT on every gate-spawned electron (3442 collision class dead)
- LanSync boot-enable bind retry (crash-restart sync-silently-dead product gap)
- visual lane: daemon kill-wait, probe-tab close guard, orphan-chrome filter on the
  real system-Chrome layout (the *agent-browser*browsers* filter was dead code here)
- D4 child registry: per-pid files (concurrent lost-update fix) + owner=pid filtering
  (a NESTED run-all must not reap its parent's children - the final25/26 corpus
  aborts were exactly this) + run-all exit reap symmetric with check-all
- run-all per-file flake retry (location extraction strips :line:col, 30s settle,
  cap 12) - supersedes and retired the whole-suite --retry-once
- F1 ephemeral CDP port (fixed 9377 hung the pool); e2e-exit-close boot budget 90s
- five contract-drift suites re-anchored (d18 #12 discriminator, F20/M-1 probe
  conservatism, h8-3 effective-commit, daily-0924 tombstone family sets)
- six size baselines registered with an ordered split queue (below)

Queue for the next focused session (heaviest first):
1. cli/lib.js split - NOT a comment-compression job (118 comment lines < the 75+
   needed); the chips family extraction threads ~6 module closures. 40 test files
   watch cli/lib.js, 5 are source-readers.
2. renderer/js/store/settings.js - 40 referencing files, several source anchors;
   seam = pure block (lines ~98-310) into settings-schema.js + re-exports.
3. migrateData pool-only pair - contained by the flake retry (solo-green file);
   repro harness only if it ever reds a gate again.
4. D1 vitest pooled-scale measure - needs a quiet machine window + user consent.

Operating note: daytime runs belong to the user; heavy verification outside
slice gates needs explicit consent per the standing discipline.
