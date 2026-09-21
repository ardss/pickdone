/**
 * Regression tests for the lan-sync-bootstrap apply/flush layer (driven through the __test hook
 * with a mock db.call surface):
 *   - remote tombstone winners actually land (todo via the bulk buffer, setting/tomato via their
 *     dedicated tombstone ops) — previously a tombstone winner matched no write branch and the
 *     peer's deletion never landed;
 *   - a local tombstone is not resurrected by an older remote live row (delete-wins must hold);
 *   - flushPendingWrites never silently drops a buffered batch when a bulk op throws.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { __test } = require('../../../src/main/lan-sync-bootstrap.js')

const EMPTY_TABLES = {
  getAll: () => [],
  settingsRowsAll: () => [],
  tomatoAll: () => [],
  categoriesAllRows: () => [], planTombstones: () => [], filterTombstones: () => [],
  planAll: () => [],
  filterList: () => [],
}

/** Mock state: db records every call; table read ops come from `tables`, write ops are recorded. */
function mockState(tables = {}, writeImpl = {}) {
  const calls = []
  const pendingWrites = { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] }
  const db = {
    calls,
    call (op, params) {
      calls.push({ op, params })
      if (tables[op]) return tables[op](params)
      if (writeImpl[op]) return writeImpl[op](params)
      return null
    },
  }
  const state = {
    db,
    pendingWrites,
    applyCache: null,
    engine: null,
    node: null,
    timers: [],
    peerWatermarks: new Map(),
    pendingToSeq: 0,
    getWindowSenders: () => [],
  }
  return { state, calls, pendingWrites }
}

function fresh(tables, writeImpl) {
  const m = mockState(tables, writeImpl)
  __test.setState(m.state)
  return m
}

test('bootstrap apply: ghost tombstone (unknown id, data:null) reports applied WITHOUT inserting an empty row', () => {
  // Round-3 review: the inbound pointer's row was already purged on the origin and we never had
  // the todo either — buffering an upsert here would materialize a content-empty junk row on
  // peers that never saw the task. The op counts as applied (the pull watermark advances; the
  // merge is idempotent) but NOTHING is written.
  const m = fresh({ ...EMPTY_TABLES })
  const ok = __test.applyRow({ entity: 'todo', id: 't1', seq: 7, ts: 100, deleted: true, deletedAt: 99, data: null })
  assert.equal(ok, true, 'tombstone winner must report applied (watermark advances)')
  assert.equal(m.pendingWrites.todos.length, 0, 'no empty row may be materialized for an unknown id')
  assert.equal(m.calls.find(c => c.op === 'upsertMany'), undefined)
})

test('bootstrap apply: remote todo tombstone beats an older local live row (delete-wins + conflict copy)', () => {
  // local live row updatedAt=50 vs tombstone deletedAt=99 -> delete must win and land. Round-3
  // review: the LOSING live content is materialized as a tombstoned recycle-bin copy row first
  // (suffixed id, never clobbering the winner), then the winner lands as a tombstone row.
  const m = fresh({ ...EMPTY_TABLES, getAll: () => [{ taskId: 't1', updateTime: 50, delete: false, deletedAt: 0, taskContent: 'local edit' }] })
  const ok = __test.applyRow({ entity: 'todo', id: 't1', seq: 7, ts: 100, deleted: true, deletedAt: 99, data: null })
  assert.equal(ok, true)
  assert.equal(m.pendingWrites.todos.length, 2)
  const copy = m.pendingWrites.todos[0]
  assert.equal(copy.delete, 1, 'conflict copy is tombstoned (recoverable in the recycle bin)')
  assert.match(String(copy.taskId), /^t1-conflict-/, 'conflict copy id cannot clobber the winner')
  assert.equal(copy.taskContent, 'local edit', 'the losing content is preserved in the copy')
  const winner = m.pendingWrites.todos[1]
  assert.equal(winner.taskId, 't1')
  assert.equal(winner.delete, 1)
})

