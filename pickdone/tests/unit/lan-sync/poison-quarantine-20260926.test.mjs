/* Poison-row quarantine regression tests (2026-09-26 live incident, case 3):
 * A flush of a poisoned settings segment used to DROP the dropped rows with log.error only
 * ("recoverable via snapshot"). Two fixes under test:
 *   P-1  db-sync-schema.rowPutMany: failure granularity is per-ROW — a row whose value
 *        JSON.stringify cannot encode (BigInt) must not abort the whole buffered segment;
 *        valid siblings commit, the poison row is rejected with a reason.
 *   P-2  sync-apply.flushPendingWrites: when a bulk op still throws, the dropped rows are
 *        PARKED in a machine-local meta key (sync.flushQuarantine.<op>) and the flush result
 *        carries a `quarantined` list; finalizeIngest raises a visible 'flush-quarantined'
 *        syncEvent instead of a log-only drop.
 *
 * Run: node --test tests/unit/lan-sync/poison-quarantine-20260926.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const syncSchema = require_('../../../src/main/db-sync-schema.js')
const bootstrap = require_('../../../src/main/lan-sync-bootstrap.js')
const Database = require_('../../../vendor/better-sqlite3-multiple-ciphers')

const DDL = `CREATE TABLE IF NOT EXISTS settings_rows (
  key       TEXT PRIMARY KEY,
  value     TEXT,
  updatedAt INTEGER NOT NULL DEFAULT 0,
  deleted   INTEGER NOT NULL DEFAULT 0,
  deletedAt INTEGER NOT NULL DEFAULT 0
);`

function freshDb () {
  const d = new Database(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'poison-q-')), 'todos.db'))
  d.exec(DDL)
  return d
}

/* ---------- P-1: per-row isolation inside rowPutMany ---------- */

test('P-1: one un-stringifiable row value must not abort the buffered segment (valid siblings commit)', () => {
  const d = freshDb()
  const warnings = []
  const schema = syncSchema({ getDb: () => d, log: { warn: (...a) => warnings.push(a.join(' ')), info: () => {}, error: () => {} } })
  // A BigInt value defeats JSON.stringify inside putRow — before the fix this throw unwound the
  // whole transaction and re-threw out of rowPutMany, so flushOne dropped EVERY row in the segment.
  const changed = schema.rowPutMany([
    { key: 'good1', value: 'one', updatedAt: 1000 },
    { key: 'poison', value: 1n },
    { key: 'good2', value: { nested: true }, updatedAt: 2000 },
  ])
  assert.deepEqual(changed.sort(), ['good1', 'good2'], 'valid rows must commit past the poison row')
  const all = schema.rowsAll()
  assert.ok(all.find(r => r.key === 'good1' && r.value === 'one'), 'good1 landed')
  assert.ok(all.find(r => r.key === 'good2' && r.value && r.value.nested === true), 'good2 landed')
  assert.ok(!all.find(r => r.key === 'poison'), 'the poison row must NOT be written')
  assert.ok(warnings.some(w => w.includes('poison') || w.includes('rejected')), 'the poison row is reported (rejected log)')
  d.close()
})

/* ---------- P-2: flush quarantine + visible syncEvent ---------- */

function quarantineState ({ failOp }) {
  const meta = {}
  const sent = []
  const state = {
    deviceId: 'devPoisonQ',
    applyCache: null,
    applied: null,
    pendingWrites: {
      todos: [], tomatoes: [], categories: [], plans: [], filters: [],
      settings: [{ key: 'dailyTomatoTarget', value: '12', updatedAt: Date.now() - 1000 }],
    },
    db: {
      call: (op, p) => {
        if (op === failOp) throw new Error('poison row')
        if (op === 'getMeta') return meta[p] != null ? meta[p] : null
        if (op === 'setMeta') { meta[p[0]] = p[1]; return true }
        return true
      },
    },
    getWindowSenders: () => [{ isDestroyed: () => false, send: (ch, msg) => sent.push({ ch, msg }) }],
  }
  return { state, meta, sent }
}

test('P-2: a failed flush parks its dropped rows in sync.flushQuarantine.<op> and reports them', () => {
  const { state, meta } = quarantineState({ failOp: 'settingsRowPutMany' })
  bootstrap.__test.setState(state)
  const row = state.pendingWrites.settings[0]

  const r = bootstrap.__test.flushPendingWrites()
  assert.equal(r.ok, false, 'the flush still reports failure (ack honesty unchanged)')
  assert.equal(r.quarantined.length, 1, 'the flush result names the quarantined segment')
  assert.equal(r.quarantined[0].op, 'settingsRowPutMany')
  assert.equal(r.quarantined[0].count, 1)
  const key = 'sync.flushQuarantine.settingsRowPutMany'
  assert.ok(meta[key], 'the quarantine meta key exists')
  const parked = JSON.parse(meta[key])
  assert.equal(parked.length, 1)
  assert.equal(parked[0].count, 1)
  assert.match(parked[0].error, /poison row/)
  assert.deepEqual(parked[0].rows, [{ key: 'dailyTomatoTarget', value: '12', updatedAt: row.updatedAt }],
    'the exact dropped row is recoverable from the quarantine')
})

test('P-2: quarantine entries cap at 50 and keep the newest (not an unbounded data store)', () => {
  const { state, meta } = quarantineState({ failOp: 'settingsRowPutMany' })
  bootstrap.__test.setState(state)
  const key = 'sync.flushQuarantine.settingsRowPutMany'
  const pre = []
  for (let i = 0; i < 55; i++) pre.push({ at: i, count: 1, error: 'e', rows: [] })
  meta[key] = JSON.stringify(pre)

  bootstrap.__test.flushPendingWrites()
  const parked = JSON.parse(meta[key])
  assert.equal(parked.length, 50, 'the list is cap-trimmed')
  assert.equal(parked[0].at, 6, 'the OLDEST entries were dropped (55 pre-existing + 1 new, trimmed to 50)')
  assert.equal(parked[49].error, 'poison row', 'the newest entry (this flush) is kept')
})

test('P-2: finalizeIngest raises a visible flush-quarantined syncEvent (log-only drop is gone)', () => {
  const { state, sent } = quarantineState({ failOp: 'settingsRowPutMany' })
  state.applied = { kinds: new Set(['setting']), conflicts: [], settingsPatch: {} }
  bootstrap.__test.setState(state)

  const r = bootstrap.__test.finalizeIngest({ appliedCount: 1 })
  assert.equal(r.flushFailed, true)
  const evt = sent.find(s => s.ch === 'syncEvent' && s.msg.type === 'flush-quarantined')
  assert.ok(evt, 'a flush-quarantined syncEvent reached the renderer channel')
  assert.deepEqual(evt.msg.ops, ['settingsRowPutMany'])
  assert.equal(evt.msg.count, 1)
  assert.equal(sent.filter(s => s.ch === 'todos-changed').length, 0,
    'no todos-changed for rows the flush dropped (P2-5 contract intact)')
})
