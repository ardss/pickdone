/* D6 security round (2026-09-21) — command-bus stamp hygiene (F4) + ls-mirror payload
 * classification (F5):
 *   F4a  explicit stamps > now+skew (forged year-2100 LWW) are clamped to local now
 *   F4b  explicit stamps within the skew window stay verbatim (sync-apply parity intact)
 *   F4c  preserveStamp semantics unchanged (main-process capability, bus level)
 *   F5   classifyCommitKey: row-objects / row-lists / pair-arrays / bare strings
 * Pure bus instances via createBus — no electron, no db.
 * Run: node --test tests/unit/main/d6-sec-bus-stamp.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const busMod = require_('../../../src/main/command-bus.js')
const { classifyCommitKey } = require_('../../../src/main/handlers/shared.js')

const META_ROW = { entity: 'meta', verb: 'put', lwwField: 'updatedAt', op: 'setMeta' }
const SKEW = busMod.STAMP_SKEW_MS

test('F4a: a forged year-2100 explicit stamp is clamped to local now', () => {
  const b = busMod.createBus(() => ({}))
  const forged = { key: 'k', value: 'v', updatedAt: 4102444800000 } // 2100-01-01
  const out = b.stampPayload(META_ROW, forged)
  assert.notEqual(out.updatedAt, 4102444800000, 'future stamp must not survive verbatim')
  assert.ok(Math.abs(out.updatedAt - Date.now()) < 5000, 'clamped to ~now, got ' + out.updatedAt)
  assert.equal(out.key, 'k', 'other payload fields preserved')
  assert.equal(forged.updatedAt, 4102444800000, 'input payload never mutated in place')
})

test('F4a: a stamp just past the skew boundary is clamped; just inside is preserved', () => {
  const b = busMod.createBus(() => ({}))
  const over = b.stampPayload(META_ROW, { key: 'k', updatedAt: Date.now() + SKEW + 1000 })
  assert.ok(over.updatedAt <= Date.now() + 5000, 'beyond skew → clamped')
  const under = b.stampPayload(META_ROW, { key: 'k', updatedAt: Date.now() + SKEW - 60000 })
  assert.equal(under.updatedAt, Date.now() + SKEW - 60000, 'within skew (legit clock drift) → verbatim')
})

test('F4c: preserveStamp stays verbatim for field-less payloads (main-process sync-apply path)', () => {
  const b = busMod.createBus(() => ({}))
  const p = { key: 'k', value: 'v' }
  assert.equal(b.stampPayload(META_ROW, p, { preserveStamp: true }), p, 'never touched')
  const stamped = b.stampPayload(META_ROW, { key: 'k', value: 'v' })
  assert.ok(stamped.updatedAt > 0, 'without preserveStamp the bus stamps')
})

test('F5: classifyCommitKey handles all payload shapes (row / row-list / pair-array / string)', () => {
  // single row object (meta.put / setting.put)
  assert.equal(classifyCommitKey({ key: 'userKey', value: 1 }), 'userKey')
  // row-list (setting.putMany): the OLD inline ternary took payload[0] — the whole row OBJECT —
  // as "the key", which is never local → machine-local writes kicked sync rounds
  assert.equal(classifyCommitKey([{ key: 'sync.foo', value: 1 }, { key: 'x' }]), 'sync.foo')
  assert.equal(classifyCommitKey([]), undefined)
  // pair arrays (setMeta ['k','v']): payload[0] IS the key
  assert.equal(classifyCommitKey(['sync.watermark', 'v']), 'sync.watermark')
  // bare string payload (meta.delete 'someKey'): old code saw undefined → sync round for local keys
  assert.equal(classifyCommitKey('_cliStamp'), '_cliStamp')
  assert.equal(classifyCommitKey(null), undefined)
  assert.equal(classifyCommitKey(42), undefined)
})
