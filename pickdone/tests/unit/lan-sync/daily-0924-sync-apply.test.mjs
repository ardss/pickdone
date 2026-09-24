/* Daily 2026-09-24 sync-apply regressions:
 * [B13] meta LWW local age: a LIVE key whose oplog pointers were ring-buffer-trimmed used to
 *       read as age 0, letting ANY inbound peer row (even arbitrarily stale) win LWW and — via
 *       the deleteMeta hydration — even resurrect a deleted key. Now: live key + no oplog ts =
 *       the inbound row is REFUSED this round (warn), the local value stands; an ABSENT local
 *       value still first-lands with age 0 (fresh installs / new keys keep working).
 * [B16] non-todo conflict losers (plan/filter/category/setting) are no longer dropped behind a
 *       warn-only log: the losing data is serialized under a machine-local
 *       metaConflictBackup.<entity>:<id>.<ts36> key (reusing the P1-5 meta backup mechanism and
 *       its machine-local sync filter + recovery listing surface).
 * Run: node --test tests/unit/lan-sync/daily-0924-sync-apply.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const syncApply = require('../../../src/main/sync-apply.js')

function mockState (tables = {}) {
  const calls = []
  const state = {
    calls,
    deviceId: 'local-device',
    localUserId: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    db: { call (op, params) { calls.push({ op, params }); return tables[op] ? tables[op](params) : null } },
  }
  return { state, calls }
}
const opCalls = (m, op) => m.calls.filter(c => c.op === op)

test('B13: live meta key with NO oplog pointer (trimmed history) refuses the inbound row — age-0 LWW is gone', () => {
  const m = mockState({
    getMeta: k => (k === 'projectCategoryIds' ? '[3,7]' : null),
    syncOplogSince: () => [], // pointers trimmed away: local age unknown
  })
  const ok = syncApply.applyRowSafe(m.state, { entity: 'meta', id: 'projectCategoryIds', seq: 9, ts: 999, updatedAt: 999, deleted: false, deletedAt: 0, data: { key: 'projectCategoryIds', value: 'stale-peer' } })
  assert.equal(ok, false, 'age-unknown live key must NOT lose to a 0-age comparison')
  assert.equal(opCalls(m, 'setMeta').length, 0, 'no write landed for the refused row')
})

test('B13: absent local meta value still first-lands with age 0 (fresh-key path preserved)', () => {
  const m = mockState({ getMeta: () => null, syncOplogSince: () => [] })
  const ok = syncApply.applyRowSafe(m.state, { entity: 'meta', id: 'brand.new.key', seq: 9, ts: 100, updatedAt: 100, deleted: false, deletedAt: 0, data: { key: 'brand.new.key', value: 'v1' } })
  assert.equal(ok, true, 'absent local value = nothing to lose; inbound must land')
  assert.equal(opCalls(m, 'setMeta').length, 1)
})

test('B13: live key WITH an oplog pointer keeps normal LWW (newer inbound wins, older drops)', () => {
  const tables = {
    getMeta: k => (k === 'projectCategoryIds' ? 'local' : null),
    syncOplogSince: () => [{ seq: 1, entity: 'meta', entityId: 'projectCategoryIds', ts: 500 }],
  }
  const older = mockState(tables)
  assert.equal(syncApply.applyRowSafe(older.state, { entity: 'meta', id: 'projectCategoryIds', seq: 9, ts: 200, updatedAt: 200, deleted: false, deletedAt: 0, data: { key: 'projectCategoryIds', value: 'remote-older' } }), false)
  const newer = mockState(tables)
  assert.equal(syncApply.applyRowSafe(newer.state, { entity: 'meta', id: 'projectCategoryIds', seq: 9, ts: 600, updatedAt: 600, deleted: false, deletedAt: 0, data: { key: 'projectCategoryIds', value: 'remote-newer' } }), true)
  // setMeta carries BOTH the P1-5 loser backup (existing behavior) and the applied value —
  // assert the applied one landed, not just any setMeta.
  const applied = opCalls(newer, 'setMeta').find(c => c.params[0] === 'projectCategoryIds')
  assert.ok(applied, 'the winning value must be applied')
  assert.deepEqual(applied.params, ['projectCategoryIds', 'remote-newer'])
})

test('B16: a losing FILTER edit is serialized into a machine-local metaConflictBackup key', () => {
  const localRow = { id: 3, name: 'my-filter', updatedAt: 100, deleted: 0 }
  const m = mockState({
    filterList: () => [localRow],
    filterTombstones: () => [],
    listMetaKeys: () => [],
  })
  const ok = syncApply.applyRowSafe(m.state, { entity: 'filter', id: '3', seq: 9, ts: 200, updatedAt: 200, deleted: false, deletedAt: 0, data: { id: 3, name: 'peer-filter', updatedAt: 200, deleted: 0 } })
  assert.equal(ok, true, 'newer peer filter must apply (LWW)')
  const setMeta = opCalls(m, 'setMeta')
  assert.equal(setMeta.length, 1, 'the losing local content must be backed up')
  const [backupKey, payload] = setMeta[0].params
  assert.ok(String(backupKey).startsWith('metaConflictBackup.filter:3.'), 'backup key is entity-scoped and machine-local: ' + backupKey)
  const parsed = JSON.parse(payload)
  assert.equal(parsed.key, 'filter:3')
  assert.equal(parsed.value.name, 'my-filter', 'the LOSING content is preserved')
  // The backup key must stay machine-local (never sync back to the peer).
  assert.equal(syncApply.isMachineLocalMetaKey(backupKey), true, 'backup keys are filtered from sync')
})

test('B16: a losing PLAN edit is backed up the same way; identical-content losses are not', () => {
  const localRow = { id: 'p1', taskId: 't1', day: '2026-09-24', updatedAt: 100, deleted: 0 }
  const m = mockState({ planAll: () => [localRow], planTombstones: () => [], listMetaKeys: () => [] })
  const ok = syncApply.applyRowSafe(m.state, { entity: 'plan', id: 'p1', seq: 9, ts: 200, updatedAt: 200, deleted: false, deletedAt: 0, data: { id: 'p1', taskId: 't1', day: '2026-09-25', updatedAt: 200, deleted: 0 } })
  assert.equal(ok, true)
  const setMeta = opCalls(m, 'setMeta')
  assert.equal(setMeta.length, 1)
  assert.ok(String(setMeta[0].params[0]).startsWith('metaConflictBackup.plan:p1.'))

  // Identical content arriving newer is a no-op: no winner change, no conflict copy, no backup.
  // (deviceId/deleted are bookkeeping-skipped, but the inbound row must not carry any OTHER
  // content delta — and its deviceId must match the local side for the tie compare.)
  const m2 = mockState({ planAll: () => [localRow], planTombstones: () => [], listMetaKeys: () => [] })
  const ok2 = syncApply.applyRowSafe(m2.state, {
    entity: 'plan', id: 'p1', seq: 9, ts: 200, updatedAt: 200, deletedAt: 0, deviceId: 'local-device',
    deleted: false, data: { id: 'p1', taskId: 't1', day: '2026-09-24', updatedAt: 100, deleted: 0 },
  })
  assert.equal(ok2, false, 'identical content is the documented no-op')
  assert.equal(opCalls(m2, 'setMeta').length, 0, 'no backup for a no-op round')
})
