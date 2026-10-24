# Test runner modernization design (D1) — pilot-first, gate-compatible

Status: DESIGN (no code). This is the S5 deliverable — the migration itself
starts only after this document survives review and a pilot proves the two
hard compatibility points (TAP gate contract; isolation semantics).

## Current cost structure (measured)

- ~760 test files, ~4700+ cases, node --test, one PROCESS per file, concurrency 4-8.
- Core tier 22.1min on the loaded dev host (2026-10-23); process-boot overhead
  is the largest single reducible cost, followed by load inflation (ambient
  ~100% CPU from co-tenant apps).

## Target

A pooled in-process runner for the CORE tier with:
1. **Gate contract unchanged**: the summary gate (fail=0 + skip ratchet) and
   check:all semantics stay byte-compatible. Vitest ships a TAP reporter
   (`--reporter=tap`), so check-test-summary.cjs keeps parsing a TAP plan +
   `# fail` block — the structural-anchor hardening (plan-anchored summary
   parsing) survives as-is.
2. **Isolation semantics preserved per suite**: this suite relies on
   process-per-file isolation (global shims: document/window.Vue stubs,
   process.env poisoning, chdir fixtures, localStorage emulation). The pilot
   must PROVE per-file isolation inside one process (vitest worker pool with
   `isolate: true` per file = worker_threads/fork isolation, cheaper than
   processes but still isolating) or classify the suite as incompatible.
3. **No runner lock-in for the deep tier**: the 11 deep suites stay on
   node --test until individually proven (real sockets, real Electron, real
   time).

## Pilot

- Scope: ONE directory, chosen for purity and size — `tests/unit/dates/` or
  `tests/unit/utils/` (pure in-process specs, ~6-20 files, seconds today).
- Mechanics: `vitest --dir tests/unit/utils --reporter=tap` behind
  `tests/run-pilot.mjs`; `npm run test:pilot`. NOT wired into any gate —
  explicitly opt-in until acceptance passes.
- Acceptance (all four, measured):
  1. Same pass/fail set as node --test on the same dir, 3 consecutive runs.
  2. Wall time ≤50% of the node --test slice on the loaded host.
  3. check-test-summary.cjs parses the pilot TAP unmodified (fail=0 green;
     injected-fail red via a scratch fixture — negative self-test).
  4. `--experimental-test-coverage` equivalent produces a parsable all-files
     line (coverage parity for the ratchet's full-pool calibration).

## Cutover (only after pilot acceptance)

Per-directory migration waves (dates/utils → components → renderer → store →
main → cli), each wave: dual-run in CI for one full gate cycle, then flip the
default. node --test stays for deep tier + as the fallback runner
(TEST_RUNNER=node|vitest env). The summary gate grows a runner-tagged TAP
signature so a mixed pool can never cross-calibrate.

## Risk register

| Risk | Mitigation |
|---|---|
| Globals bleed between files in one worker | vitest `isolate: true` (default) + pilot dir proves it before any wave |
| TAP format drift between vitest versions | pin vitest version; golden TAP fixture test in gate-must-fail-golden style |
| Coverage instrumentation differs from node's | coverage calibration stays on the FULL node --test pool (ratchet untouched); vitest coverage is compare-only until proven |
| Setup semantics (setup.mjs imports, node:test hooks) | per-file audit during each wave; t.mock/test hooks map 1:1 to vi.* — mechanical but reviewed file-by-file |
| Silent skip drift (vitest skip syntax differs) | skip ratchet catches it by construction |

## Non-goals

- No full-pool cutover in one wave. No deep-tier migration. No gate semantics
  change. No unmeasured promises — every wave lands with before/after numbers
  appended to docs/perf-debt-ledger.md.

## Pilot data 2026-10-25: node:test same-process mode measured and REJECTED

Real numbers from the official zero-migration candidate
(`node --test --experimental-test-isolation=none`, the runner-builtin answer
to the spawn storm — tested first because it needs NO code changes):

- Scope: full unit tier via glob (`tests/unit/**/*.test.mjs`), quiet host
  (01:2x local), node v22.23.2.
- Result: **4734 tests / 4732 failed / 237s wall**. Single files in the same
  mode pass (billing slice: 8/8 in isolation) — the mass failure is
  cross-FILE global pollution: one file's localStorage replacement leaks
  into every later file in the shared process (failureType: hookFailed,
  wipeLs -> `localStorage.key is not a function` propagating through the
  shared module cache).
- Verdict: process-per-file isolation is not ceremony — it is what the
  suite's global-state discipline actually relies on. The official
  same-process mode is **rejected**: fixing it would mean auditing ~760
  files for global restore discipline, which costs more than the runner
  migration itself and remains fragile forever after.

Decision (stays DESIGN until the user approves the investment):
1. The spawn storm (D1) is real and this pilot closes the "cheap way out"
   branch — there is no zero-migration path to a pooled runner for this
   suite.
2. The viable route stays vitest with `pool: 'forks'` + `isolate: true`
   (worker reuse WITH per-file isolation), per the pilot/cutover plan above.
   Migration cost is measured in waves of weeks, not one session — the
   runner-shim exists, the acceptance harness (`tests/run-pilot.mjs`,
   `npm run test:pilot`) is the next concrete step when scheduled.
3. Until then, the per-file spawn pool stays, and D1's load inflation is
   managed by the (audited) load-budget wave — budgets are the anesthesia,
   this document is the surgery plan. Freeze note: no new features on the
   home-grown flake ledger / TAP composition while the runner decision is
   open (avoid gold-plating a wheel the migration may delete).
