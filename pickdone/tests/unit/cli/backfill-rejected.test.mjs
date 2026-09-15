/* backfillRecord fail-fast on db-layer rejected rows (cli/lib.js): the CLI writes a single row, so a
   rejected row (NaN endTime etc.) must surface as a CliError(LEDGER_REJECT) instead of printing
   success and writing audit. Row-level tolerance ({accepted, rejected}) is the renderer's batch path.
   Isolated temp DB via TODO_DB_DIR.
   Run: node --test tests/unit/cli/backfill-rejected.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-backfill-'))
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')

db.init(process.env.TODO_DB_DIR)

test('backfillRecord: db-layer rejected row → CliError LEDGER_REJECT (no silent success)', () => {
  const orig = db.call
  db.call = (op, p) => op === 'tomatoAppendMany'
    ? { accepted: 0, rejected: [{ index: 0, tomatoId: 'tmt_x', reason: 'endTime required' }] }
    : orig.call(db, op, p)
  try {
    assert.throws(
      () => lib.backfillRecord({ date: '2026-09-15', at: '20:00', minutes: 25 }),
      e => e.code === 'LEDGER_REJECT' && /backfill rejected: endTime required/.test(e.message)
    )
  } finally { db.call = orig }
})

test('backfillRecord: accepted row still succeeds end-to-end', () => {
  const rec = lib.backfillRecord({ date: '2026-09-15', at: '21:00', minutes: 25 })
  const all = db.call('tomatoAll')
  assert.ok(all.some(r => r.tomatoId === rec.tomatoId))
})
