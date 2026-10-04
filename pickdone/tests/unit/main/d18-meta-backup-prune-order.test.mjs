/**
 * D18 (2026-10-02) — sync-conflict-backups prune age order (same-millisecond base-36 rollover).
 * pruneBackups sorted backup keys lexicographically; within one millisecond the seq suffix
 * crosses a base-36 digit boundary ('...y','z','10','11'...) and '10' sorts BELOW 'z', so the
 * prune deleted the FRESHEST snapshot. D17 root-fixed the identical bug in sync-apply.js
 * (compareMetaBackupKeys parses `<ts36>-<seq36>`); sync-conflict-backups now reuses that ONE
 * comparator instead of growing a third copy of the ordering rule.
 * Run: node --test tests/unit/main/d18-meta-backup-prune-order.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { compareMetaBackupKeys } = require('../../../src/main/sync-apply.js')
const backups = require('../../../src/main/sync-conflict-backups.js')

const P = 'metaConflictBackup.'
const b36 = n => n.toString(36)

test('D17 comparator (reused by prune): same-ms seq rollover orders numerically, not lexically', () => {
  const z = P + 'k.1-' + b36(35) // seq 35 → 'z'
  const ten = P + 'k.1-' + b36(36) // seq 36 → '10'
  assert.ok(String(z) > String(ten), 'lexicographic order is WRONG here (z > 10 as strings)')
  assert.ok(compareMetaBackupKeys(ten, z) > 0, 'comparator: seq 36 is NEWER than seq 35')
  assert.ok(compareMetaBackupKeys(z, ten) < 0)
})

test('D18: pruneBackups keeps the freshest same-ms rolled-over snapshot, deletes the oldest', () => {
  // 22 snapshot keys for one base key, same ts ('1'), seqs 15..36 — the seq suffix rolls over
  // base-36 ('f'..'z','10'). Lexicographic sort ranks seq '10' (36) FIRST = "oldest", so the old
  // .sort() deleted the freshest snapshot; the parsed comparator deletes seq 'f' and 'g' (15,16).
  const seqs = []
  for (let s = 15; s <= 36; s++) seqs.push(s)
  const store = new Map()
  for (const s of seqs) store.set(P + 'k.1-' + b36(s), JSON.stringify({ key: 'k', value: 'v' + s, lostAt: 1 }))
  // the backup being restored (any parsable payload); 'k' holds a live value so the restore's
  // "a restore is itself reversible" re-backup (and its prune) actually runs.
  store.set(P + 'k.0-a', JSON.stringify({ key: 'k', value: 'restore-me', lostAt: 1 }))
  store.set('k', 'live')
  const deleted = []
  const call = (op, p) => {
    if (op === 'listMetaKeys') return [...store.keys()]
    if (op === 'getMeta') return store.has(p) ? store.get(p) : null
    if (op === 'setMeta') { store.set(p[0], p[1]); return }
    if (op === 'deleteMeta') { deleted.push(p); store.delete(p) ; return }
    throw new Error('unexpected op ' + op)
  }
  const ops = backups.ops(() => call)
  const r = ops.syncConflictBackupRestore({ key: P + 'k.0-a' })
  assert.equal(r.ok, true)
  // After the restore's re-backup there are 23 snapshot keys for 'k'; the prune keeps the newest
  // 20 by PARSED age → the three oldest (seq 15,16,17) must be gone; the rolled-over seq 36
  // ('10') must survive. Before the fix the lexicographic sort ranked seq '10' oldest of all.
  assert.ok(deleted.includes(P + 'k.1-' + b36(15)), 'oldest snapshot pruned')
  assert.ok(deleted.includes(P + 'k.1-' + b36(16)), 'second-oldest snapshot pruned')
  assert.ok(deleted.includes(P + 'k.1-' + b36(17)), 'third-oldest snapshot pruned')
  assert.ok(store.has(P + 'k.1-' + b36(36)),
    'red before the fix: lexicographic sort ranked the seq-rollover key ("...z" vs "...10") as OLDEST and pruned the freshest snapshot')
  assert.ok(!deleted.some(d => d.endsWith('-' + b36(36))), 'the freshest rolled-over snapshot is never pruned')
})
