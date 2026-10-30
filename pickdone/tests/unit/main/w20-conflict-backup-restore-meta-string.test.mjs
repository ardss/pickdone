/* W20 P2 regression (2026-10-30): syncConflictBackupRestore meta-branch value-type gate.
 * Pre-fix, a META backup whose value was an object was fed straight into setMeta — db.js
 * String()-coerced it to the literal '[object Object]', destroying the unique lost copy, and
 * the backup key was then deleted (the B16 corruption path resurrected on the restore side).
 * Post-fix the meta branch requires a string value; an object value refuses to restore
 * (throw) BEFORE any setMeta/deleteMeta, so the backup key survives untouched.
 * Run: node --test tests/unit/main/w20-conflict-backup-restore-meta-string.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const scb = require('../../../src/main/sync-conflict-backups.js')

function fixture (extraEntries = []) {
  const meta = new Map(extraEntries)
  const calls = []
  const dbCall = () => (op, p) => {
    calls.push({ op, p })
    if (op === 'listMetaKeys') return [...meta.keys()]
    if (op === 'getMeta') return meta.has(String(p)) ? meta.get(String(p)) : null
    if (op === 'setMeta') { meta.set(String(p[0]), p[1]); return true }
    if (op === 'deleteMeta') { meta.delete(String(p)); return true }
    throw new Error('unexpected op ' + op)
  }
  return { ops: scb.ops(dbCall), meta, calls }
}

test('W20 P2: an object-valued META backup refuses to restore and KEEPS the backup key', () => {
  const bk = 'metaConflictBackup.someBlob.abc'
  const payload = JSON.stringify({ key: 'someBlob', value: { nested: 'object-not-a-string' }, lostAt: 1700000000000 })
  const { ops, meta, calls } = fixture([[bk, payload]])
  assert.throws(() => ops.syncConflictBackupRestore({ key: bk }), /not a string/)
  // Fail-closed: nothing was written, the backup key was not consumed.
  assert.equal(meta.has(bk), true, 'backup key preserved for a later/again attempt')
  assert.equal(meta.get(bk), payload, 'backup payload untouched')
  assert.equal(meta.has('someBlob'), false, 'no [object Object] written to the original key')
  const writes = calls.filter(c => c.op === 'setMeta' && String(c.p[0]) === 'someBlob')
  assert.equal(writes.length, 0, 'no setMeta against the original key at all')
  assert.equal(calls.filter(c => c.op === 'deleteMeta' && c.p === bk).length, 0, 'backup key never deleted')
})

test('W20 P2: a string-valued META backup still restores (regression guard on the happy path)', () => {
  const bk = 'metaConflictBackup.tomatoEstimateState.def'
  const { ops, meta } = fixture([
    [bk, JSON.stringify({ key: 'tomatoEstimateState', value: '{"t9":12}', lostAt: 1 })],
    ['tomatoEstimateState', '{"t9":99}']
  ])
  const r = ops.syncConflictBackupRestore({ key: bk })
  assert.deepEqual(r, { ok: true, key: 'tomatoEstimateState' })
  assert.equal(meta.get('tomatoEstimateState'), '{"t9":12}', 'lost string value restored verbatim')
  assert.equal(meta.has(bk), false, 'backup consumed')
})

test('W20 P2: an entity-colon META key with a string value routes to the entity branch and fails closed (meta untouched)', () => {
  // The file-head CONVENTION says meta keys must never be named `<syncable-entity>:` — the
  // prefix IS the routing decision. If a colliding meta key ever appears, the string value
  // enters the entity branch, which throws on the non-row payload without touching meta:
  // the backup is unrecoverable but NOT corrupted (fail-closed backstop).
  const bk = 'metaConflictBackup.plan:1.xyz'
  const payload = JSON.stringify({ key: 'plan:1', value: 'plain-meta-string', lostAt: 1 })
  const { ops, meta } = fixture([[bk, payload], ['plan:1', 'plain-meta-string']])
  assert.throws(() => ops.syncConflictBackupRestore({ key: bk }), /not a row object/)
  assert.equal(meta.get(bk), payload, 'backup preserved')
  assert.equal(meta.get('plan:1'), 'plain-meta-string', 'original meta untouched')
})
