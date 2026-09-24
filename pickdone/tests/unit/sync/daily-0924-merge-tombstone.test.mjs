/* B1 (daily 2026-09-24): mergeTomatoRows must respect tombstones.
 * Pre-fix the tomato ledger merge ignored deleted flags entirely: a LOCALLY deleted focus
 * record was resurrected by ANY peer live row (even an older one), contradicting the X1
 * ingress intent (sync-apply.js already supplies the local tomato tombstone as localRow)
 * and the §4.2 delete-wins rule. Regression covers BOTH directions:
 *   - local tombstone vs peer OLDER live row  -> tombstone holds (no resurrection)
 *   - local tombstone vs peer NEWER live row  -> newer edit legitimately resurrects
 *   - the symmetric live-vs-peer-tombstone cases
 *   - both-deleted resolves by recency; both-live keeps the focusDuration billing rule
 * Run: node --test tests/unit/sync/daily-0924-merge-tombstone.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mergeTomatoRows } from '../../../shared/sync-core/merge.mjs'

const live = (id, updatedAt, focusDuration = 25, extra = {}) =>
  ({ id, updatedAt, deleted: false, deletedAt: 0, focusDuration, ...extra })
const tomb = (id, deletedAt, focusDuration = 25) =>
  ({ id, updatedAt: deletedAt, deleted: true, deletedAt, focusDuration })

test('B1: local tombstone beats a peer OLDER live row (the resurrection bug)', () => {
  const local = tomb('t1', 5000, 25)
  const peerOlder = live('t1', 4000, 30) // even a LARGER duration must not resurrect
  const { row } = mergeTomatoRows(local, peerOlder)
  assert.equal(row.deleted, true, 'older live row must not resurrect a local tombstone')
  assert.equal(row, local)
})

test('B1: local tombstone yields to a peer NEWER live row (edit after delete resurrects)', () => {
  const local = tomb('t1', 5000, 25)
  const peerNewer = live('t1', 6000, 10)
  const { row } = mergeTomatoRows(local, peerNewer)
  assert.equal(row.deleted, false, 'a strictly newer peer edit revives the record')
  assert.equal(row, peerNewer)
})

test('B1: local live edit survives a peer tombstone when the edit is newer', () => {
  const local = live('t1', 6000, 40)
  const peerDel = tomb('t1', 5000)
  const { row } = mergeTomatoRows(local, peerDel)
  assert.equal(row.deleted, false)
  assert.equal(row, local)
})

test('B1: local live edit loses to a peer tombstone that is newer', () => {
  const local = live('t1', 4000, 40)
  const peerDel = tomb('t1', 5000)
  const { row } = mergeTomatoRows(local, peerDel)
  assert.equal(row.deleted, true, 'peer deletion newer than the local edit wins')
  assert.equal(row, peerDel)
})

test('B1: both-deleted resolves by recency; both-live keeps the duration billing rule', () => {
  const a = tomb('t1', 5000)
  const b = tomb('t1', 6000)
  assert.equal(mergeTomatoRows(a, b).row, b)
  // untouched path: larger focusDuration still wins between two live rows
  const l1 = live('t1', 100, 25)
  const l2 = live('t1', 50, 45)
  assert.equal(mergeTomatoRows(l1, l2).row, l2, 'billing rule (larger duration) unchanged for live pairs')
})
