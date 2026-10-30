/**
 * Agent F2 (renderer store data-consistency domain) — regression tests for the 2026-10-14 fix wave.
 *   [1] habits applyExternal/applyExternalPatch: the whole-blob LWW replace on the LAN fold channel
 *       silently dropped the other device's concurrent check-in. Now records maps are union-max
 *       merged (check-ins are increasing events: keep the LARGER count per habit/day; a boolean
 *       `true` counts as 1). Config fields (name/color/frequency/deletion) still follow blob-level
 *       savedAt LWW. Known trade-off: a decrement/correction on one device can be resurrected by an
 *       older peer copy of the same day's count — we accept losing a decrement over losing check-ins.
 *   [2] filters.remove: the delete lands, then a failed filterList refetch used to reject the whole
 *       action (sidebar kept the already-deleted filter). Refetch now runs in its own try/catch
 *       (d21-A7 discipline from save()) and keeps the local removal on failure.
 * Run: node --test tests/unit/store/d-wave-store-20261014.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import habits, { unionMaxRecords } from '../../../renderer/js/store/habits.js'
import filters from '../../../renderer/js/store/filters.js'

const LS = globalThis.localStorage
const clearLS = () => { for (let i = LS.length - 1; i >= 0; i--) LS.removeItem(LS.key(i)) }

const habit = (id, records) => ({ id, name: 'H' + id, color: '#fff', createdAt: 1, frequency: { type: 'daily' }, records: records || {} })

/* ---------------- [1] habits union-max merge on the external fold channel ---------------- */

test('D-wave [1a]: applyExternal keeps BOTH devices check-ins (different days, savedAt incoming newer)', () => {
  clearLS()
  const s = { habits: [habit('a', { '2026-10-13': 1 })], moments: [], savedAt: 100 }
  habits.mutations.applyExternal(s, { habits: [habit('a', { '2026-10-14': 2 })], moments: [], savedAt: 200 })
  const rec = s.habits.find(h => h.id === 'a').records
  assert.equal(rec['2026-10-13'], 1, 'the older device check-in must survive the newer blob replace')
  assert.equal(rec['2026-10-14'], 2, 'the incoming newer check-in is present')
  assert.equal(s.savedAt, 200)
})

test('D-wave [1b]: same-day conflict takes the max count', () => {
  clearLS()
  const s = { habits: [habit('a', { '2026-10-13': 3 })], moments: [], savedAt: 100 }
  habits.mutations.applyExternal(s, { habits: [habit('a', { '2026-10-13': 1, '2026-10-14': true })], moments: [], savedAt: 200 })
  const rec = s.habits.find(h => h.id === 'a').records
  assert.equal(rec['2026-10-13'], 3, 'union-max keeps the larger count')
  assert.equal(rec['2026-10-14'], true, 'boolean true is preserved verbatim')
})

test('D-wave [1c]: pure config change still follows whole-blob LWW (no habit resurrection)', () => {
  clearLS()
  // remote DELETED habit 'b' and renamed 'a' — the newer blob's config must win, habit 'b' stays gone
  const s = { habits: [habit('a', { '2026-10-13': 1 }), habit('b', { '2026-10-12': 1 })], moments: [], savedAt: 100 }
  habits.mutations.applyExternal(s, { habits: [habit('a', {})], moments: [], savedAt: 300 })
  assert.deepEqual(s.habits.map(h => h.id), ['a'], 'deletion on the newer device is not resurrected')
  assert.equal(s.habits[0].name, 'Ha', 'config fields come from the incoming blob')
  assert.deepEqual(s.habits[0].records, { '2026-10-13': 1 }, 'local records for surviving habits still folded in')
})

test('D-wave [1d]: applyExternalPatch merges records the same way', () => {
  clearLS()
  const s = { habits: [habit('a', { '2026-10-13': 2 })], moments: [], savedAt: 100 }
  habits.mutations.applyExternalPatch(s, { fields: { habits: [habit('a', { '2026-10-15': 1 })], savedAt: 200 } })
  assert.deepEqual(s.habits.find(h => h.id === 'a').records, { '2026-10-13': 2, '2026-10-15': 1 })
  assert.equal(s.savedAt, 200)
})

test('D-wave [1e]: stale/tied rounds still rejected; unionMaxRecords is a pure helper', () => {
  clearLS()
  const s = { habits: [habit('a', { d1: 1 })], moments: [], savedAt: 100 }
  habits.mutations.applyExternal(s, { habits: [habit('a', { d1: 5 })], moments: [], savedAt: 100 })
  assert.equal(s.habits[0].records.d1, 1, 'tie rejects (prior writer wins) — merge never runs')
  // helper: boolean true counts as 1, incoming wins ties
  assert.deepEqual(unionMaxRecords({ d1: true, d2: 1 }, { d1: 5, d2: 0, d3: 2 }), { d1: 5, d2: 1, d3: 2 })
})

/* ---------------- [2] filters.remove refetch failure must not reject ---------------- */

test('D-wave [2]: filterList failure after a successful delete keeps the local removal and resolves', async () => {
  const ops = []
  globalThis.window.todoAPI = {
    dbCall (op, params) {
      ops.push(op)
      if (op === 'filterList') return Promise.reject(new Error('refetch boom'))
      return Promise.resolve(null)
    }
  }
  const committed = []
  const state = { list: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] }
  const ctx = {
    state,
    commit (m, p) { committed.push([m, p]); filters.mutations[m] && filters.mutations[m](state, p) }
  }
  await filters.actions.remove(ctx, 1) // must NOT reject
  assert.ok(ops.includes('filterDelete'), 'the delete command was issued')
  assert.deepEqual(state.list.map(f => f.id), [2], 'the deleted filter is gone from the local list despite the refetch failure')
  delete globalThis.window.todoAPI // stub cleaned up
  assert.ok(!globalThis.window.todoAPI, 'stub cleaned up')
})
