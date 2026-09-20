/* M4/M5 regression tests (sync-verify round, 2026-09-20):
 *   M4  snowDedup:<task>:<key> meta keys are machine-local bookkeeping — they neither egress nor
 *       ingress (they used to sync as junk and fight between peers every round).
 *   M5  gamification.* meta keys are counters, not documents: a losing LWW overwrite must NOT
 *       mint a metaConflictBackup.* copy and must NOT raise a conflict toast entry.
 * Run: node --test tests/unit/lan-sync/sync-verify-20260920.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const syncApply = require('../../../src/main/sync-apply.js')

function metaState (meta, oplog) {
  const calls = []
  return {
    state: {
      deviceId: 'd', localUserId: null, applied: null,
      pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
      db: { call (op, p) {
        calls.push({ op, p })
        if (op === 'getMeta') return meta[p]
        if (op === 'setMeta') { const [k, v] = p; meta[k] = v }
        if (op === 'deleteMeta') delete meta[p]
        if (op === 'listMetaKeys') return Object.keys(meta)
        if (op === 'syncOplogSince') return oplog
        return null
      } },
    },
    calls,
  }
}

/* ---------- M4: snowDedup keys are machine-local ---------- */

test('M4: snowDedup:<task>:<key> is classified machine-local (no egress, no ingress)', () => {
  assert.equal(syncApply.isMachineLocalMetaKey('snowDedup:task123:work'), true)
  assert.equal(syncApply.isMachineLocalMetaKey('snowDedup:t:k:extra'), true)
  // Non-matching keys stay syncable (the filter must not over-reach).
  assert.equal(syncApply.isMachineLocalMetaKey('projectMilestones:42'), false)
  assert.equal(syncApply.isMachineLocalMetaKey('snowDedupX'), false)
})

test('M4: a snowDedup meta row never hydrates for egress and never applies on ingress', () => {
  const { state } = metaState({ 'snowDedup:t9:focus': '1710000000000' }, [])
  assert.equal(syncApply.hydrateRow(state, { entity: 'meta', entityId: 'snowDedup:t9:focus', seq: 1, ts: 10 }), null, 'never egresses')
  const r = syncApply.applyRowSafe(state, { entity: 'meta', id: 'snowDedup:t9:focus', seq: 2, ts: 20, updatedAt: 20, deleted: false, deletedAt: 0, data: { key: 'snowDedup:t9:focus', value: '999' } })
  assert.equal(r, false, 'never ingresses')
})

/* ---------- M5: gamification.* losses are silent bookkeeping ---------- */

test('M5: a losing gamification.* overwrite writes NO backup key and raises NO conflict entry', () => {
  const meta = { 'gamification.delta.index': '{"done":1}' }
  const { state } = metaState(meta, [{ seq: 1, entity: 'meta', entityId: 'gamification.delta.index', ts: 100 }])
  const r = syncApply.applyRowSafe(state, { entity: 'meta', id: 'gamification.delta.index', seq: 9, ts: 900, updatedAt: 900, deleted: false, deletedAt: 0, data: { key: 'gamification.delta.index', value: '{"done":2}' } })
  assert.equal(r, true, 'the newer counter value still wins (plain LWW)')
  assert.equal(meta['gamification.delta.index'], '{"done":2}')
  assert.ok(!Object.keys(meta).some(k => k.startsWith('metaConflictBackup.')), 'no metaConflictBackup copy for a counter key')
  const round = syncApply.consumeAppliedRound(state)
  assert.deepEqual(round.conflicts, [], 'no conflict toast entry for bookkeeping churn')
})

test('M5: a losing DOCUMENT meta key still gets the backup + conflict toast (control)', () => {
  const meta = { 'projectMilestones:42': 'local-older' }
  const { state } = metaState(meta, [{ seq: 1, entity: 'meta', entityId: 'projectMilestones:42', ts: 100 }])
  const r = syncApply.applyRowSafe(state, { entity: 'meta', id: 'projectMilestones:42', seq: 9, ts: 900, updatedAt: 900, deleted: false, deletedAt: 0, data: { key: 'projectMilestones:42', value: 'remote-newer' } })
  assert.equal(r, true)
  assert.ok(Object.keys(meta).some(k => k.startsWith('metaConflictBackup.projectMilestones:42.')), 'documents keep the recoverable backup')
  const round = syncApply.consumeAppliedRound(state)
  assert.equal(round.conflicts.length, 1, 'document losses still toast')
})
