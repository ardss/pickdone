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