test('bootstrap apply: remote setting tombstone lands via settingsRowDelete, not a resurrecting put', () => {
  // Regression: the tombstone arrives hydrated WITH data; the old code pushed it through
  // settingsRowPut, whose putRow clears `deleted` — the deletion resurrected the row.
  const m = fresh({
    ...EMPTY_TABLES,
    settingsRowsAll: () => [{ key: 'theme', value: 'dark', updatedAt: 50, deleted: false, deletedAt: 0 }],
  })
  const ok = __test.applyRow({ entity: 'setting', id: 'theme', seq: 8, ts: 100, updatedAt: 100, deleted: true, deletedAt: 100, data: { key: 'theme', value: 'dark' } })
  assert.equal(ok, true)
  const del = m.calls.find(c => c.op === 'settingsRowDelete')
  assert.ok(del, 'settingsRowDelete must be called')
  assert.deepEqual(del.params, { key: 'theme' })
  assert.equal(m.pendingWrites.settings.length, 0, 'tombstone must not go through the put buffer')
})

test('bootstrap apply: local setting tombstone is not revived by an older remote live row', () => {
  // Regression: localRow skipped tombstones, so merge saw "missing local" and the remote stale
  // active row won, resurrecting the locally deleted setting.
  const m = fresh({
    ...EMPTY_TABLES,
    settingsRowsAll: () => [{ key: 'theme', value: 'dark', updatedAt: 10, deleted: true, deletedAt: 100 }],
  })
  const ok = __test.applyRow({ entity: 'setting', id: 'theme', seq: 3, ts: 50, updatedAt: 50, deleted: false, deletedAt: 0, data: { key: 'theme', value: 'dark' } })
  assert.equal(ok, false, 'local tombstone (deletedAt 100) must beat remote live (updatedAt 50)')
  assert.equal(m.pendingWrites.settings.length, 0)
  assert.equal(m.calls.find(c => c.op === 'settingsRowDelete'), undefined)
})

test('bootstrap apply: remote tomato tombstone lands via tomatoRemoveByIds', () => {
  const m = fresh({ ...EMPTY_TABLES })
  const ok = __test.applyRow({ entity: 'tomato', id: 'tm1', seq: 4, ts: 10, deleted: true, deletedAt: 9, data: null })
  assert.equal(ok, true)
  const del = m.calls.find(c => c.op === 'tomatoRemoveByIds')
  assert.ok(del, 'tomatoRemoveByIds must be called')
  assert.deepEqual(del.params, ['tm1'])
  assert.equal(m.pendingWrites.tomatoes.length, 0)
})

test('bootstrap flush: per-buffer isolation — a failing bulk op drops ONLY its segment, others still flush', () => {
  // Round-3 review: one malformed row used to throw out of a single bulk op and leave every
  // buffer dirty — the throw re-fired on every later flush, wedging apply AND flush forever.
  // Now each buffer op gets its own try/catch: the failing segment is dropped + logged (the rows
  // stay recoverable via a later snapshot), the buffers clear, and the other ops proceed.
  const m = fresh(
    { ...EMPTY_TABLES },
    { upsertMany: () => { throw new Error('disk full') } },
  )
  m.pendingWrites.todos.push({ taskId: 't1', taskContent: 'hello' })
  m.pendingWrites.settings.push({ key: 'k', value: 'v' })
  m.pendingWrites.tomatoes.push({ tomatoId: 'tm1' })
  __test.flushPendingWrites() // must NOT throw
  assert.equal(m.pendingWrites.todos.length, 0, 'failing segment is dropped, not re-wedged')
  assert.equal(m.pendingWrites.settings.length, 0, 'healthy segments still clear (they flushed)')
  assert.equal(m.pendingWrites.tomatoes.length, 0)
  assert.ok(m.calls.some(c => c.op === 'settingsRowPutMany'), 'settings flush was attempted after the todo failure')
  assert.ok(m.calls.some(c => c.op === 'tomatoAppendMany'), 'tomato flush was attempted after the todo failure')
})

test('bootstrap apply: plan live-row edit APPLIES with a known older local age (F3a — ageUnknown gate removed)', () => {
  // F3a (2026-09-20): planAll now SELECTs updatedAt, so the local age is KNOWN and the old
  // ageUnknown refusal (which silently dropped every peer edit for an existing chip) is gone.
  // A peer's newer edit must win; a legacy pre-fix row (updatedAt 0) loses to any ts > 0.
  const m = fresh({ ...EMPTY_TABLES, planAll: () => [{ id: 'p1', taskId: 't1', day: '2026-09-18', mm: '09:00', updatedAt: 100 }] })
  const ok = __test.applyRow({ entity: 'plan', id: 'p1', seq: 9, ts: 200, updatedAt: 200, deleted: false, deletedAt: 0, data: { id: 'p1', taskId: 't1', day: '2026-09-19', mm: '10:00', updatedAt: 200 } })
  assert.equal(ok, true, 'newer peer edit must be applied (known ages, remote wins)')
  assert.equal(m.pendingWrites.plans.length, 1)
  assert.equal(m.pendingWrites.plans[0].day, '2026-09-19')
})

