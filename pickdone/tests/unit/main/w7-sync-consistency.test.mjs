/* W7 sync/blob consistency wave (M1 domain) — regression tests:
 *   1. [P1] sync-apply bare-tombstone landing must NOT rebuild the local row: the old
 *      `{taskId, delete:1, ...}` buffer shape went through todoToRow (zero-filling) +
 *      db.js stmts.upsert (full-column overwrite), wiping the recycle-bin row's content
 *      AND nul recurGroupId. Root fix: tombstone stamps ride the freshly-read local row,
 *      only deleted/deletedAt/updateTime/syncAuthor change.
 *   2. [P2] blob-union-merge total order: equal sort keys tiebreak by id so merge(A,B) and
 *      merge(B,A) are byte-identical; a duplicate id WITHIN one side must bail out to
 *      whole-key LWW (null), never silently collapse the entries.
 *   3. [P2] computeMetaGc 24h grace for sync-state meta families (repeatRule:/project*):
 *      a freshly-written replicated meta row is not GC'd off local activity alone; past
 *      the window (or with no stamps supplied — legacy callers) it still is.
 *   4. [P2] habits blob deletion tombstone families (`deleted` / `deletedMoments`) join
 *      HABITS_BLOB_OWNED: absent from a habits mirror → tombstoned; the SETTINGS mirror
 *      must never tombstone them (cross-family destruction guard).
 * Real better-sqlite3 via db.init on a fresh temp dir (never the real %APPDATA% profile).
 * Run: node --test tests/unit/main/w7-sync-consistency.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const syncApply = require_('../../../src/main/sync-apply.js')
const shared = require_('../../../src/main/handlers/shared.js')
const { mergeBlobMetaValue } = await import('../../../shared/blob-union-merge.mjs')

function freshDevice (label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w7-sync-' + label + '-'))
  db.init(dir)
  return {
    dir,
    deviceId: 'devW7',
    localUserId: null,
    applyCache: null,
    applied: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    db: { call: (op, p) => db.call(op, p) },
  }
}

function rawGet (dir, sql, params = []) {
  const Database = require_('../../../vendor/better-sqlite3-multiple-ciphers')
  const key = fs.readFileSync(path.join(dir, 'db.key'), 'utf8').trim()
  const d = new Database(path.join(dir, 'todos.db'))
  d.pragma(`key='${key}'`)
  d.prepare('SELECT count(*) FROM sqlite_master').get() // decrypt probe
  const row = d.prepare(sql).get(...params)
  d.close()
  return row
}

function flush (state) { const r = syncApply.flushPendingWrites(state); assert.equal(r.ok, true) }
const sleep = ms => new Promise(r => setTimeout(r, ms))

/* ---------- 1. bare tombstone must not rebuild the row (P1 root fix) ---------- */

test('w7-1: peer bare tombstone keeps the local row content + recurGroupId (recycle bin restorable)', async () => {
  const state = freshDevice('tomb-row')
  db.call('upsert', {
    taskId: 'w7row1',
    taskContent: '回收站里必须还能看到我',
    repeatId: 'rep-group-42',
    categoryId: 7,
    createTime: Date.now() - 86400000,
    updateTime: Date.now() - 3600000,
  })
  const T = Date.now() + 60000 // strictly newer than the local live row
  const ok = syncApply.applyRowSafe(state, {
    entity: 'todo', id: 'w7row1', seq: 1, ts: T, updatedAt: T, deleted: true, deletedAt: T, data: null, author: 'peerDev',
  })
  assert.equal(ok, true, 'the tombstone must land')
  flush(state)
  const row = rawGet(state.dir, 'SELECT deleted, deletedAt, updatedAt, content, recurGroupId, categoryId FROM todos WHERE id = ?', ['w7row1'])
  assert.equal(row.deleted, 1, 'the deletion landed')
  assert.equal(row.deletedAt, T, 'winner deletedAt survives')
  assert.equal(row.updatedAt, T, 'tombstone keeps its LWW age (Sync-1)')
  assert.equal(row.content, '回收站里必须还能看到我', 'content must NOT be zeroed by the tombstone landing')
  assert.equal(row.recurGroupId, 'rep-group-42', 'recurGroupId must NOT be nulled by the tombstone landing')
  assert.equal(row.categoryId, 7, 'categoryId must survive the tombstone landing')
  db.close()
})

