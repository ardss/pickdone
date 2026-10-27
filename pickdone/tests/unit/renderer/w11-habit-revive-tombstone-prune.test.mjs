/**
 * W11 renderer fixes (2026-10-26) — habit un-delete survival + targeted revive.
 *
 * Covered:
 *   W11-1 (sync layer) the W10 force-restore tombstone prune was LOCAL-ONLY: every inbound
 *         boundary does mergeHabitTombstones — a union that only ADDS — so in any multi-device
 *         setup a peer's fold round carrying fields.deleted:[X] re-infected the tombstone and
 *         silently re-deleted the just-undone habit. applyExternal / applyExternalPatch /
 *         non-force replaceAll now prune tombstones whose id arrives ALIVE in the inbound
 *         arrays with deletedAt predating the inbound round's savedAt (the round postdates the
 *         delete → the delete was undone upstream). Ids NOT present inbound keep full
 *         stickiness.
 *   W11-2 (silent data loss) the W10 delete-undo force-restored the WHOLE blob, rolling back
 *         and re-persisting every interleaved edit made during the toast window. New targeted
 *         mutations reviveHabit / reviveMoment splice ONLY the deleted entry back and clear
 *         its tombstone; HabitView's undo routes through them.
 *
 * Run: node --test tests/unit/renderer/w11-habit-revive-tombstone-prune.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

/* Stand up the store-module globals the same way w10-habitview-undo-force does */
const LS = {}
globalThis.localStorage = {
  getItem: k => (k in LS ? LS[k] : null),
  setItem: (k, v) => { LS[k] = String(v) },
  removeItem: k => { delete LS[k] }
}
globalThis.window = {
  location: { hash: '' }
  // no todoAPI.dbCall: persist() takes its silent no-DB branch in this environment
}
const mod = await import('../../../renderer/js/store/habits.js')
const habits = mod.default

const mkState = () => ({ habits: [], moments: [], savedAt: 0, deleted: [], deletedMoments: [] })

/* (a) applyExternal: tombstone for X (deletedAt older than the inbound round) + X present alive
 * inbound → X survives; the tombstone STAYS pruned (does not come back via the peer's deleted). */
test('W11-1a: applyExternal prunes a tombstone superseded by a newer inbound alive row', () => {
  const state = mkState()
  state.savedAt = 100
  state.deleted = [{ id: 'h-undone', deletedAt: 150 }] // undo happened upstream before 300
  state.habits = [{ id: 'h-other', records: {} }]
  habits.mutations.applyExternal(state, {
    habits: [{ id: 'h-undone', records: {}, name: 'revived' }, { id: 'h-other', records: {} }],
    moments: [],
    savedAt: 300,
    deleted: [{ id: 'h-undone', deletedAt: 150 }] // peer round re-carries the stale tombstone
  })
  const ids = state.habits.map(h => h.id)
  assert.ok(ids.includes('h-undone'), 'the just-undone habit must survive the peer round')
  assert.equal(state.deleted.find(t => t.id === 'h-undone'), undefined,
    'the re-infected tombstone must be pruned — otherwise applyHabitTombstones re-deletes it next round')
  assert.ok(state.deleted.find(t => t.id === 'h-undone') === undefined && ids.includes('h-other'))
})

/* (b) tombstone for an id NOT present inbound keeps full stickiness */
test('W11-1b: a tombstone whose id is absent inbound stays sticky', () => {
  const state = mkState()
  state.savedAt = 100
  state.deleted = [{ id: 'h-deleted-locally', deletedAt: 150 }]
  habits.mutations.applyExternal(state, {
    habits: [{ id: 'h-other', records: {} }],
    moments: [],
    savedAt: 300,
    deleted: []
  })
  assert.ok(state.deleted.find(t => t.id === 'h-deleted-locally'), 'absent inbound → tombstone untouched')
  assert.equal(state.habits.length, 1, 'and the inbound array still filters nothing for it')
})

/* (b2) applyExternalPatch: a peer fold round carrying fields.deleted for a just-undone id
 * must not re-infect — the W11 prune runs on the LAN fold channel too. */
test('W11-1b2: applyExternalPatch prune survives a peer fold round re-carrying fields.deleted', () => {
  const state = mkState()
  state.savedAt = 200
  state.habits = [{ id: 'h-revived', records: {}, name: 'undone upstream' }]
  state.deleted = []
  habits.mutations.applyExternalPatch(state, {
    fields: {
      habits: [{ id: 'h-revived', records: {}, name: 'undone upstream' }],
      deleted: [{ id: 'h-revived', deletedAt: 150 }]
    },
    savedAt: 300
  })
  assert.ok(state.habits.some(h => h.id === 'h-revived'), 'the revived habit must not be re-deleted by the peer fold round')
  assert.equal(state.deleted.find(t => t.id === 'h-revived'), undefined, 'the re-infected tombstone is pruned')
})

/* (c) reviveHabit splices ONLY the deleted habit back — interleaved edits on OTHER habits
 * survive (the W10 whole-blob force-restore rolled them back and re-persisted the rollback). */
