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

### D8. Same premature-force-exit bomb shape in 7 more test files (NEW 2026-10-23)
The D7 doctrine violation (test() registrations interleaved with a module-
level await import) exists in 7 more files (list in D7). None has tripped in
observed runs yet — the window needs the import to still be resolving when
the LAST currently-registered test finalizes — but the shape is load-hostile.
Plan: mechanical one-move fix per file (hoist the await import above all
registrations), batched in one wave with the same repro rig.
Acceptance: all 7 files green in the loaded repro context; a repo-wide grep
guard (gate or golden) that fails when a test file registers test() before a
module-level await.

### D6. CLI fixture-suite double-connection lock race (NEW 2026-10-23, root-caused)
Evidence trail: c1-parse-ux file-level 300s-ceiling kills at conc 4 AND 8
(2026-10-22 22:14 run + 2026-10-23 final-verify pass1 AND pass2 — overlapping
victims, not random); stderr "tomato ledger migration failed (database is
locked)" on fixture `todo-cli-c2-integrity-pid*`; green in isolation every
time (17/17). Mechanism: test parent holds a fixture-db connection while the
spawned CLI child opens the same db and runs the tomato-ledger migration —
the lock race widens under scheduler pressure; busy_timeout=5000 (ES1) turns
it into a 5s-late throw + warning, and the child's output never settles inside
the file's 300s ceiling. Interim: c1-parse-ux routed to DEEP (spawn-heavy
criterion). Real fix (this debt): fixture connections opened by spawned CLI
children need an awaited lifecycle + the suite needs a settled-output
contract; audit the other cli suites that spawn children against a fixture db
(c2-integrity family) for the same pattern.
Acceptance: c1-parse-ux rejoins core and survives 3 consecutive full core runs
under load.

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