test('w7-1b: tombstone landing over an already-binned row still preserves the binned content', async () => {
  const state = freshDevice('tomb-binned')
  const T0 = Date.now() - 7200000
  db.call('upsert', { taskId: 'w7row2', taskContent: 'binned-but-restorable', createTime: T0 - 1000, updateTime: T0, delete: 1, deletedAt: T0 })
  const T = Date.now() + 60000 // a strictly NEWER deletion (round summary: only a newer delete lands)
  const ok = syncApply.applyRowSafe(state, {
    entity: 'todo', id: 'w7row2', seq: 2, ts: T, updatedAt: T, deleted: true, deletedAt: T, data: null, author: 'peerDev',
  })
  assert.equal(ok, true)
  flush(state)
  const row = rawGet(state.dir, 'SELECT deleted, deletedAt, content FROM todos WHERE id = ?', ['w7row2'])
  assert.equal(row.deleted, 1)
  assert.equal(row.deletedAt, T, 'the newer deletion stamp wins')
  assert.equal(row.content, 'binned-but-restorable', 'binned content must survive a re-landing tombstone')
  db.close()
})

/* ---------- 2. blob-union-merge total order + duplicate ids ---------- */

test('w7-2: equal sort keys converge byte-identically regardless of argument order', () => {
  const a = JSON.stringify([{ id: 'a', title: 'A', date: 100 }, { id: 'b', title: 'B', date: 100 }])
  const b = JSON.stringify([{ id: 'b', title: 'B', date: 100 }, { id: 'a', title: 'A', date: 100 }])
  const ab = mergeBlobMetaValue('projectMilestones:c1', a, b)
  const ba = mergeBlobMetaValue('projectMilestones:c1', b, a)
  assert.notEqual(ab, null)
  assert.equal(ab, ba, 'merge(A,B) must equal merge(B,A) byte-for-byte when sort keys tie')
  const parsed = JSON.parse(ab)
  assert.deepEqual(parsed.map(m => m.id), ['a', 'b'], 'the id tiebreak fixes one total order')
})

test('w7-2b: equal updatedAt docs tie also converges on both peers', () => {
  const a = JSON.stringify([{ id: 'x', title: 'X', body: '1', updatedAt: 500 }, { id: 'y', title: 'Y', body: '2', updatedAt: 500 }])
  const b = JSON.stringify([{ id: 'y', title: 'Y', body: '2', updatedAt: 500 }, { id: 'x', title: 'X', body: '1', updatedAt: 500 }])
  const ab = mergeBlobMetaValue('projectDocs:c1', a, b)
  const ba = mergeBlobMetaValue('projectDocs:c1', b, a)
  assert.equal(ab, ba)
})

test('w7-2c: duplicate id within ONE side bails to whole-key LWW (null), never collapses silently', () => {
  const dup = JSON.stringify([{ id: 'x', title: 'first', date: 1 }, { id: 'x', title: 'second', date: 2 }])
  const clean = JSON.stringify([{ id: 'x', title: 'other', date: 3 }])
  assert.equal(mergeBlobMetaValue('projectMilestones:c2', dup, clean), null, 'local-side duplicate → null')
  assert.equal(mergeBlobMetaValue('projectMilestones:c2', clean, dup), null, 'incoming-side duplicate → null')
})

/* ---------- 3. computeMetaGc 24h grace for sync-state meta families ---------- */