test('bootstrap apply: plan TOMBSTONE still lands through the cross-domain guard', () => {
  const m = fresh({ ...EMPTY_TABLES, planAll: () => [{ id: 'p1', taskId: 't1', day: '2026-09-18', mm: '09:00' }] })
  const ok = __test.applyRow({ entity: 'plan', id: 'p1', seq: 9, ts: 200, deleted: true, deletedAt: 200, data: null })
  assert.equal(ok, true, 'tombstone must land even when local age is unknown')
  const del = m.calls.find(c => c.op === 'planRemoveIds')
  assert.ok(del, 'planRemoveIds must be called')
  // R7 P1-2: the landing carries the winner's tombstone stamps (id readable as before)
  const arg = del.params && del.params[0]
  const landed = arg && typeof arg === 'object' ? arg : { id: arg }
  assert.equal(String(landed.id), 'p1')
  assert.equal(Number(landed.deletedAt), 200, 'winner deletedAt must survive the hop (no local re-stamp)')
})

test('bootstrap apply: filter live-row edit APPLIES with a known older local age (F3b — ageUnknown gate removed)', () => {
  // F3b (2026-09-20): filterList now exposes updatedAt — a peer's newer rename applies.
  const m = fresh({ ...EMPTY_TABLES, filterList: () => [{ id: 5, name: 'work', conds: {}, sort: 0, updatedAt: 100 }] })
  const ok = __test.applyRow({ entity: 'filter', id: '5', seq: 9, ts: 200, updatedAt: 200, deleted: false, deletedAt: 0, data: { id: 5, name: 'renamed', conds: {}, sort: 0, updatedAt: 200 } })
  assert.equal(ok, true)
  assert.equal(m.pendingWrites.filters.length, 1)
  assert.equal(m.pendingWrites.filters[0].name, 'renamed')
})

test('bootstrap apply: inbound ts >10min in the future is clamped to now and loses to a current local row (clock-skew clamp)', () => {
  // Regression: a skewed peer clock (ts = now + 1h) permanently won every future LWW conflict.
  // The clamp pulls the comparison key back to `now`, so a local row written at now wins.
  const now = Date.now()
  // Local row written 2s AHEAD of the captured `now` (well inside any sane clock) so it reliably
  // beats the clamped inbound row (which lands at apply-time `now`).
  const m = fresh({
    ...EMPTY_TABLES,
    getAll: () => [{ taskId: 't1', updateTime: now + 2000, delete: false, deletedAt: 0 }],
  })
  const ok = __test.applyRow({
    entity: 'todo', id: 't1', seq: 11, ts: now + 3600 * 1000,
    updatedAt: now + 3600 * 1000, deleted: false, deletedAt: 0,
    data: { taskId: 't1', taskContent: 'from the future', updateTime: now + 3600 * 1000 },
  })
  assert.equal(ok, false, 'clamped inbound row (now) loses to local row (now, equal ts + seq tiebreak... local wins as incumbent)')
  assert.equal(m.pendingWrites.todos.length, 0, 'no future-stamped write may land')
  // And the payload of a WINNING clamped row is untouched: on a fresh local table the clamped
  // row still lands, with the ORIGINAL payload data (only the comparison key changed).
  const m2 = fresh({ ...EMPTY_TABLES })
  const ok2 = __test.applyRow({
    entity: 'todo', id: 't2', seq: 12, ts: now + 3600 * 1000,
    updatedAt: now + 3600 * 1000, deleted: false, deletedAt: 0,
    data: { taskId: 't2', taskContent: 'future content', updateTime: now + 3600 * 1000 },
  })
  assert.equal(ok2, true, 'clamped row still applies when there is no local counterpart')
  const landed = m2.pendingWrites.todos[0]
  assert.equal(landed.taskContent, 'future content', 'payload semantics are never mutated by the clamp')
})

