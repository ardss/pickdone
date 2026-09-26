/**
 * Regression: JSON-restore gate must require a SUCCESSFUL re-init (2026-09-26, lubancat live).
 *
 * The startup catch-block used to run the JSON restore purely on `source === 'json'`. When the
 * re-init ALSO failed (board case: the vendor sqlite driver cannot load under Debian 11 glibc),
 * the restore still ran — every busCommit inside it throws ("stmts.upsertMany is not a function"
 * against empty prepared statements) and the "recovery" rebuilds nothing while the log shows a
 * restore attempt. The gate now lives in dbRecovery.jsonRestoreAllowed(source, reinitErr).
 *
 * Run: node --test tests/unit/main/dbrecovery-json-gate.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const dbRecovery = await import('../../../src/main/dbRecovery.cjs')

test('jsonRestoreAllowed: json source + successful re-init -> restore runs', () => {
  assert.equal(dbRecovery.jsonRestoreAllowed({ source: 'json', label: 'x' }, null), true)
})

test('jsonRestoreAllowed: json source but re-init FAILED -> restore must NOT run (bus would throw on empty stmts)', () => {
  assert.equal(dbRecovery.jsonRestoreAllowed({ source: 'json', label: 'x' }, new Error('GLIBC_2.33 not found')), false)
})

test('jsonRestoreAllowed: non-json sources never restore through the bus', () => {
  for (const source of ['retry-ok', 'transient', 'plain-bak', 'error', null, undefined]) {
    assert.equal(dbRecovery.jsonRestoreAllowed(source === null ? null : { source }, null), false, `source=${source}`)
  }
})
