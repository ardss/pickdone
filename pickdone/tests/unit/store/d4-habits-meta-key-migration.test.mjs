/**
 * D4 regression: habits store's DB meta key must be 'db.habitsState' — the v6 sync-schema bridge
 * (src/main/db-sync-schema.js SYNC_BLOB_KEYS) only mirrors 'db.settingsState'/'db.habitsState' into
 * settings_rows, so the legacy bare 'habitsState' row never reached the durable/syncable store.
 * Also covers the one-time migration: legacy blob copied to the new key on initFromDb.
 * Run: node --test tests/unit/store/d4-habits-meta-key-migration.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { default: habitsStore } = await import('../../../renderer/js/store/habits.js')

function stubApi (meta) {
  const calls = { getMeta: [], setMeta: [] }
  globalThis.window.todoAPI = {
    dbCall: async (op, params) => {
      if (op === 'getMeta') { calls.getMeta.push(params); return meta[params] != null ? meta[params] : null }
      if (op === 'setMeta') { calls.setMeta.push(params); meta[params[0]] = params[1]; return null }
      return null
    }
  }
  return calls
}

test('persist writes the db-prefixed meta key (sync bridge contract)', () => {
  globalThis.window.location = { hash: '#/' }
  const meta = {}
  stubApi(meta)
  const s = habitsStore.state()
  habitsStore.mutations.addHabit(s, { name: 'bridge' })
  assert.ok(meta['db.habitsState'], 'blob persisted under db.habitsState')
  assert.ok(JSON.parse(meta['db.habitsState']).habits.some(h => h.name === 'bridge'))
})

test('initFromDb migration: legacy habitsState blob is copied to db.habitsState', async () => {
  globalThis.window.location = { hash: '#/' }
  const legacyBlob = JSON.stringify({ schemaV: 1, habits: [{ id: 'legacy-1', name: 'legacy', records: {} }], moments: [], savedAt: 123 })
  const meta = { habitsState: legacyBlob }
  const calls = stubApi(meta)
  let captured = null
  await habitsStore.actions.initFromDb({ commit: (m, p) => { captured = { m, p } } })
  assert.equal(captured.m, 'replaceAll')
    assert.equal(captured.p.habits[0].id, 'legacy-1', 'legacy blob applied to state')
  assert.ok(calls.getMeta.includes('db.habitsState'), 'new key is read first')
  assert.ok(calls.getMeta.includes('habitsState'), 'legacy key read as fallback')
  const copy = calls.setMeta.find(c => c[0] === 'db.habitsState')
  assert.ok(copy, 'legacy blob copied to db.habitsState')
  assert.equal(copy[1], legacyBlob, 'copied verbatim')
})

test('initFromDb: no duplicate copy when db.habitsState already exists', async () => {
  globalThis.window.location = { hash: '#/' }
  const newBlob = JSON.stringify({ schemaV: 1, habits: [{ id: 'new-1', records: {} }], moments: [], savedAt: 999 })
  const meta = { 'db.habitsState': newBlob, habitsState: '{"schemaV":1,"habits":[],"moments":[],"savedAt":1}' }
  const calls = stubApi(meta)
  let captured = null
  await habitsStore.actions.initFromDb({ commit: (m, p) => { captured = { m, p } } })
  assert.equal(captured.p.habits[0].id, 'new-1', 'new key wins over legacy')
  assert.equal(calls.setMeta.length, 0, 'no migration write needed')
})
