/* C8 (2026-10-10 daily sweep) — log-isolation must load at MODULE LOAD in transport.js and
 * discovery.js, BEFORE any electron-log write can fire. The old pattern required it only
 * AFTER a warn/error had been emitted, so under TODO_DB_DIR/TODO_USER_DATA_DIR the first
 * warn line (EADDRINUSE, UDP channel dead, send failure) landed in the REAL user log
 * (%APPDATA%/pickdone/logs/main.log). line-reader.js already had the correct order (D22).
 * Source anchors pin the order contract; the runtime redirect itself is covered by the
 * log-isolation module's own idempotency.
 * Run: node --test tests/unit/lan-sync/d23-log-isolation-order.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

const read = rel => fs.readFileSync(path.join(import.meta.dirname, '../../../src/main/lan-sync', rel), 'utf8')

for (const file of ['transport.js', 'discovery.js']) {
  test(`C8: ${file} loads log-isolation at module top, before any electron-log write site`, () => {
    const src = read(file)
    const firstLogWrite = src.indexOf("require('electron-log')")
    const firstIsolation = src.indexOf("require('../log-isolation')")
    assert.ok(firstIsolation !== -1, 'module must pull in log-isolation')
    assert.ok(firstIsolation < firstLogWrite,
      `log-isolation (${firstIsolation}) must precede the first electron-log write (${firstLogWrite})`)
    // the stale AFTER-the-fact inline requires must be gone (they masked the ordering bug)
    assert.ok(!/require\('\.\.\/log-isolation'\)\s*\/\/\s*test isolation/.test(src),
      'inline after-the-write isolation requires are the bug shape — removed')
  })
}

/* QC 2026-10-09 sweep: tomato-announce.js (src/main) and lan-sync/att-transfer.js had the same
 * AFTER-the-write inline require shape. Same order contract, hoisted to module load. */
const readMain = rel => fs.readFileSync(path.join(import.meta.dirname, '../../../src/main', rel), 'utf8')

test('C8/QC: tomato-announce.js loads log-isolation at module top, before any electron-log write', () => {
  const src = readMain('tomato-announce.js')
  const firstLogWrite = src.indexOf("require('electron-log')")
  const firstIsolation = src.indexOf("require('./log-isolation')")
  assert.ok(firstIsolation !== -1, 'module must pull in log-isolation')
  assert.ok(firstIsolation < firstLogWrite,
    `log-isolation (${firstIsolation}) must precede the first electron-log write (${firstLogWrite})`)
  assert.ok(!/require\('\.\/log-isolation'\)\s*\/\/\s*test isolation/.test(src),
    'inline after-the-write isolation requires are the bug shape — removed')
})

test('C8/QC: lan-sync/att-transfer.js loads log-isolation at module top, before any electron-log write', () => {
  const src = read('att-transfer.js')
  const firstLogWrite = src.indexOf("require('electron-log')")
  const firstIsolation = src.indexOf("require('../log-isolation')")
  assert.ok(firstIsolation !== -1, 'module must pull in log-isolation')
  assert.ok(firstIsolation < firstLogWrite,
    `log-isolation (${firstIsolation}) must precede the first electron-log write (${firstLogWrite})`)
  assert.ok(!/require\('\.\.\/log-isolation'\)\s*\/\/\s*test isolation/.test(src),
    'inline after-the-write isolation requires are the bug shape — removed')
})