test('bootstrap apply: clamp BOUNDARY — exactly now+10min is NOT clamped (strict >), +1ms is', () => {
  // The guard is `updatedAt > now + 10min`: a row stamped EXACTLY at the tolerance edge is
  // inside the tolerance and must keep its (winning) future timestamp; one millisecond past
  // the edge must be clamped back to now and lose. The clock is FROZEN for the duration so
  // the boundary is exact (clampSkew reads Date.now() internally — a live clock makes "+1ms"
  // race the tester's own capture of `now`).
  const realNow = Date.now
  const t = realNow()
  const boundary = t + 10 * 60 * 1000
  Date.now = () => t
  try {
    // (a) exactly AT the boundary: no clamp -> the inbound row beats a local `t` row.
    fresh({
      ...EMPTY_TABLES,
      getAll: () => [{ taskId: 't1', updateTime: t, delete: false, deletedAt: 0 }],
    })
    const ok = __test.applyRow({
      entity: 'todo', id: 't1', seq: 21, ts: boundary,
      updatedAt: boundary, deleted: false, deletedAt: 0,
      data: { taskId: 't1', taskContent: 'edge is tolerated' },
    })
    assert.equal(ok, true, 'exactly now+10min is NOT clamped (strict >): the remote row wins LWW')

    // (b) one ms PAST the boundary: clamped to now (= t, < boundary) -> loses to a local
    // row stamped at the boundary itself.
    const m2 = fresh({
      ...EMPTY_TABLES,
      getAll: () => [{ taskId: 't1', updateTime: boundary, delete: false, deletedAt: 0 }],
    })
    const ok2 = __test.applyRow({
      entity: 'todo', id: 't1', seq: 22, ts: boundary + 1,
      updatedAt: boundary + 1, deleted: false, deletedAt: 0,
      data: { taskId: 't1', taskContent: 'one ms too far' },
    })
    assert.equal(ok2, false, 'now+10min+1ms IS clamped to now and loses to the local boundary row')
    assert.equal(m2.pendingWrites.todos.length, 0, 'no over-the-edge future write may land')
  } finally {
    Date.now = realNow
  }
})

test('bootstrap flush: a fully committed buffer is cleared', () => {
  const m = fresh({ ...EMPTY_TABLES })
  m.pendingWrites.todos.push({ taskId: 't1', taskContent: 'hello' })
  m.pendingWrites.settings.push({ key: 'k', value: 'v' })
  __test.flushPendingWrites()
  assert.equal(m.pendingWrites.todos.length, 0)
  assert.equal(m.pendingWrites.settings.length, 0)
})

/* ---------- 2026-09-18: category/plan/filter bulk apply path ---------- */

test('bootstrap apply: category/plan/filter live rows are bulk-buffered, not committed per row', () => {
  // Regression (2026-09-18): upsertCategory/filterUpsert committed one transaction per applied
  // row — a first-sync snapshot with hundreds of them starved the round past any sane budget.
  const m = fresh({ ...EMPTY_TABLES })
  const okCat = __test.applyRow({ entity: 'category', id: 'c1', seq: 1, ts: 10, updatedAt: 10, deleted: false, deletedAt: 0, data: { categoryId: 'c1', name: 'Work', color: '#fff' } })
  const okPlan = __test.applyRow({ entity: 'plan', id: 'p9', seq: 2, ts: 20, updatedAt: 20, deleted: false, deletedAt: 0, data: { id: 'p9', taskId: 't1', day: '2026-09-18', mm: '09:00' } })
  const okFilter = __test.applyRow({ entity: 'filter', id: '4', seq: 3, ts: 30, updatedAt: 30, deleted: false, deletedAt: 0, data: { id: 4, name: 'work', conds: {}, sort: 0 } })
  assert.equal(okCat, true)
  assert.equal(okPlan, true)
  assert.equal(okFilter, true)
  assert.equal(m.pendingWrites.categories.length, 1)
  assert.equal(m.pendingWrites.categories[0].id, 'c1')
  assert.equal(m.pendingWrites.plans.length, 1)
  assert.equal(m.pendingWrites.plans[0].taskId, 't1')
  assert.equal(m.pendingWrites.filters.length, 1)
  assert.equal(m.pendingWrites.filters[0].id, 4)
  // Nothing was committed directly during apply.
  assert.equal(m.calls.find(c => c.op === 'upsertCategory'), undefined)
  assert.equal(m.calls.find(c => c.op === 'filterUpsert'), undefined)
  assert.equal(m.calls.find(c => c.op === 'planAddMany'), undefined)
})