test('W11-2c: reviveHabit leaves interleaved edits on other habits untouched', () => {
  const state = mkState()
  state.habits = [{ id: 'h-keep', records: {}, name: 'original' }]
  state.habits = [state.habits[0]]
  habits.mutations.delHabit(state, 'h-del')
  state.habits.push({ id: 'h-del', records: {}, name: 'deleted' }) // simulate the entry before delete
  habits.mutations.delHabit(state, 'h-del')
  // interleaved edits during the toast window:
  state.habits[0].name = 'renamed-while-toast-open'
  habits.mutations.toggleCheck(state, { id: 'h-keep', day: '2026-10-26' })
  state.moments.push({ id: 'm-new', name: 'new moment', date: '2026-10-26', kind: 'countdown' })
  const checkedRecords = { ...state.habits[0].records }
  habits.mutations.reviveHabit(state, { habit: { id: 'h-del', name: 'deleted', records: {} } })
  assert.equal(state.habits.length, 2, 'only the deleted entry is spliced back')
  assert.equal(state.habits.find(h => h.id === 'h-keep').name, 'renamed-while-toast-open', 'interleaved rename NOT rolled back')
  assert.deepEqual(state.habits.find(h => h.id === 'h-keep').records, checkedRecords, 'interleaved check-in NOT rolled back')
  assert.ok(state.moments.some(m => m.id === 'm-new'), 'interleaved moment NOT rolled back')
  assert.ok(state.habits.some(h => h.id === 'h-del'), 'the deleted habit is back')
  assert.equal(state.deleted.find(t => t.id === 'h-del'), undefined, 'its tombstone is cleared')
  assert.ok(LS.habitsState, 'revive persists (LS carries the merged state, not the pre-toast blob)')
  const persisted = JSON.parse(LS.habitsState)
  assert.ok(persisted.habits.some(h => h.id === 'h-del') && persisted.habits.some(h => h.id === 'h-keep'))
})

/* (d) reviveMoment prunes its tombstone (and defensively the habit-tombstone list too) */
test('W11-2d: reviveMoment re-inserts the moment and prunes its tombstone', () => {
  const state = mkState()
  state.moments = [{ id: 'm-1', name: 'keep', date: '2026-01-01', kind: 'memorial' }]
  habits.mutations.delMoment(state, 'm-del')
  assert.equal(state.moments.some(m => m.id === 'm-del'), false)
  habits.mutations.reviveMoment(state, { moment: { id: 'm-del', name: 'back', date: '2026-02-02', kind: 'countdown' } })
  assert.ok(state.moments.some(m => m.id === 'm-del'))
  assert.equal(state.deletedMoments.find(t => t.id === 'm-del'), undefined)
  assert.equal(state.deleted.find(t => t.id === 'm-del'), undefined, 'defensive: habit-tombstone list is id-matched too')
})

/* (d2) idempotent: reviving an id that already reappeared (peer sync) keeps the live row */
test('W11-2d2: reviveHabit does not duplicate an id that already reappeared', () => {
  const state = mkState()
  state.habits = [{ id: 'h-x', name: 'live-from-peer', records: {} }]
  state.deleted = [{ id: 'h-x', deletedAt: 10 }]
  habits.mutations.reviveHabit(state, { habit: { id: 'h-x', name: 'stale-snapshot', records: {} } })
  assert.equal(state.habits.filter(h => h.id === 'h-x').length, 1, 'no duplicate')
  assert.equal(state.habits[0].name, 'live-from-peer', 'the live row outranks the snapshot copy')
  assert.equal(state.deleted.length, 0, 'tombstone still cleared')
})

/* (e) replaceAll NON-force prunes stale tombstones for inbound-present ids (deletedAt <
 * blob.savedAt) but keeps tombstones for ids absent from the inbound blob. */
test('W11-1e: non-force replaceAll prunes superseded tombstones, keeps absent-id stickiness', () => {
  const state = mkState()
  state.savedAt = 100
  state.deleted = [
    { id: 'h-superseded', deletedAt: 150 }, // delete pre-dates the inbound round → undone upstream
    { id: 'h-absent', deletedAt: 150 } // id not in the inbound blob → must stay sticky
  ]
  habits.mutations.replaceAll(state, {
    schemaV: 1,
    habits: [{ id: 'h-superseded', records: {}, name: 'alive upstream' }],
    moments: [],
    savedAt: 300
    // no force: a plain newer inbound restore round
  })
  assert.ok(state.habits.some(h => h.id === 'h-superseded'), 'the alive inbound row is NOT tombstone-filtered')
  assert.equal(state.deleted.find(t => t.id === 'h-superseded'), undefined, 'its stale tombstone is pruned')
  assert.ok(state.deleted.find(t => t.id === 'h-absent'), 'absent-id tombstone keeps full stickiness')
})

/* (e2) regression guard: a NON-superseded tombstone (deletedAt NEWER than the inbound round)
 * still filters the inbound array — stickiness for genuinely concurrent deletes is kept. */
test('W11-1e2: a tombstone newer than the inbound round still filters the alive inbound row', () => {
  const state = mkState()
  state.savedAt = 100
  state.deleted = [{ id: 'h-still-deleted', deletedAt: 400 }] // deleted AFTER the 300 round was written
  habits.mutations.replaceAll(state, {
    schemaV: 1,
    habits: [{ id: 'h-still-deleted', records: {} }],
    moments: [],
    savedAt: 300
  })
  assert.equal(state.habits.length, 0, 'the newer delete still wins over the stale inbound copy')
  assert.ok(state.deleted.find(t => t.id === 'h-still-deleted'), 'its tombstone survives')
})
