import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

// S4 — user-visible delete-vs-edit adjudication (sync-v2 acceptance matrix, S4 entry).
//
// Today the delete-vs-edit collisions below are resolved by silent LWW defaults:
//   - plan/filter tombstone-keep guard: the inbound edit is dropped with ZERO trace
//   - plan/filter resurrection: an older-tombstone edit lands (deleted=0) with ZERO trace
//   - todo sameLineage delete-wins: no conflict copy (same author) -> silent destruction
//   - setting delete-wins: settingsRowDelete lands, no toast, no backup
// S4 (double opt-in: sync.revisions.v2 + sync.revisions.v2.adjudicate, default OFF):
//   1. every delete-vs-edit collision records an explicit adjudication direction
//      (machine-local meta `sync.adjudication.<entity>:<id>`, never synced)
//   2. the direction is user-perceivable: the per-round conflict summary carries it
//   3. a FAILED adjudication record never fails the apply, but is counted and surfaced
//      (consumeAppliedRound -> adjudicationFailed) — failure is not silent
//   4. evidence reuses the S2 DVV tombstone metadata when present
// Flag off (default) stays byte-identical: no records, no extra toasts.

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-s4-adjudicate-'))
process.env.TODO_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-s4-adjudicate-ud-'))
const require = createRequire(import.meta.url)
const db = require('../../../src/main/db')
const syncApply = require('../../../src/main/sync-apply')

db.init(process.env.TODO_DB_DIR)

const NOW = 1700000000000
// The bootstrap state shape (lan-sync-bootstrap initializes the same fields): the landing
// paths buffer rows into state.pendingWrites — the apply pipeline contract requires it.
const stateFor = () => ({
  db: { call: (op, p) => db.call(op, p) },
  pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
})
const adjudicationKey = (entity, id) => `sync.adjudication.${entity}:${id}`
const readAdjudication = (entity, id) => {
  const raw = db.call('getMeta', adjudicationKey(entity, id))
  return raw == null ? null : JSON.parse(raw)
}
const enableS4 = () => {
  db.call('revisionsFlag', { on: true })
  db.call('revisionsFlagAdjudicate', { on: true })
}
const disableS4 = () => db.call('revisionsFlagAdjudicate', { on: false })

test('S4 default OFF: collisions stay byte-identical silent — no records, no extra toasts', () => {
  const st = db.call('revisionsFlagState')
  assert.equal(st.on, false)
  assert.equal(st.adjudicate, false, 'adjudicate sub-flag defaults to false')

  // plan keep-delete: fresher local tombstone beats an older inbound edit
  db.call('planAddMany', [{ id: 'p-off', taskId: 't', day: '2026-01-01', mm: '09:00', updatedAt: NOW }])
  db.call('planRemoveIds', [{ id: 'p-off', deletedAt: NOW + 500, updatedAt: NOW + 500 }])
  const s1 = stateFor()
  assert.equal(syncApply.applyRowSafe(s1, { entity: 'plan', id: 'p-off', updatedAt: NOW + 100, deleted: false, data: { id: 'p-off', day: '2026-01-01', mm: '10:00' } }), false)
  assert.equal(readAdjudication('plan', 'p-off'), null, 'no adjudication record while the sub-flag is off')
  assert.deepEqual((syncApply.consumeAppliedRound(s1) || {}).conflicts, undefined, 'no conflict surfaced while the sub-flag is off')
})

test('S4 red->green: plan tombstone-keep guard records delete-dominates and surfaces the conflict', () => {
  enableS4()
  db.call('planAddMany', [{ id: 'p1', taskId: 't', day: '2026-01-01', mm: '09:00', updatedAt: NOW }])
  db.call('planRemoveIds', [{ id: 'p1', deletedAt: NOW + 500, updatedAt: NOW + 500 }])
  const s = stateFor()
  // unchanged v1 OUTCOME: the fresher local deletion stands
  assert.equal(syncApply.applyRowSafe(s, { entity: 'plan', id: 'p1', updatedAt: NOW + 100, deleted: false, data: { id: 'p1', day: '2026-01-01', mm: '10:00' } }), false)
  const rec = readAdjudication('plan', 'p1')
  assert.ok(rec, 'adjudication record persisted (machine-local)')
  assert.equal(rec.direction, 'delete-dominates')
  assert.equal(rec.winner, 'local-delete')
  assert.equal(rec.entity, 'plan')
  assert.equal(rec.id, 'p1')
  assert.ok(rec.evidence && rec.evidence.localDeletedAt === NOW + 500 && rec.evidence.incomingUpdatedAt === NOW + 100, 'stamp evidence recorded')
  const round = syncApply.consumeAppliedRound(s)
  assert.ok(round.conflicts.some(c => c.entity === 'plan' && c.name === 'p1' && c.applied === false), 'direction is user-perceivable via the round conflict summary')
})

test('S4 red->green: plan resurrection (edit beats older tombstone) records edit-dominates', () => {
  db.call('planAddMany', [{ id: 'p2', taskId: 't', day: '2026-01-02', mm: '09:00', updatedAt: NOW }])
  db.call('planRemoveIds', [{ id: 'p2', deletedAt: NOW + 100, updatedAt: NOW + 100 }])
  const s = stateFor()
  // strictly newer inbound edit: the v1 outcome (edit lands) must NOT change
  assert.equal(syncApply.applyRowSafe(s, { entity: 'plan', id: 'p2', updatedAt: NOW + 9000, deleted: false, data: { id: 'p2', day: '2026-01-02', mm: '11:00' } }), true)
  const rec = readAdjudication('plan', 'p2')
  assert.ok(rec, 'resurrection is no longer silent')
  assert.equal(rec.direction, 'edit-dominates')
  assert.equal(rec.winner, 'remote-edit')
  const round = syncApply.consumeAppliedRound(s)
  assert.ok(round.conflicts.some(c => c.entity === 'plan' && c.name === 'p2'), 'resurrection surfaced to the user')
})

