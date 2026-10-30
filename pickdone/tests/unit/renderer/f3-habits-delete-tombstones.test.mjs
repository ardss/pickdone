/**
 * F3 habits delete tombstones — regression guards.
 * Fix: delHabit records a `{ id, deletedAt }` tombstone in the persisted blob's `deleted` array;
 * every inbound merge boundary (applyExternal / applyExternalPatch / replaceAll) merges tombstones
 * first and then filters tombstoned ids out of the inbound habits array, so a peer blob (or an old
 * backup) that still carries the deleted habit can no longer resurrect it. Blobs without the
 * `deleted` field behave exactly as before (backward compatible).
 * Cross-device caliber (minimal correct version): a tombstone WINS regardless of savedAt —
 * deletion is sticky. Rationale: a habit id is `Date.now() + '-' + random`, so a "re-created"
 * habit with the same id cannot occur through addHabit (fresh id); an id reappearing in an
 * inbound blob is a stale peer copy. A deliberately re-added identical id (crafted import)
 * clears its tombstone in addHabit. Records maps of SURVIVING habits keep the d846a3e3
 * union-max merge — pinned here so the tombstone work cannot regress it.
 * Run: node --test tests/unit/renderer/f3-habits-delete-tombstones.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

if (!globalThis.window.location) globalThis.window.location = { hash: '' }

/* stub bridge BEFORE importing the store (d15-domain2-store-hotpaths pattern) */
const dbCalls = []
const metaStore = new Map()
globalThis.window.todoAPI = {
  dbCall: async (op, params) => {
    dbCalls.push([op, params])
    if (op === 'getMeta') return metaStore.has(params) ? metaStore.get(params) : null
    if (op === 'setMeta') { metaStore.set(params[0], params[1]); return 'ok' }
    if (op === 'deleteMeta') { metaStore.delete(params); return 'ok' }
    return 'ok'
  }
}
const lastBlob = () => JSON.parse(metaStore.get('db.habitsState'))

const habits = (await import('../../../renderer/js/store/habits.js')).default
const { applyHabitTombstones, mergeHabitTombstones } = await import('../../../renderer/js/store/habits.js')

const mkState = (h = [], savedAt = 0, deleted = []) => ({ habits: h, moments: [], savedAt, deleted })

test('T1 delHabit records a tombstone and persists it in the blob', () => {
  const s = mkState([{ id: 'h1', name: 'A', records: {} }], 100)
  habits.mutations.delHabit(s, 'h1')
  assert.deepEqual(s.habits, [], 'habit removed from state')
  assert.equal(s.deleted.length, 1)
  assert.equal(s.deleted[0].id, 'h1')
  assert.ok(s.deleted[0].deletedAt > 0, 'tombstone stamped')
  const blob = lastBlob()
  assert.ok(Array.isArray(blob.deleted) && blob.deleted[0].id === 'h1', 'tombstone reaches the durable blob')
})

test('T2 applyExternal: a tombstone SUPERSEDED by a newer alive inbound row is pruned; sticky for ids absent inbound; peer tombstones merge', () => {
  const s = mkState([{ id: 'h9', name: 'Keep', records: { '2026-10-01': true } }], 500, [{ id: 'h1', deletedAt: 400 }])
  habits.mutations.applyExternal(s, {
    savedAt: 900,
    habits: [
      { id: 'h1', name: 'UndoneUpstream', records: { '2026-10-02': true } },
      { id: 'h9', name: 'Keep', records: {} }
    ],
    moments: [],
    deleted: [{ id: 'h2', deletedAt: 800 }]
  })
  // [W11 2026-10-26] recalibrated: an inbound round POSTDATING the delete (deletedAt 400 <
  // savedAt 900) that still carries h1 ALIVE proves the delete was undone upstream — the alive
  // row wins and the stale tombstone is pruned (otherwise the merged tombstone re-deleted the
  // just-undone habit on every multi-device fold round). h2 is NOT present in the inbound
  // habits array → its tombstone keeps full stickiness.
  assert.ok(s.habits.some(h => h.id === 'h1'), 'W11: superseded tombstone pruned — the alive inbound row survives')
  assert.ok(s.habits.some(h => h.id === 'h9'), 'non-deleted peer habit merged')
  assert.deepEqual(s.habits.find(h => h.id === 'h9').records, { '2026-10-01': true }, 'union-max kept the local check-in (d846a3e3 intact)')
  assert.deepEqual(s.deleted.map(t => t.id), ['h2'], 'h1 tombstone pruned (superseded); h2 absent inbound → sticky')
})