test('bootstrap flush: bulk-buffered categories/plans/filters land through their bulk ops', () => {
  const m = fresh(
    { ...EMPTY_TABLES },
    {
      upsertCategoryMany: list => { bulkOps.push(['upsertCategoryMany', list]); return list.map(c => c.id) },
      planAddMany: list => { bulkOps.push(['planAddMany', list]); return list.map(c => c.id) },
      filterUpsertMany: list => { bulkOps.push(['filterUpsertMany', list]); return list.map(c => c.id) },
    },
  )
  const bulkOps = []
  m.pendingWrites.categories.push({ id: 'c1', name: 'Work' })
  m.pendingWrites.plans.push({ id: 'p1', taskId: 't1', day: '2026-09-18', mm: '09:00' })
  m.pendingWrites.filters.push({ id: 4, name: 'work', conds: {}, sort: 0 })
  __test.flushPendingWrites()
  assert.deepEqual(bulkOps.map(b => b[0]), ['upsertCategoryMany', 'planAddMany', 'filterUpsertMany'])
  assert.equal(m.pendingWrites.categories.length, 0)
  assert.equal(m.pendingWrites.plans.length, 0)
  assert.equal(m.pendingWrites.filters.length, 0)
})

/* ---------- round-3 hardening: skew payload normalization ---------- */

test('bootstrap apply: a SKEWED WINNER stores payload timestamps normalized to <= now', () => {
  // The comparison keys are clamped (see the boundary test above); round-3 review: the PAYLOAD
  // fields written to disk must be normalized too, or the clamped-arrival winner keeps a future
  // updateTime on disk and later silently reverts the local user's real newer edit.
  const now = Date.now()
  const m = fresh({ ...EMPTY_TABLES })
  const ok = __test.applyRow({
    entity: 'todo', id: 't1', seq: 30, ts: now + 3600 * 1000,
    updatedAt: now + 3600 * 1000, deleted: false, deletedAt: 0,
    data: { taskId: 't1', taskContent: 'from the future', updateTime: now + 3600 * 1000, deletedAt: 0 },
  })
  assert.equal(ok, true)
  const landed = m.pendingWrites.todos[0]
  assert.ok(landed.updateTime <= now + 50, `stored updateTime must be <= now (got ${landed.updateTime - now}ms in the future)`)
  assert.equal(landed.taskContent, 'from the future')
})

test('bootstrap apply: a local newer edit survives a stale skewed re-push (no silent revert)', () => {
  // Scenario behind the payload clamp: the skewed row landed earlier (clamped), the local user
  // then edited at now+2s; the stale skewed row is re-pushed verbatim — it must LOSE.
  const now = Date.now()
  const m = fresh({
    ...EMPTY_TABLES,
    getAll: () => [{ taskId: 't1', updateTime: now + 2000, delete: false, deletedAt: 0, taskContent: 'real local edit' }],
  })
  const ok = __test.applyRow({
    entity: 'todo', id: 't1', seq: 31, ts: now + 3600 * 1000,
    updatedAt: now + 3600 * 1000, deleted: false, deletedAt: 0,
    data: { taskId: 't1', taskContent: 'stale skewed copy', updateTime: now + 3600 * 1000 },
  })
  assert.equal(ok, false, 'the clamped stale row loses to the newer local edit')
  assert.equal(m.pendingWrites.todos.length, 0)
})

/* ---------- round-3 hardening: securityLock* exclusion (egress + ingress) ---------- */

test('bootstrap apply: securityLock* settings NEVER ingress (password ciphertext is strictly local)', () => {
  const syncApply = require('../../../src/main/sync-apply.js')
  const m = fresh({
    ...EMPTY_TABLES,
    settingsRowsAll: () => [{ key: 'securityLockHash', value: 'bcrypt$', updatedAt: 1, deleted: false, deletedAt: 0 }],
  })
  const ok = __test.applyRow({ entity: 'setting', id: 'securityLockHash', seq: 40, ts: 500, updatedAt: 500, deleted: false, deletedAt: 0, data: { key: 'securityLockHash', value: 'attacker' } })
  assert.equal(ok, false, 'a securityLock* write from a peer must be refused')
  assert.equal(m.pendingWrites.settings.length, 0)
  assert.ok(syncApply.SECURITY_LOCK_KEY.test('securityLockHash'))
  assert.ok(syncApply.SECURITY_LOCK_KEY.test('securityLockQuestion'))
})

