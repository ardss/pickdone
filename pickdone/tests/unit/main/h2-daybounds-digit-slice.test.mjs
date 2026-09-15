/* H2 fix #3 regression: _dayBounds must reject 9-11 digit inputs (Unix seconds etc.) whose
   YYYYMMDD digit-slice produces a "valid but wrong" calendar date (year 1757, month 00) instead
   of NaN — those used to silently poison stats. Same USAGE contract as the NaN guard (F2).
   Run: node --test tests/unit/main/h2-daybounds-digit-slice.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')

db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'h2-daybounds-')))

test('unix-seconds-like inputs throw USAGE instead of slicing into year 17xx', () => {
  assert.throws(() => db.call('statsByDay', { from: 1758000000, to: 20260915 }), /not a parseable date/)
  assert.throws(() => db.call('tomatoByDay', { from: 20260901, to: 99999999999 }), /not a parseable date/)
  // 10-digit with a valid-looking but out-of-range month/day slice also throws
  assert.throws(() => db.call('statsByDay', { from: 202613010, to: 20261231 }), /not a parseable date/)
})

test('legit YYYYMMDD and millisecond bounds are unaffected', () => {
  assert.doesNotThrow(() => db.call('statsByDay', { from: 20260901, to: 20260915 }))
  assert.doesNotThrow(() => db.call('tomatoByDay', { from: Date.now() - 86400000, to: Date.now() }))
  assert.doesNotThrow(() => db.call('statsByDay', { from: null, to: 20260915 }))
})
