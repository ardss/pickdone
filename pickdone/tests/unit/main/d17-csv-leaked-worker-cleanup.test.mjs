/**
 * D17 (2026-10-02) — CSV import leak-breaker registry never shrank. A worker terminated on
 * timeout that DID exit (terminate() reclaimed it) stayed in leakedWorkers forever, so three
 * slow-but-valid parses permanently bricked CSV import with [BUSY]. A timed-out worker whose
 * 'exit' fires is not leaked; only a worker that never exits (clone-stuck) keeps counting.
 * Run: node --test tests/unit/main/d17-csv-leaked-worker-cleanup.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const csv = require('../../../src/main/handlers/csv-import.js')
const runImportParse = csv.runImportParse

const VALID_CSV = 'Type,Content,Priority,Indent\ntask,alpha,1,1\ntask,beta,1,1\n'

test('D17: a timed-out-but-exited parse worker leaves the leak registry (breaker is not tripped)', async () => {
  csv.__resetWorkerRegistry()
  csv.__setParseTimeoutMs(20) // force a fast timeout; restored in finally
  try {
    await assert.rejects(() => runImportParse(VALID_CSV), /timed out/, 'the parse times out on the tiny budget')
    // Give the terminate()'d worker a moment to fire its 'exit' event.
    for (let i = 0; i < 50 && csv.__workerRegistry().leaked > 0; i++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.equal(csv.__workerRegistry().leaked, 0,
      'red before the fix: the exited worker stayed in leakedWorkers forever')
    // The breaker is not tripped: subsequent parses are accepted (no [BUSY]). Restore the normal
    // budget first — the tiny 20ms budget is smaller than a worker-thread cold start.
    csv.__setParseTimeoutMs(30000)
    const r = await runImportParse(VALID_CSV)
    assert.equal(r.ok, true, 'CSV import is not bricked after timeout+exit cycles')
  } finally {
    csv.__setParseTimeoutMs(30000)
    csv.__resetWorkerRegistry()
  }
})
