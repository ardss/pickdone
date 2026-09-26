/** D10 (2026-09-27): winner-snapshot keys in syncConflictBackupRestore used Date.now().toString(36)
 *  as their ONLY suffix — two restores for the same originalKey within the same millisecond minted
 *  the identical snapKey and the second setMeta silently overwrote the first winner snapshot,
 *  destroying the pre-first-restore copy. Snapshot keys now carry a monotonic counter suffix.
 * Run: node --test tests/unit/lan-sync/d10-conflict-snapkey-collision.test.mjs */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const db = require('../../../src/main/db.js')
const scb = require('../../../src/main/sync-conflict-backups.js')

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'd10-snapkey-'))
const BACKUP_PREFIX = 'metaConflictBackup.'

test('d10: two same-millisecond restores keep TWO distinct winner snapshots with distinct values', () => {
  const dir = tmp()
  db.init(dir)
  const ops = scb.ops(() => (op, p) => db.call(op, p))

  // Seed two backups for the SAME originalKey, to be restored back-to-back (same ms).
  const b1 = BACKUP_PREFIX + 'plan:sk_c1.restore-a'
  const b2 = BACKUP_PREFIX + 'plan:sk_c1.restore-b'
  db.call('setMeta', [b1, JSON.stringify({ key: 'plan:sk_c1', value: { id: 'sk_c1', taskId: 'sk_t', day: '2026-09-26', mm: '09:00', sort: 1 }, lostAt: 1 })])
  db.call('setMeta', [b2, JSON.stringify({ key: 'plan:sk_c1', value: { id: 'sk_c1', taskId: 'sk_t', day: '2026-09-27', mm: '10:00', sort: 2 }, lostAt: 2 })])
  // live winner BEFORE any restore (this is the copy the first restore's snapshot must preserve)
  db.call('planAddMany', [{ id: 'sk_c1', taskId: 'sk_t', day: '2026-09-28', mm: '11:00', sort: 3 }])

  const realNow = Date.now
  Date.now = () => 1_700_000_000_000 // frozen: both restores land in the same millisecond
  try {
    const r1 = ops.syncConflictBackupRestore({ key: b1 })
    assert.equal(r1.ok, true)
    const r2 = ops.syncConflictBackupRestore({ key: b2 })
    assert.equal(r2.ok, true)
  } finally { Date.now = realNow }

  // Both winner snapshots must survive under DISTINCT keys with DISTINCT values:
  //   snap#1 = the live row before restore #1 (day 2026-09-28),
  //   snap#2 = the restored row before restore #2 (day 2026-09-26).
  const snaps = db.call('listMetaKeys').map(String)
    .filter(k => k.startsWith(BACKUP_PREFIX + 'plan:sk_c1.'))
    .map(k => ({ k, v: JSON.parse(db.call('getMeta', k)) }))
  assert.equal(snaps.length, 2, 'red before the fix: the second same-ms snapshot overwrote the first')
  const days = snaps.map(s => s.v.value.day).sort()
  assert.deepEqual(days, ['2026-09-26', '2026-09-28'], 'both pre-restore copies preserved with their own values')
})
