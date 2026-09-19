/* GAP-A regression tests (2026-09-19): the `meta` entity was captured into the oplog
 * (db-oplog setMeta/deleteMeta rows) but missing from SYNCABLE_ENTITIES/hydrateRow, so milestones,
 * projectCategoryIds, tomatoEstimateState etc. NEVER synced between devices. Covers:
 *   - a meta row hydrates and applies via setMeta (and lands deleteMeta on tombstone winners);
 *   - machine-local meta keys (cliTomato* runtime, sync.* bookkeeping, ...) neither egress nor ingress;
 *   - the settings/habits BLOB keys stay excluded (field-granular via the `setting` entity bridge);
 *   - LWW: a locally newer meta value stands, an older inbound row is dropped;
 *   - identical content is a no-op (no per-round echo pointer churn).
 * Run: node --test tests/unit/lan-sync/meta-entity.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const syncApply = require('../../../src/main/sync-apply.js')

/** Minimal mock state: db records every call; reads come from `tables`. */
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

function opCalls (m, op) { return m.calls.filter(c => c.op === op) }

test('meta: inbound row hydrates and applies via setMeta (GAP-A core path)', () => {
  const m = mockState({ getMeta: k => (k === 'projectCategoryIds' ? null : null), syncOplogSince: () => [] })
  const row = { entity: 'meta', id: 'projectCategoryIds', seq: 9, ts: 200, updatedAt: 200, deleted: false, deletedAt: 0, data: { key: 'projectCategoryIds', value: '[3,7]' } }
  assert.equal(syncApply.applyRowSafe(m.state, row), true, 'absent local meta: inbound row must win')
  const put = opCalls(m, 'setMeta')
  assert.equal(put.length, 1)
  assert.deepEqual(put[0].params, ['projectCategoryIds', '[3,7]'])
})

test('meta: hydrateRow turns an oplog pointer into a merge-ready row and a missing value into a tombstone', () => {
  const m = mockState({
    getMeta: k => (k === 'projectMilestones:c1' ? '[{"title":"m","date":"2026-01-01"}]' : null),
    syncOplogSince: () => [],
  })
  const live = syncApply.hydrateRow(m.state, { entity: 'meta', entityId: 'projectMilestones:c1', seq: 3, ts: 111 })
  assert.equal(live.deleted, false)
  assert.equal(live.updatedAt, 111, 'meta has no updatedAt column: pointer ts is the LWW age')
  assert.equal(live.data.value, '[{"title":"m","date":"2026-01-01"}]')
  const tomb = syncApply.hydrateRow(m.state, { entity: 'meta', entityId: 'projectStatus:c2', seq: 4, ts: 222 })
  assert.equal(tomb.deleted, true, 'value gone = deleteMeta pointer: hydrates as a tombstone')
})

test('meta: machine-local keys never egress and never ingress', () => {
  const m = mockState({ getMeta: () => '{"seq":1}', syncOplogSince: () => [] })
  for (const key of ['sync.pushCursor', 'cliTomatoState', 'cliTomatoCmd', 'todosVersion', 'firedReminders:t1', 'reminderLastSeenAt', 'settingsRows.src.db.settingsState', 'db.tomatoState', '_cliStamp']) {
    assert.equal(syncApply.hydrateRow(m.state, { entity: 'meta', entityId: key, seq: 1, ts: 100 }), null, `no egress for ${key}`)
    assert.equal(syncApply.applyRowSafe(m.state, { entity: 'meta', id: key, seq: 1, ts: 100, updatedAt: 100, deleted: false, deletedAt: 0, data: { key, value: 'x' } }), false, `no ingress for ${key}`)
  }
  assert.equal(opCalls(m, 'setMeta').length, 0)
})

test('meta: settings/habits blob keys are excluded on both sides (field-granular via `setting` entity)', () => {
  const m = mockState({ getMeta: () => '{}', syncOplogSince: () => [] })
  for (const key of ['db.settingsState', 'db.habitsState']) {
    assert.equal(syncApply.hydrateRow(m.state, { entity: 'meta', entityId: key, seq: 1, ts: 100 }), null, `no egress for blob ${key}`)
    assert.equal(syncApply.applyRowSafe(m.state, { entity: 'meta', id: key, seq: 1, ts: 100, updatedAt: 100, deleted: false, deletedAt: 0, data: { key, value: '{}' } }), false, `no ingress for blob ${key}`)
  }
})

test('meta: LWW — a locally newer value stands, an older inbound row is dropped', () => {
  // local oplog says this key was written at ts=500 with value 'local'
  const m = mockState({
    getMeta: () => 'local',
    syncOplogSince: () => [{ seq: 1, entity: 'meta', entityId: 'tomatoEstimateState', ts: 500 }],
  })
  const ok = syncApply.applyRowSafe(m.state, { entity: 'meta', id: 'tomatoEstimateState', seq: 9, ts: 200, updatedAt: 200, deleted: false, deletedAt: 0, data: { key: 'tomatoEstimateState', value: 'remote-older' } })
  assert.equal(ok, false, 'locally newer (500 > 200) must win')
  assert.equal(opCalls(m, 'setMeta').length, 0)
  // newer inbound wins
  const m2 = mockState({
    getMeta: () => 'local',
    syncOplogSince: () => [{ seq: 1, entity: 'meta', entityId: 'tomatoEstimateState', ts: 100 }],
  })
  assert.equal(syncApply.applyRowSafe(m2.state, { entity: 'meta', id: 'tomatoEstimateState', seq: 9, ts: 900, updatedAt: 900, deleted: false, deletedAt: 0, data: { key: 'tomatoEstimateState', value: 'remote-newer' } }), true)
  assert.deepEqual(opCalls(m2, 'setMeta')[0].params, ['tomatoEstimateState', 'remote-newer'])
})

test('meta: identical content is a no-op (no per-round echo pointer churn)', () => {
  const m = mockState({
    getMeta: () => 'same',
    syncOplogSince: () => [{ seq: 1, entity: 'meta', entityId: 'k', ts: 100 }],
  })
  const ok = syncApply.applyRowSafe(m.state, { entity: 'meta', id: 'k', seq: 9, ts: 100, updatedAt: 100, deleted: false, deletedAt: 0, data: { key: 'k', value: 'same' } })
  assert.equal(ok, false, 'same value must not re-apply (would re-log an oplog pointer and echo forever)')
  assert.equal(opCalls(m, 'setMeta').length, 0)
})

test('meta: delete wins over an older live local value via deleteMeta; already-deleted keys are a no-op', () => {
  // local live value, older than the inbound tombstone -> tombstone wins, deleteMeta fires
  const m = mockState({
    getMeta: () => 'old',
    syncOplogSince: () => [{ seq: 1, entity: 'meta', entityId: 'projectStatus:c1', ts: 100 }],
  })
  assert.equal(syncApply.applyRowSafe(m.state, { entity: 'meta', id: 'projectStatus:c1', seq: 9, ts: 300, updatedAt: 300, deleted: true, deletedAt: 300, data: null }), true)
  assert.deepEqual(opCalls(m, 'deleteMeta')[0].params, 'projectStatus:c1') // bare key, db.deleteMeta signature
  // key already absent locally -> re-landing the delete would re-log an echo pointer: no-op
  const m2 = mockState({ getMeta: () => null, syncOplogSince: () => [] })
  assert.equal(syncApply.applyRowSafe(m2.state, { entity: 'meta', id: 'projectStatus:c1', seq: 9, ts: 300, updatedAt: 300, deleted: true, deletedAt: 300, data: null }), false)
  assert.equal(opCalls(m2, 'deleteMeta').length, 0)
})
