/* round3-startup-perf-finding-3 (2026-09-26): tomatoAll ('SELECT * FROM tomato_records WHERE
 * deleted = 0 ORDER BY endTime DESC') is re-run on every ledger-write reload in every peer
 * window; without a (deleted, endTime) index it is a full SCAN + TEMP B-TREE sort. The schema
 * now carries idx_tomato_records_endtime. Pure perf: this test proves behavior is preserved
 * (same rows, same endTime DESC order, tombstones still hidden) and that the plan actually
 * uses the index with no temp B-tree (the measurable fewer-work proof).
 * Fresh temp DB via TODO_DB_DIR / TODO_USER_DATA_DIR — the real %APPDATA% is never touched.
 * NOTE: pickdone/test/ is NOT auto-discovered by tests/run-all.mjs; run directly:
 * node --test test/db-tomato-endtime-index.test.js */
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tomato-idx-'))
process.env.TODO_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'tomato-idx-ud-'))

const db = require('../src/main/db.js')
db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'tomato-idx-db-')))

// Raw handle for plan/index probes: the db module does not export prepare, so open a plain
// in-memory db with the SAME exported SCHEMA (the fix lives in the schema text).
const Database = require(path.join(__dirname, '..', 'vendor', 'better-sqlite3-multiple-ciphers'))
const memDb = new Database(':memory:')
memDb.exec(db.SCHEMA)

const N = 3000
const rows = []
for (let i = 0; i < N; i++) {
  rows.push({
    tomatoId: 't' + i,
    // insert endTime ASC so a correct DESC ordering is only observable if sorting actually happens
    endTime: 1700000000000 + i,
    dateKey: '2026-09-26',
    focus: 25,
    succeed: true,
    manual: false,
    status: 'done'
  })
}
db.call('tomatoAppendMany', rows)
// a tombstone row must never surface in tomatoAll
db.call('tomatoAppendMany', { tomatoId: 'gone', endTime: 1999999999999, dateKey: '2026-09-26', focus: 25, succeed: true, manual: false })
db.call('tomatoRemoveByIds', ['gone'])

test('idx_tomato_records_endtime exists (THE FIX: schema ships the index)', () => {
  const idx = memDb.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_tomato_records_endtime'").get()
  assert.ok(idx, 'expected index idx_tomato_records_endtime on tomato_records')
})

test('behavior preserved: tomatoAll returns every live row in endTime DESC order, tombstones hidden', () => {
  const all = db.call('tomatoAll')
  assert.equal(all.length, N, 'every live row is returned')
  const times = all.map(r => r.endTime)
  const sorted = [...times].sort((a, b) => b - a)
  assert.deepEqual(times, sorted, 'rows are strictly endTime DESC')
  assert.ok(!all.some(r => r.tomatoId === 'gone'), 'tombstoned rows stay hidden')
  assert.equal(all[0].tomatoId, 't' + (N - 1), 'newest row first')
})

test('the tomatoAll plan uses the index and no TEMP B-TREE (fewer-work proof)', () => {
  const plan = memDb.prepare("EXPLAIN QUERY PLAN SELECT * FROM tomato_records WHERE deleted = 0 ORDER BY endTime DESC").all()
  const detail = plan.map(p => p.detail || p['detail'] || '').join(' | ')
  assert.ok(detail.includes('idx_tomato_records_endtime'),
    'plan must SEARCH via idx_tomato_records_endtime, got: ' + detail)
  assert.ok(!detail.toUpperCase().includes('TEMP B-TREE'),
    'plan must not sort via TEMP B-TREE, got: ' + detail)
})
