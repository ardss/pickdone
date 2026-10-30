/**
 * D1 pilot config (docs/test-runner-modernization-design.md).
 *
 * Scope discipline: this config ONLY serves tests/run-pilot.mjs (opt-in,
 * gate-invisible). include is pinned to the pilot dir so a stray `vitest`
 * invocation can never sweep the whole tree; the gate's runner and the
 * coverage ratchet calibration stay on node --test untouched.
 */
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    // [wave-1 2026-10-25] utils + dates (16 files) — the 6-file pilot could not amortize
    // vitest's ~15s fixed startup (measured cross-over vs per-file spawn at ~8-10 files).
    include: ['tests/unit/utils/*.test.mjs', 'tests/unit/dates/*.test.mjs'],
    isolate: true, // per-file worker isolation — the pilot's hard compatibility point
    globals: false,
    // node:test has NO per-test timeout (budget lives at the file/pool level);
    // parity therefore means a generous per-test ceiling, not vitest's 5s
    // default (2026-10-23 pilot: the 5000-key capacity case needs >5s and
    // vitest red'd it while node:test passed — pure runner-semantics gap).
    testTimeout: 120_000,
    hookTimeout: 60_000,
    // TAP comes from the CLI flag (--reporter=tap) so the summary gate can
    // parse the stream unmodified (acceptance 3).
  },
})
