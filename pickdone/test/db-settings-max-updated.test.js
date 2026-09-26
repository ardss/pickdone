/* round3-startup-perf-finding-1 (2026-09-26): the external-write watcher's settings watermark
 * (forwardTomatoCmd, src/main/index.js) used to compute max(updatedAt) via settingsRowsAll —
 * a full settings_rows scan with per-row JSON.parse on EVERY 500ms poll tick, forever. The
 * DB layer now exposes settingsRowsMaxUpdated: one MAX aggregate, identical value, zero
 * per-row JSON.parse.
 * Fresh temp DB via TODO_DB_DIR / TODO_USER_DATA_DIR — the real %APPDATA% is never touched.
 * NOTE: pickdone/test/ is NOT auto-discovered by tests/run-all.mjs; run directly:
 * node --test test/db-settings-max-updated.test.js */
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-maxupd-'))
process.env.TODO_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'settings-maxupd-ud-'))

const db = require('../src/main/db.js')
db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'settings-maxupd-db-')))

// Behavior-preservation probe: counts JSON.parse calls made inside a db.call (the aggregate
// path must do none — the old rowsAll path parsed every row).
function withParseCounter (fn) {
  const orig = JSON.parse
  let count = 0
  JSON.parse = (...a) => { count++; return orig(...a) }
  try { return { result: fn(), count } } finally { JSON.parse = orig }
}

const rowsMax = () => db.call('settingsRowsAll').reduce((m, r) => Math.max(m, Number(r.updatedAt) || 0), 0)

test('settingsRowsMaxUpdated === max over settingsRowsAll (empty table)', () => {
  assert.equal(db.call('settingsRowsMaxUpdated'), 0)
  assert.equal(db.call('settingsRowsMaxUpdated'), rowsMax())
})

test('settingsRowsMaxUpdated === max over settingsRowsAll (populated table)', () => {
  db.call('settingsRowPut', { key: 'a.b', value: { x: { deep: [1, 2, 3] } } })
  db.call('settingsRowPut', { key: 'c.d', value: 'plain' })
  const max = db.call('settingsRowsMaxUpdated')
  assert.ok(max > 0, 'precondition: rows exist with real timestamps')
  assert.equal(max, rowsMax(), 'THE FIX: the aggregate equals the scanned max (same output)')
})

test('settingsRowsMaxUpdated includes tombstones (deleted rows count, same as the old loop)', () => {
  db.call('settingsRowPut', { key: 'gone.field', value: 1 })
  const before = db.call('settingsRowsMaxUpdated')
  db.call('settingsRowDelete', { key: 'gone.field' })
  const after = db.call('settingsRowsMaxUpdated')
  assert.ok(after >= before, 'a tombstone is a state change the watermark must see')
  assert.equal(after, rowsMax())
})

test('the aggregate path performs zero per-row JSON.parse (fewer calls, identical output)', () => {
  const agg = withParseCounter(() => db.call('settingsRowsMaxUpdated'))
  assert.equal(agg.count, 0, 'THE FIX: MAX aggregate does not JSON.parse rows')
  const scan = withParseCounter(() => rowsMax())
  assert.ok(scan.count > 0, 'precondition: the old rowsAll path did parse per row')
  assert.equal(agg.result, scan.result)
})
