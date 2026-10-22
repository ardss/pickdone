# Test performance debt ledger (2026-10-23 night wave)

Doctrine: a debt item only leaves this ledger when its acceptance number is
MEASURED, not promised. Every item carries its current number, the plan, and
the acceptance line. (Lesson of 2026-10-22/23: an unmeasured promise — "4
minutes" — burned trust worse than the original slowness.)

## Baseline numbers (measured, this host = 12 cores, sustained ~100% ambient load)

| Pool | Before | After (2026-10-23) | When |
|---|---|---|---|
| Full pool (unit+integration+visual, conc 4) | 33-40min | unchanged (full gate only) | 2026-10-22 22:14 run: 36min |
| Core tier (727 files, conc 8) | n/a | **22.1min** loaded host; quiet-host number pending | 2026-10-23 01:26 run, 4719 pass |
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
