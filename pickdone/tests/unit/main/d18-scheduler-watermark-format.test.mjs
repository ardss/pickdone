/**
 * D18 (2026-10-02) — scheduler fired-reminders watermark wire format.
 * The watermark joined `${taskId}|${ts}` with '|'; a peer-controlled taskId CONTAINING '|'
 * shifted the split on load and silently dropped the entry (duplicate re-fires after restart).
 * The format is now JSON; the read side keeps backward compatibility with legacy packed blobs.
 * Run: node --test tests/unit/main/d18-scheduler-watermark-format.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
process.env.TODO_DB_DIR = require('node:os').tmpdir()
const { packFiredEntries, parseFiredEntries, loadFiredFromMeta } = require('../../../src/main/scheduler.js')

test('D18: JSON round-trip survives hostile taskIds containing the old separator', () => {
  const entries = [
    ['a|b:0', 1700000000000], // '|' inside the key — the legacy killer
    ['x\\y:5', 1700000000001],
    ['"quoted":10', 1700000000002]
  ]
  const parsed = parseFiredEntries(packFiredEntries(entries))
  assert.deepEqual(parsed.map(([k]) => k), ['a|b:0', 'x\\y:5', '"quoted":10'])
  assert.deepEqual(parsed.map(([, ts]) => ts), [1700000000000, 1700000000001, 1700000000002])
})

test('D18: legacy packed blobs still load (backward-compatible read)', () => {
  const legacy = ['k1|123', 'k2|456'].join(String.fromCharCode(31))
  assert.deepEqual(parseFiredEntries(legacy), [['k1', '123'], ['k2', '456']])
})

test('D18: legacy blob whose key itself contains | still round-trips via the LAST-| split', () => {
  // legacy writer produced 'a|b:0|1700...' for key 'a|b:0' — split on the LAST '|' recovers it
  assert.deepEqual(parseFiredEntries('a|b:0|1700'), [['a|b:0', '1700']])
})

test('D18: garbage payloads yield entries the existing corrupt-ts drop handles (no throw)', () => {
  assert.deepEqual(parseFiredEntries('not json'), [])
  assert.deepEqual(parseFiredEntries('['), []) // broken JSON falls through to legacy parse
  assert.deepEqual(parseFiredEntries(null), [])
})

test('D18: loadFiredFromMeta accepts the JSON format end-to-end and dedupes existing keys', () => {
  const sched = require('../../../src/main/scheduler.js')
  sched._clearStateForTest()
  const raw = packFiredEntries([['task|weird:0', 1700000000000], ['plain:3', 1700000000001]])
  loadFiredFromMeta({ call: (op, k) => op === 'getMeta' && k === 'firedReminders:' ? raw : null })
  assert.ok(sched._fired.has('task|weird:0'), 'red before the fix: a key containing | split into garbage and the reminder re-fired')
  assert.ok(sched._fired.has('plain:3'))
  assert.equal(sched._fired.get('plain:3').ts, 1700000000001)
  sched._clearStateForTest()
})