test('bootstrap hydrate: securityLock* settings rows never egress (hydrateRow returns null)', () => {
  const syncApply = require('../../../src/main/sync-apply.js')
  const state = { db: { call: (op) => op === 'settingsRowsAll'
    ? [{ key: 'securityLockHash', value: 'secret', updatedAt: 5, deleted: false, deletedAt: 0 }, { key: 'theme', value: 'dark', updatedAt: 6, deleted: false, deletedAt: 0 }]
    : null } }
  const cache = syncApply.createHydrationCache(state)
  assert.equal(syncApply.hydrateRow(state, { entity: 'setting', entityId: 'securityLockHash', seq: 1, ts: 1 }, cache), null, 'securityLock row is filtered from egress')
  const ok = syncApply.hydrateRow(state, { entity: 'setting', entityId: 'theme', seq: 2, ts: 2 }, cache)
  assert.ok(ok && ok.data && ok.data.key === 'theme', 'ordinary settings still hydrate')
})

/* ---------- round-3 hardening: userId normalization + diff exclusion ---------- */

test('bootstrap apply: inbound todo rows land with the LOCAL userId, never the peer\'s', () => {
  const m = fresh({
    ...EMPTY_TABLES,
    getAll: () => [{ taskId: 'existing', userId: 555000 }],
  })
  const ok = __test.applyRow({ entity: 'todo', id: 't1', seq: 50, ts: 100, updatedAt: 100, deleted: false, deletedAt: 0, data: { taskId: 't1', taskContent: 'x', updateTime: 100, userId: 999999 } })
  assert.equal(ok, true)
  assert.equal(m.pendingWrites.todos[0].userId, 555000, 'the local account id wins (read from local todos)')
})

test('rowContentDiffers: a userId-only difference is NOT a content change (no apply/push ping-pong)', () => {
  const syncApply = require('../../../src/main/sync-apply.js')
  assert.equal(syncApply.rowContentDiffers({ taskContent: 'same', userId: 1 }, { taskContent: 'same', userId: 2 }), false)
  assert.equal(syncApply.rowContentDiffers({ taskContent: 'same' }, { taskContent: 'same' }), false)
  assert.equal(syncApply.rowContentDiffers({ taskContent: 'a' }, { taskContent: 'b' }), true)
})

/* ---------- round-3 hardening: conflict-copy skip rules ---------- */

test('bootstrap apply: identical-content conflict produces NO conflict copy (no recycle-bin spam)', () => {
  // Both rows carry the same content: merge picks a winner, rowContentDiffers says no-op -> no
  // write, and in particular no -conflict- copy row.
  const now = Date.now()
  const m = fresh({
    ...EMPTY_TABLES,
    getAll: () => [{ taskId: 't1', updateTime: now, delete: false, deletedAt: 0, taskContent: 'same' }],
  })
  const ok = __test.applyRow({ entity: 'todo', id: 't1', seq: 60, ts: now, updatedAt: now, deleted: false, deletedAt: 0, data: { taskId: 't1', taskContent: 'same', updateTime: now, delete: false, deletedAt: 0 } })
  assert.equal(ok, false, 'identical content is a no-op')
  assert.equal(m.pendingWrites.todos.length, 0, 'no copy row for identical content')
})

test('bootstrap apply: a pure-tombstone loser produces NO conflict copy', () => {
  // Local row is ALREADY deleted (older): the inbound newer tombstone wins; a tombstone has no
  // content worth copying, so only the winner lands (idempotent).
  const m = fresh({
    ...EMPTY_TABLES,
    getAll: () => [{ taskId: 't1', updateTime: 50, delete: true, deletedAt: 60, taskContent: 'gone' }],
  })
  const ok = __test.applyRow({ entity: 'todo', id: 't1', seq: 61, ts: 100, deleted: true, deletedAt: 99, data: null })
  assert.equal(ok, true)
  const copies = m.pendingWrites.todos.filter(r => String(r.taskId).includes('-conflict-'))
  assert.equal(copies.length, 0, 'no copy for a pure tombstone loser')
})
