/**
 * Unit tests for the oplog segment codec: roundtrip, schemaVersion rejection,
 * seq-range monotonicity rejection, and the 256KB size guard.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  pack, unpack, codecHooks, SegmentTooLarge, SegmentSchemaError, SegmentRangeError, MAX_SEGMENT_BYTES,
} from '../../../shared/sync-core/segment.mjs'
import { SYNC_SCHEMA_VERSION } from '../../../shared/sync-core/merge.mjs'

const row = (seq, over = {}) => ({ id: `t${seq}`, title: `row ${seq}`, seq, updatedAt: seq * 10, deviceId: 'devA', deleted: 0, ...over })

test('roundtrip: pack then unpack preserves rows and header', () => {
  const rows = [row(1), row(2), row(3)]
  const seg = pack(rows, { fromSeq: 1, toSeq: 3, deviceId: 'devA' })
  const out = unpack(seg)
  assert.equal(out.v, SYNC_SCHEMA_VERSION)
  assert.equal(out.deviceId, 'devA')
  assert.equal(out.fromSeq, 1)
  assert.equal(out.toSeq, 3)
  assert.deepEqual(out.rows, rows)
})

test('schemaVersion rejection: unpack refuses a foreign version', () => {
  const seg = pack([row(1)], { fromSeq: 1, toSeq: 1, deviceId: 'devA', schemaVersion: 99 })
  assert.throws(() => unpack(seg), SegmentSchemaError)
  assert.throws(() => unpack(seg, { schemaVersion: 2 }), SegmentSchemaError)
  assert.doesNotThrow(() => unpack(seg, { schemaVersion: 99 }))
})

test('seq-range rejection: fromSeq > toSeq throws on pack and unpack', () => {
  assert.throws(() => pack([row(5)], { fromSeq: 9, toSeq: 1, deviceId: 'devA' }), SegmentRangeError)
  const bad = JSON.stringify({ v: 1, deviceId: 'devA', fromSeq: 9, toSeq: 1, rows: [] })
  assert.throws(() => unpack(bad), SegmentRangeError)
})

test('monotonicity rejection: row seq outside declared range or non-increasing', () => {
  const dup = pack([row(2), row(2)], { fromSeq: 1, toSeq: 3, deviceId: 'devA' })
  assert.throws(() => unpack(dup), /strictly increasing/)
  const outOfRange = JSON.stringify({ v: 1, deviceId: 'devA', fromSeq: 1, toSeq: 2, rows: [row(1), row(7)] })
  assert.throws(() => unpack(outOfRange), /outside declared range/)
})

test('size guard: segment over 256KB throws SegmentTooLarge', () => {
  const fat = row(1, { blob: 'x'.repeat(MAX_SEGMENT_BYTES) })
  assert.throws(() => pack([fat], { fromSeq: 1, toSeq: 1, deviceId: 'devA' }), SegmentTooLarge)
  // boundary: a segment at exactly the cap is allowed
  const baseRow = row(1, { blob: '' })
  const baseLen = pack([baseRow], { fromSeq: 1, toSeq: 1, deviceId: 'devA' }).length
  const exact = pack([row(1, { blob: 'y'.repeat(MAX_SEGMENT_BYTES - baseLen) })], { fromSeq: 1, toSeq: 1, deviceId: 'devA' })
  assert.equal(exact.length, MAX_SEGMENT_BYTES)
})

test('E2EE hook boundary: encrypt/decrypt hooks are null now and wire through when installed', () => {
  assert.equal(codecHooks.encrypt, null)
  assert.equal(codecHooks.decrypt, null)
  codecHooks.encrypt = (s) => 'ENC[' + Buffer.from(s).toString('base64') + ']'
  codecHooks.decrypt = (s) => Buffer.from(s.slice(4, -1), 'base64').toString()
  try {
    const seg = pack([row(1)], { fromSeq: 1, toSeq: 1, deviceId: 'devA' })
    assert.match(seg, /^ENC\[/)
    assert.equal(unpack(seg).rows[0].id, 't1')
  } finally {
    codecHooks.encrypt = null
    codecHooks.decrypt = null
  }
})
