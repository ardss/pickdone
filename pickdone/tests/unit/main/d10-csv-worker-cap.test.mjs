/** D10 (2026-09-27): CSV import parse workers were unbounded — timeout abandons a worker with only
 *  a best-effort terminate() (documented as unable to force-reclaim a clone-stuck worker), so
 *  repeated pathological previews accumulated unreclaimable threads. runImportParse now caps
 *  concurrent parses (coded BUSY refusal) and trips a circuit breaker after repeated leaks.
 * Run: node --test tests/unit/main/d10-csv-worker-cap.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const csv = require('../../../src/main/handlers/csv-import.js')
const runImportParse = csv.runImportParse

// Todoist template shape (detectable header + parseable rows)
const VALID_CSV = 'Type,Content,Priority,Indent\ntask,alpha,1,1\ntask,beta,1,1\n'

test('d10: concurrent parses are capped — a third in-flight parse is refused with a coded BUSY error', async () => {
  csv.__resetWorkerRegistry()
  // Two Workers are minted synchronously → the third call sees a full outstanding set.
  const p1 = runImportParse(VALID_CSV)
  const p2 = runImportParse(VALID_CSV)
  await assert.rejects(() => runImportParse(VALID_CSV), e => {
    assert.equal(e.code, 'BUSY')
    assert.match(e.message, /\[BUSY\]/)
    return true
  }, 'red before the fix: unbounded Worker creation, every call minted a new thread')
  const [r1, r2] = await Promise.all([p1, p2])
  assert.ok(r1.ok && r2.ok, 'the two allowed parses complete normally')
  assert.equal(csv.__workerRegistry().outstanding, 0, 'settled workers leave the outstanding set')
})

test('d10: after the cap frees up, new parses are accepted again (no permanent lockout)', async () => {
  csv.__resetWorkerRegistry()
  const r = await runImportParse(VALID_CSV)
  assert.equal(r.ok, true)
  assert.equal(csv.__workerRegistry().outstanding, 0)
})
