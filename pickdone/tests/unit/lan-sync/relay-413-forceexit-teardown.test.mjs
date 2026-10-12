/**
 * Discriminating regression for the relay-413-drain teardown crash (2026-10-12).
 *
 * Failure mode: the drain test's assertions all passed, but run-all's per-file child —
 * which runs with --test-force-exit — died at process exit with exitCode 3221226505
 * (0xC0000409, win32 libuv teardown assert) because the server's keep-alive socket
 * (fetch's undici dispatcher) was still unwinding when the forced exit snapped the
 * process. Standalone `node --test` (no force-exit) never reproduces it, so a plain
 * green run proves nothing about the parallel/forced-exit scenario.
 *
 * This test reproduces the EXACT runner environment: spawn `node --test
 * --test-force-exit relay-413-drain.test.mjs` as a child and require exit code 0 —
 * 3 iterations, because the crash was probabilistic under load. A regression here
 * (fix reverted or a new lingering handle) shows up as exit code 3221226505, not as
 * a silent skip; the retry-free 3x budget keeps the signal without长超时 masking.
 *
 * Run: node --test tests/unit/lan-sync/relay-413-forceexit-teardown.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const TARGET = path.join(import.meta.dirname, 'relay-413-drain.test.mjs')

test('relay-413-drain exits 0 under --test-force-exit (no libuv teardown crash), 3x', () => {
  for (let i = 0; i < 3; i++) {
    // pin the TAP reporter: the pass-count anchor below parses TAP, and node >= 24 defaults to
    // the spec reporter on non-TTY stdout (same 2026-09-24 pitfall run-all guards against)
    const r = spawnSync(process.execPath, ['--test', '--test-force-exit', '--test-reporter=tap', '--test-reporter-destination=stdout', TARGET], {
      encoding: 'utf8',
      timeout: 120_000,
      // strip the outer runner's NODE_TEST_CONTEXT: with it inherited, node >= 24 refuses to
      // run nested test files ("run() is being called recursively... skipping running files")
      // and the child exits 0 having tested nothing — an empty-green we must never mistake
      // for a pass.
      env: (() => { const e = { ...process.env }; delete e.NODE_TEST_CONTEXT; return e })()
    })
    assert.equal(r.error, undefined, `iteration ${i + 1}: child spawned cleanly (${r.error})`)
    assert.equal(
      r.status, 0,
      `iteration ${i + 1}: forced-exit child must exit 0 — got ${r.status} ` +
      `(0xC0000409 = libuv teardown assert: a handle was still closing at exit)\n` +
      String(r.stderr || '').slice(-800)
    )
    assert.match(String(r.stdout), /# pass 1/, `iteration ${i + 1}: the drain subtest itself passed`)
  }
})
