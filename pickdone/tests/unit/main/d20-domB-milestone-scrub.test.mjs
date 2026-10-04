/**
 * D20-DOMB1 — sync-applied deletions must scrub projectMilestones:<catId> blobs.
 * The renderer purge (scrubMilestonesForPurged) and the CLI purgeBin both scrub the dead
 * taskIds from every milestone blob, but a deletion landing via LAN SYNC (tombstone winner in
 * sync-apply) did NOT — a peer purge left a phantom taskId cross-machine, and milestoneState
 * (ids.size > 0, zero EXISTING linked tasks) fell through to the date-driven 'done' branch and
 * flipped an UNMET milestone to done. Fix: pure scrub logic in shared/milestone-gc.mjs, wired
 * into sync-apply's tombstone landing via scrubMilestoneBlobsFor (same semantics as cli/lib.js:
 * every projectMilestones:* key, each milestone's taskIds, no backup copy, corrupt blobs left
 * alone).
 * Run: node --test tests/unit/main/d20-domB-milestone-scrub.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
process.env.TODO_DB_DIR = require('node:os').tmpdir() // log-isolation: keep electron-log out of the repo
const { scrubMilestoneBlob } = require('../../../shared/milestone-gc.mjs')
const sa = require('../../../src/main/sync-apply.js')

test('B1 pure: a blob holding a dead id is scrubbed and re-serialized; other milestones keep their links', () => {
  const blob = JSON.stringify([
    { id: 'ms_1', title: 'Alpha', date: 100, taskIds: ['t1', 't2'] },
    { id: 'ms_2', title: 'Beta', date: 200, taskIds: ['t9'] }
  ])
  const next = scrubMilestoneBlob(blob, new Set(['t1']))
  assert.ok(next != null, 'changed blob must be returned')
  const list = JSON.parse(next)
  assert.deepEqual(list[0].taskIds, ['t2'], 'dead id removed, siblings kept')
  assert.deepEqual(list[1].taskIds, ['t9'], 'unrelated milestone untouched')
})

test('B1 pure: unchanged / corrupt / non-array blobs return null (caller must leave the key alone)', () => {
  const clean = JSON.stringify([{ id: 'ms_1', title: 'A', date: 1, taskIds: ['x'] }])
  assert.equal(scrubMilestoneBlob(clean, new Set(['t1'])), null, 'nothing to scrub → null (no rewrite)')
  assert.equal(scrubMilestoneBlob('not json{', new Set(['t1'])), null, 'corrupt blob → leave alone')
  assert.equal(scrubMilestoneBlob(JSON.stringify({ nope: 1 }), new Set(['t1'])), null, 'non-array → leave alone')
  assert.equal(scrubMilestoneBlob(null, new Set(['t1'])), null, 'absent blob → null')
})

test('B1 sync: scrubMilestoneBlobsFor rewrites every projectMilestones:* blob through the write door', () => {
  const blobs = {
    'projectMilestones:7': JSON.stringify([{ id: 'm', title: 'P', date: 5, taskIds: ['dead-id', 'live-id'] }]),
    'projectMilestones:8': 'garbage{',
    'planChipsSnapshot:x': JSON.stringify([{ taskIds: ['dead-id'] }])
  }
  const writes = []
  const state = {
    __bus: { commitOp: (op, payload) => writes.push([op, payload]) }, // busFor short-circuits on a pre-set bus
    db: { call: (op, k) => op === 'listMetaKeys' ? Object.keys(blobs) : (op === 'getMeta' ? blobs[k] : null) }
  }
  const n = sa.scrubMilestoneBlobsFor(state, ['dead-id'])
  assert.equal(n, 1, 'only the parseable milestone blob is rewritten')
  assert.deepEqual(writes, [['setMeta', ['projectMilestones:7', JSON.stringify([{ id: 'm', title: 'P', date: 5, taskIds: ['live-id'] }])]]],
    'red before the fix: sync tombstones never scrubbed milestone blobs — now one setMeta write with the scrubbed blob')
})

test('B1 sync: an empty dead-id set is a no-op (no meta scan, no writes)', () => {
  const writes = []
  const state = {
    __bus: { commitOp: (op, payload) => writes.push([op, payload]) },
    db: { call: () => { throw new Error('must not be touched') } }
  }
  assert.equal(sa.scrubMilestoneBlobsFor(state, []), 0)
  assert.equal(writes.length, 0)
})
