/**
 * F4 P3 (2026-10-18) regression test — planAddMany id-collision lookup hoisted out of the loop:
 * `taken` used to re-run db.prepare('SELECT 1 FROM plan_chips WHERE id = ?') for every mint and
 * every collision retry; the statement is now prepared exactly ONCE per call. Behavior (unique
 * ids, accepted/rejected shape) must be unchanged.
 * Run: node --test tests/unit/main/db-plan-ops-mint-prepare.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const Database = require_('../../../vendor/better-sqlite3-multiple-ciphers')
const planOps = require_('../../../src/main/db-plan-ops.js')

function freshDb () {
  const d = new Database(':memory:')
  d.exec(`CREATE TABLE plan_chips (
    id TEXT PRIMARY KEY, taskId TEXT, day TEXT, mm TEXT, sort INTEGER DEFAULT 0,
    deleted INTEGER DEFAULT 0, deletedAt INTEGER DEFAULT 0, updatedAt INTEGER DEFAULT 0)`)
  return d
}

test('planAddMany prepares the collision-lookup SELECT exactly once per call', () => {
  const d = freshDb()
  const origPrepare = d.prepare.bind(d)
  let selectPrepares = 0
  d.prepare = sql => {
    if (String(sql).includes('SELECT 1 FROM plan_chips WHERE id = ?')) selectPrepares++
    return origPrepare(sql)
  }
  const chips = []
  for (let i = 0; i < 25; i++) chips.push({ taskId: 't' + i, day: '2026-10-18', mm: '09:00', sort: i })
  const accepted = planOps.planAddMany(d, chips)
  assert.equal(accepted.length, 25)
  assert.equal(new Set(accepted).size, 25, 'minted ids are unique')
  assert.equal(selectPrepares, 1, `the collision SELECT is prepared once, not per mint (was 25+ before the fix; got ${selectPrepares})`)
})

test('planAddMany collision path: pre-existing id is re-minted and the explicit id upserts idempotently', () => {
  const d = freshDb()
  planOps.planAddMany(d, [{ id: 'pl_existing', taskId: 't0', day: '2026-10-18', mm: '09:00' }])
  const accepted = planOps.planAddMany(d, [
    { id: 'pl_existing', taskId: 't0', day: '2026-10-18', mm: '09:00' }, // explicit id → idempotent upsert
    { taskId: 't1', day: '2026-10-18', mm: '10:30' }, // minted fresh
    { taskId: 't2', day: 'bad-day', mm: '99:99' }, // invalid → rejected
  ])
  assert.equal(accepted.length, 2)
  assert.ok(accepted.includes('pl_existing'))
  assert.equal(d.prepare('SELECT count(*) AS n FROM plan_chips').get().n, 2, 'no phantom third row for the rejected chip')
})

test('planAddMany rejected payload rides the accepted array (unchanged contract)', () => {
  const d = freshDb()
  const accepted = planOps.planAddMany(d, [{ taskId: '', day: '2026-10-18', mm: '09:00' }])
  assert.equal(accepted.length, 0)
  assert.equal(accepted.rejected.length, 1)
  assert.match(accepted.rejected[0].reason, /invalid chip/)
})