test('w7-3: fresh sync-family meta row is shielded; aged one still GCs; legacy no-stamps unchanged', () => {
  const NOW = 1_800_000_000_000
  const keys = ['repeatRule:r1', 'projectDocs:c9', 'projectDeadline:c9', 'tomatoEstimateState:gone']
  const categories = [] // c9 not live locally
  const todos = [] // no repeatId anchors, no taskId 'gone'
  // legacy behavior (no stamps): everything dead, unchanged
  assert.deepEqual(shared.computeMetaGc(keys, categories, todos, { now: NOW }).sort(), [...keys].sort())
  // with stamps: fresh (2h old) sync-family rows survive; aged (25h) still die; non-sync family unaffected
  const dead = shared.computeMetaGc(keys, categories, todos, {
    now: NOW,
    metaStamps: { 'repeatRule:r1': NOW - 2 * 3600000, 'projectDocs:c9': NOW - 25 * 3600000, 'projectDeadline:c9': NOW - 25 * 3600000, 'tomatoEstimateState:gone': NOW - 1000 },
  })
  assert.deepEqual(dead.sort(), ['projectDeadline:c9', 'projectDocs:c9', 'tomatoEstimateState:gone'].sort())
})

test('w7-3b: Map-shaped metaStamps work and unknown ages keep legacy GC', () => {
  const NOW = 1_800_000_000_000
  const keys = ['repeatRule:r2', 'projectStatus:c1']
  const byMap = shared.computeMetaGc(keys, [], [], { now: NOW, metaStamps: new Map([['repeatRule:r2', NOW - 3600000]]) })
  assert.deepEqual(byMap, ['projectStatus:c1'], 'fresh Map-stamped rule shielded, unknown-age status still GCs')
})

/* ---------- 4. habits deletion-tombstone families join HABITS_BLOB_OWNED ---------- */

test('w7-4: `deleted` removed from the habits mirror tombstones its settings_row', async () => {
  freshDevice('habits-own')
  const T1 = Date.now()
  db.call('setMeta', ['db.habitsState', JSON.stringify({ schemaV: 1, habits: [], moments: [], savedAt: T1, deleted: [{ id: 'h1', deletedAt: T1 }], deletedMoments: [] })])
  let row = db.call('settingsRowsAll').find(r => r.key === 'deleted')
  assert.ok(row && !row.deleted, 'the bridge mirrors the top-level deleted array into settings_rows')
  await sleep(25)
  const T2 = Date.now()
  db.call('setMeta', ['db.habitsState', JSON.stringify({ schemaV: 1, habits: [], moments: [], savedAt: T2, deleted: [], deletedMoments: [] })])
  row = db.call('settingsRowsAll').find(r => r.key === 'deleted')
  // Note: an empty array is still PRESENT in the doc, so the row survives — removal is the
  // tombstone trigger. Drop the key entirely for the actual absence case:
  db.call('setMeta', ['db.habitsState', JSON.stringify({ schemaV: 1, habits: [], moments: [], savedAt: T2 + 5 })])
  row = db.call('settingsRowsAll').find(r => r.key === 'deleted')
  assert.ok(row && row.deleted, 'absent from the habits doc → the row is tombstoned by its owning blob')
  db.close()
})

test('w7-4b: the SETTINGS mirror must not tombstone the habits-family deletion arrays', async () => {
  freshDevice('habits-cross')
  const T1 = Date.now()
  db.call('setMeta', ['db.habitsState', JSON.stringify({ schemaV: 1, habits: [], moments: [], savedAt: T1, deleted: [{ id: 'h9', deletedAt: T1 }] })])
  await sleep(25)
  // A later whole-settings mirror (fresh _savedAt, no `deleted` field — it never carries one)
  // must leave the habits-family row alone.
  db.call('setMeta', ['db.settingsState', JSON.stringify({ themeMode: 'dark', _savedAt: Date.now() })])
  const row = db.call('settingsRowsAll').find(r => r.key === 'deleted')
  assert.ok(row && !row.deleted, 'cross-family tombstone of the habits `deleted` row is blocked')
  db.close()
})
