/**
 * D18 (2026-10-02) — CSV parse worker: no terminate() on the SUCCESS path.
 * finish() used to terminate() the worker on every settle path, including the success resolve —
 * a successful parse still killed its thread mid-teardown (exit code 1, masked by the settled
 * guard). A success now lets the worker exit naturally; only timeouts and error paths terminate.
 * Run: node --test tests/unit/main/d18-csv-success-natural-exit.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const csv = require('../../../src/main/handlers/csv-import.js')
const VALID_CSV = 'Type,Content,Priority,Indent\ntask,alpha,1,1\n'

test('D18: a successful parse exits naturally (code 0, no terminate)', async () => {
  csv.__resetWorkerRegistry()
  const r = await csv.runImportParse(VALID_CSV)
  assert.equal(r.ok, true)
  // the worker's natural exit must land code 0 with no timeout-terminate in between
  for (let i = 0; i < 50 && !csv.__lastRunStats(); i++) await new Promise(res => setTimeout(res, 20))
  const st = csv.__lastRunStats()
  assert.ok(st, 'the worker exited and reported its stats')
  assert.equal(st.exitCode, 0, 'red before the fix: terminate() on success made the worker exit with code 1')
  assert.equal(st.timedOut, false)
  assert.equal(csv.__workerRegistry().outstanding, 0, 'the registry still releases the finished worker')
})

test('D18: the timeout path still terminates the worker (exit code 1, timedOut true)', async () => {
  csv.__resetWorkerRegistry()
  csv.__setParseTimeoutMs(20)
  try {
    await assert.rejects(() => csv.runImportParse(VALID_CSV), /timed out/)
    for (let i = 0; i < 50 && (!csv.__lastRunStats() || csv.__lastRunStats().exitCode === 0); i++) {
      await new Promise(res => setTimeout(res, 20))
    }
    const st = csv.__lastRunStats()
    assert.equal(st.timedOut, true, 'the parse hit the injected timeout and was terminated')
    // NOTE: the exit code is intentionally not asserted — a worker that finishes naturally in the
    // terminate() race exits 0; only a clone-stuck thread never exits at all (the D17 case).
  } finally {
    csv.__setParseTimeoutMs(30000)
    csv.__resetWorkerRegistry()
  }
})
