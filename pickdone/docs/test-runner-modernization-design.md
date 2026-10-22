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
