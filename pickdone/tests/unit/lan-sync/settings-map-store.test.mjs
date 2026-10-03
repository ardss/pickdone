/**
 * S6 unit tests for the shared read-throw/abort-write settings-map store helper
 * (src/main/lan-sync/settings-map-store.js).
 *
 * Contract under test:
 *   1. load() THROWS on an unreadable/undecodable settings value and latches `degraded`.
 *   2. persist() is a NO-OP while degraded — no write is ever derived from a failed read
 *      (the whole-map erase class).
 *   3. A malformed-but-READABLE value (e.g. a plain string, JSON-decodable) yields the
 *      default WITHOUT degrading.
 *   4. A later SUCCESSFUL load re-arms persistence.
 *   5. validate() rejecting a readable value also yields the default without degrading.
 *   6. markDegraded() latches manually; persist failures are reported as false, not thrown.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const createJsonSettingStore = require('../../../src/main/lan-sync/settings-map-store.js')

function makeBacking () {
  const rows = new Map()
  return {
    rows,
    settingGet: key => rows.has(key) ? rows.get(key) : null,
    settingPut: (key, value) => { rows.set(key, value) },
  }
}

function makeLog () {
  const warnings = []
  return { warn: (...a) => warnings.push(a.join(' ')), warnings }
}

test('S6: a failed read throws and latches degraded; persist is skipped while degraded', () => {
  const { rows } = makeBacking()
  const log = makeLog()
  const CORRUPT = '{"a": 1,,,' // undecodable durable value
  rows.set('k', CORRUPT)
  const store = createJsonSettingStore({ settingGet: k => rows.get(k) ?? null, settingPut: (k, v) => rows.set(k, v), log, key: 'k', name: 'test map', defaultValue: '{}' })

  assert.throws(() => store.load(), /test map read failed/, 'an undecodable value must throw, not silently default')
  assert.equal(store.canPersist(), false, 'the failed read latches degraded')

  // A writer runs after the failed read — it must NOT derive a write from it.
  const persisted = store.persist({ a: 1 })
  assert.equal(persisted, false, 'persist must be skipped while degraded')
  assert.equal(rows.get('k'), CORRUPT, 'the durable row is byte-identical — no erase')
  assert.match(log.warnings[0], /persist SKIPPED/, 'the skip is loud')
})

test('S6: a malformed-but-READABLE value yields the default WITHOUT degrading', () => {
  const { rows } = makeBacking()
  const store = createJsonSettingStore({ settingGet: k => rows.get(k) ?? null, settingPut: (k, v) => rows.set(k, v), log: makeLog(), key: 'k', name: 'test map', defaultValue: '{"d": true}' })
  rows.set('k', '"a plain string"') // valid JSON, wrong shape — readable, not a read failure

  const v = store.load()
  assert.equal(store.canPersist(), true, 'absence/shape mismatch is a valid state; only a read failure degrades')
  assert.equal(v, 'a plain string')
})

test('S6: validate() rejecting a readable value yields the default without degrading', () => {
  const { rows } = makeBacking()
  const store = createJsonSettingStore({
    settingGet: k => rows.get(k) ?? null, settingPut: (k, v) => rows.set(k, v), log: makeLog(),
    key: 'k', name: 'test map', defaultValue: '{}',
    validate: v => v && typeof v === 'object' && !Array.isArray(v),
  })
  rows.set('k', '[1,2,3]') // readable JSON, but fails validate
  const v = store.load()
  assert.deepEqual(v, {}, 'the default is used when validation rejects the value')
  assert.equal(store.canPersist(), true, 'a rejected-but-readable value does not latch degraded')
  assert.equal(store.persist({ ok: 1 }), true, 'writes proceed')
  assert.equal(rows.get('k'), '{"ok":1}')
})

test('S6: a later SUCCESSFUL load re-arms persistence', () => {
  const { rows } = makeBacking()
  const store = createJsonSettingStore({ settingGet: k => rows.get(k) ?? null, settingPut: (k, v) => rows.set(k, v), log: makeLog(), key: 'k', name: 'test map', defaultValue: '{}' })

  rows.set('k', 'not json')
  assert.throws(() => store.load())
  assert.equal(store.persist({ x: 1 }), false, 'degraded: write aborted')
  assert.equal(rows.get('k'), 'not json')

  rows.set('k', '{"healed": true}') // the underlying read is fixed
  const v = store.load()
  assert.deepEqual(v, { healed: true })
  assert.equal(store.canPersist(), true, 'a successful read re-arms writes')
  assert.equal(store.persist({ x: 2 }), true, 'writes proceed again')
  assert.equal(rows.get('k'), '{"x":2}')
})

test('S6: markDegraded latches manually; persist failure (throwing settingPut) is reported false', () => {
  const { rows } = makeBacking()
  const log = makeLog()
  const store = createJsonSettingStore({
    settingGet: k => rows.get(k) ?? null,
    settingPut: () => { throw new Error('disk full') },
    log, key: 'k', name: 'test map', defaultValue: '{}',
  })
  store.markDegraded() // e.g. a boot seed caught the load throw itself
  assert.equal(store.canPersist(), false)
  assert.equal(store.persist({ a: 1 }), false, 'manual latch blocks the write')
  assert.match(log.warnings[0], /SKIPPED/)

  // Fresh store, readable state, but the write itself fails.
  const store2 = createJsonSettingStore({
    settingGet: k => rows.get(k) ?? null,
    settingPut: () => { throw new Error('disk full') },
    log, key: 'k2', name: 'test map 2', defaultValue: '{}',
  })
  store2.load()
  assert.equal(store2.canPersist(), true)
  assert.equal(store2.persist({ a: 1 }), false, 'a throwing settingPut is reported, not propagated')
  assert.match(log.warnings[1], /persist failed.*disk full/)
})

test('S6: missing key yields the parsed default and keeps persistence armed', () => {
  const { rows } = makeBacking()
  const store = createJsonSettingStore({ settingGet: k => rows.get(k) ?? null, settingPut: (k, v) => rows.set(k, v), log: makeLog(), key: 'absent', name: 'test map', defaultValue: '{"seeded":1}' })
  assert.deepEqual(store.load(), { seeded: 1 })
  assert.equal(store.canPersist(), true)
})