test('S4 red->green: todo sameLineage delete-wins (silent destruction today) records delete-dominates', () => {
  // same syncAuthor on both sides = sameLineage = merge.mjs mints NO conflict copy —
  // today the local edit is destroyed with zero trace
  db.call('upsert', { taskId: 't-same', title: 'local edit', createdAt: 1, updatedAt: NOW, syncAuthor: 'devA' })
  const s = stateFor()
  const r = syncApply.applyRowSafe(s, { entity: 'todo', id: 't-same', deleted: true, deletedAt: NOW + 400, updatedAt: NOW + 400, author: 'devA' })
  assert.equal(r, true, 'v1 outcome unchanged: the newer deletion lands')
  const rec = readAdjudication('todo', 't-same')
  assert.ok(rec, 'sameLineage delete-vs-edit is no longer silent')
  assert.equal(rec.direction, 'delete-dominates')
  assert.equal(rec.winner, 'remote-delete')
})

test('S4 red->green: setting delete-wins over a live local value records delete-dominates', () => {
  db.call('settingsRowPutMany', [{ key: 'sk1', value: JSON.stringify('local-value'), updatedAt: NOW }])
  const s = stateFor()
  assert.equal(syncApply.applyRowSafe(s, { entity: 'setting', id: 'sk1', deleted: true, deletedAt: NOW + 300, updatedAt: NOW + 300 }), true)
  const rec = readAdjudication('setting', 'sk1')
  assert.ok(rec, 'setting delete-vs-edit is no longer silent')
  assert.equal(rec.direction, 'delete-dominates')
  assert.equal(rec.winner, 'remote-delete')
})

test('S4: DVV tombstone metadata (S2) reused as adjudication evidence', () => {
  db.call('revisionsFlagDvv', { on: true }) // S2 sub-flag on top of the base flag (already on)
  // soft-deleted chip: the tombstone ROW defends in the v1 pipeline AND its tombstone
  // revision carries a persisted S2 DVV dot (hardDelete would leave no v1 counterpart)
  db.call('planAddMany', [{ id: 'p-dvv', taskId: 't', day: '2026-01-05', mm: '09:00', updatedAt: NOW }])
  db.call('planRemoveIds', [{ id: 'p-dvv', deletedAt: NOW + 500, updatedAt: NOW + 500 }])
  const s = stateFor()
  assert.equal(syncApply.applyRowSafe(s, { entity: 'plan', id: 'p-dvv', updatedAt: NOW + 50, deleted: false, data: { id: 'p-dvv', day: '2026-01-05', mm: '10:00' } }), false, 'local deletion stands')
  const rec = readAdjudication('plan', 'p-dvv')
  assert.ok(rec, 'adjudication recorded for the DVV-backed tombstone')
  assert.equal(rec.direction, 'delete-dominates')
  assert.equal(rec.winner, 'local-delete')
  assert.ok(rec.evidence && rec.evidence.dvvDot && rec.evidence.dvvDot.counter >= 1, 'S2 DVV dot carried as causal evidence')
})

test('S4: a FAILED adjudication record never fails the apply but is counted and surfaced', () => {
  enableS4()
  db.call('planAddMany', [{ id: 'p3', taskId: 't', day: '2026-01-03', mm: '09:00', updatedAt: NOW }])
  db.call('planRemoveIds', [{ id: 'p3', deletedAt: NOW + 500, updatedAt: NOW + 500 }])
  const broken = {
    db: {
      call: (op, p) => {
        if (op === 'setMeta') throw new Error('meta write door closed')
        return db.call(op, p)
      },
    },
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
  }
  // v1 outcome identical with and without the broken recorder
  assert.equal(syncApply.applyRowSafe(broken, { entity: 'plan', id: 'p3', updatedAt: NOW + 100, deleted: false, data: { id: 'p3', day: '2026-01-03', mm: '10:00' } }), false)
  const round = syncApply.consumeAppliedRound(broken)
  assert.equal(round.adjudicationFailed, 1, 'the failure is surfaced in the round summary, not swallowed')
})

test('S4 reversible: sub-flag off again — collisions go silent, old records stay inert', () => {
  disableS4()
  db.call('planAddMany', [{ id: 'p4', taskId: 't', day: '2026-01-04', mm: '09:00', updatedAt: NOW }])
  db.call('planRemoveIds', [{ id: 'p4', deletedAt: NOW + 500, updatedAt: NOW + 500 }])
  const s = stateFor()
  assert.equal(syncApply.applyRowSafe(s, { entity: 'plan', id: 'p4', updatedAt: NOW + 100, deleted: false, data: { id: 'p4', day: '2026-01-04', mm: '10:00' } }), false)
  assert.equal(readAdjudication('plan', 'p4'), null, 'no NEW record after the sub-flag is off')
  assert.ok(readAdjudication('plan', 'p1'), 'older records remain (machine-local, inert)')
})
