/**
 * D15 domain-2 — external-reload kind gate + userTags inbound refresh (2026-10-03).
 * Fixes covered:
 *   B13 'setMeta' broadcasts map to the cheap 'meta' round kind so aux windows stop paying a full
 *       todo/init per debounced settings/habits mirror write (normalizeRoundKinds + the
 *       reason-fallback in kindsFromChangedEvent)
 *   B10 'userTags' placeholder tags refresh on meta rounds at the single dispatch site
 * Run: node --test tests/unit/renderer/d15-external-reload-kinds.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

if (!globalThis.window.location) globalThis.window.location = { hash: '' }

const { createExternalReloader, kindsFromChangedEvent, normalizeRoundKinds } =
  await import('../../../renderer/js/utils/externalReload.js')

const flush = () => new Promise(r => setTimeout(r, 0))
const countsOf = (dispatched, m) => dispatched.filter(([x]) => x === m).length

test('B13: kindsFromChangedEvent falls back to evt.reason (setMeta broadcast carries no op)', () => {
  assert.deepEqual(kindsFromChangedEvent({ reason: 'setMeta', at: 1 }), ['setMeta'])
  assert.deepEqual(kindsFromChangedEvent({ op: 'todo,meta' }), ['todo', 'meta'], 'op still wins when stamped')
  assert.equal(kindsFromChangedEvent({}), null)
  assert.equal(kindsFromChangedEvent(null), null)
})

test('B13: normalizeRoundKinds maps meta-table ops to the cheap meta kind', () => {
  assert.deepEqual(normalizeRoundKinds(['setMeta']), ['meta'])
  assert.deepEqual(normalizeRoundKinds(['setMetaMany', 'category']), ['meta', 'category'])
  assert.deepEqual(normalizeRoundKinds(['todo']), ['todo'], 'data kinds untouched')
  assert.equal(normalizeRoundKinds(null), null)
})

test('B13: a setMeta round skips the full todo/init (and filters/category), still refreshes meta ledgers', async () => {
  const dispatched = []
  let estimates = 0
  let userTagsReloads = 0
  const reload = createExternalReloader({
    store: { dispatch: (m, p) => { dispatched.push([m, p]); return Promise.resolve() } },
    reloadEstimates: () => { estimates++; return Promise.resolve() },
    reloadUserTags: () => { userTagsReloads++; return Promise.resolve() }
  })
  reload({ kinds: ['setMeta'] }); await flush()
  assert.equal(countsOf(dispatched, 'todo/init'), 0, 'setMeta round must NOT pay the full todo/init (the aux-window reload storm)')
  assert.equal(countsOf(dispatched, 'filters/load'), 0)
  assert.equal(countsOf(dispatched, 'category/init'), 0)
  assert.equal(estimates, 1, 'estimates still refresh on a meta round')
  assert.equal(userTagsReloads, 1, 'userTags rides the same meta round')

  // unknown/data reasons stay conservative (full reload)
  dispatched.length = 0
  reload({ kinds: ['external-db-write'] })
  assert.equal(countsOf(dispatched, 'todo/init'), 1, 'unknown reason keeps the conservative full reload')
})

test('B13: reason-fallback end-to-end — kinds parsed from reason reach the gate', async () => {
  const dispatched = []
  const reload = createExternalReloader({
    store: { dispatch: (m, p) => { dispatched.push([m, p]); return Promise.resolve() } }
  })
  const evt = { reason: 'setMeta', at: Date.now() }
  reload({ kinds: kindsFromChangedEvent(evt) }); await flush()
  assert.equal(countsOf(dispatched, 'todo/init'), 0)
})

test('B10: default userTags reloader reads the meta key and commits ui/setUserTags', async () => {
  const committed = []
  globalThis.window.todoAPI = {
    ...(globalThis.window.todoAPI || {}),
    dbCall: async (op, params) => {
      if (op === 'getMeta' && params === 'userTags') return JSON.stringify(['work', 'urgent'])
      return 'ok'
    }
  }
  const dispatched = []
  const store = {
    dispatch: (m, p) => { dispatched.push([m, p]); return Promise.resolve() },
    commit: (m, p) => committed.push([m, p])
  }
  const reload = createExternalReloader({ store, reloadEstimates: () => Promise.resolve() })
  reload({ kinds: ['meta'] }); await flush()
  assert.deepEqual(committed, [['ui/setUserTags', ['work', 'urgent']]], 'placeholder tags refreshed at the single dispatch site')

  // junk meta payload must not clobber the store
  globalThis.window.todoAPI.dbCall = async () => 'not-json{{'
  committed.length = 0
  const reload2 = createExternalReloader({ store: { ...store, commit: (m, p) => committed.push([m, p]) }, reloadEstimates: () => Promise.resolve(), now: () => Date.now() + 5000 })
  reload2({ kinds: ['meta'] }); await flush()
  assert.deepEqual(committed, [], 'unparseable meta payload commits nothing')
})