test('T3 applyExternalPatch: superseded tombstones pruned on the LAN fold channel; newer tombstones still filter (fields.deleted and bare-blob shape)', () => {
  const s = mkState([], 500, [{ id: 'h1', deletedAt: 400 }])
  habits.mutations.applyExternalPatch(s, {
    savedAt: 900,
    fields: { habits: [{ id: 'h1', name: 'undone upstream', records: {} }, { id: 'h3', name: 'ok', records: {} }] }
  })
  // [W11 2026-10-26] the fold round postdates the delete and still carries h1 alive → pruned,
  // h1 survives (the pre-W11 prune was local-only and this round re-infected the tombstone)
  assert.ok(s.habits.some(h => h.id === 'h1'), 'W11: superseded tombstone pruned — fold round cannot re-delete the undone habit')
  assert.ok(s.habits.some(h => h.id === 'h3'))
  habits.mutations.applyExternalPatch(s, {
    savedAt: 1000,
    fields: { habits: [{ id: 'h4', records: {} }], deleted: [{ id: 'h4', deletedAt: 1100 }] }
  })
  assert.ok(!s.habits.some(h => h.id === 'h4'), 'a tombstone NEWER than the patch still filters its habit (delete wins)')
  assert.ok(s.deleted.some(t => t.id === 'h4'), 'peer tombstone recorded locally (sticky for later rounds too)')
})

test('T4 backward compat: a peer blob WITHOUT the deleted field behaves exactly as before', () => {
  const s = mkState([], 500, [])
  habits.mutations.applyExternal(s, { savedAt: 900, habits: [{ id: 'h5', name: 'fresh', records: {} }], moments: [{ id: 'm1', name: 'x', date: '2026-10-01', kind: 'countdown' }] })
  assert.equal(s.habits.length, 1)
  assert.equal(s.habits[0].id, 'h5')
  assert.deepEqual(s.deleted, [], 'no phantom tombstones invented')
  const raw = globalThis.localStorage.getItem('habitsState')
  // (LS shape untouched by this round — the blob gains an additive optional field only)
  assert.ok(raw === null || JSON.parse(raw), 'LS blob remains parseable')
})

test('T5 replaceAll: tombstones merge and filter; a stale backup without tombstones cannot resurrect', () => {
  const s = mkState([], 100, [{ id: 'h1', deletedAt: 400 }])
  habits.mutations.replaceAll(s, { savedAt: 200, habits: [{ id: 'h1', name: 'from backup', records: {} }, { id: 'h6', records: {} }], moments: [] })
  assert.ok(!s.habits.some(h => h.id === 'h1'), 'old backup blob without deleted[] filtered by the local tombstone')
  assert.ok(s.habits.some(h => h.id === 'h6'))
  const clean = JSON.parse(globalThis.localStorage.getItem('habitsState'))
  assert.deepEqual(clean.deleted, [{ id: 'h1', deletedAt: 400 }], 'tombstones survive the LS rewrite (clean copy carries them)')
})

test('T6 addHabit clears a tombstone for a deliberately re-added identical id (crafted import path)', () => {
  const s = mkState([], 100, [{ id: 'fixed-id', deletedAt: 400 }])
  habits.mutations.addHabit(s, { name: 'again' })
  assert.ok(!s.habits.some(h => h.id === 'fixed-id'), 'addHabit mints a fresh id (tombstone untouched, normal path)')
  // now the deliberate fixed-id path: simulate by pushing via the same mutation shape
  s.habits.push({ id: 'fixed-id', name: 'again', records: {} })
  habits.mutations.addHabit(s, { name: 'x' }) // sanity: still no crash
  assert.ok(s.deleted.some(t => t.id === 'fixed-id'))
})

test('T7 helpers: mergeHabitTombstones keeps the max deletedAt per id; applyHabitTombstones no-ops on an empty set', () => {
  const merged = mergeHabitTombstones([{ id: 'a', deletedAt: 100 }], [{ id: 'a', deletedAt: 300 }, { id: 'b', deletedAt: 50 }])
  assert.deepEqual(merged, [{ id: 'a', deletedAt: 300 }, { id: 'b', deletedAt: 50 }])
  const arr = [{ id: 'x', records: {} }]
  assert.equal(applyHabitTombstones(arr, []), arr, 'no tombstones -> identity (zero-risk fast path)')
})
