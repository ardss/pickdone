/* sync-apply-conflict-backup-ms-collision (2026-09-26): writeMetaConflictBackup derived its
 * backup key from Date.now().toString(36) ALONE — two conflict backups of the SAME base key
 * minted within one millisecond (realistic in the bulk apply loop) produced identical keys and
 * the second setMeta silently overwrote the first: the earlier losing value was permanently
 * lost. The same Date.now() idiom existed for the todo conflict copyId. Both now mix in a
 * process-lifetime monotonic counter, preserving the lexicographic prune order.
 * Run: node --test tests/unit/sync-apply-meta-conflict-backup.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const syncApply = createRequire(import.meta.url)('../../src/main/sync-apply.js')

/** In-memory meta table + frozen clock, wired through the same busWrite path as production. */
function mockState () {
  const meta = new Map()
  const state = {
    deviceId: 'local',
    localUserId: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    db: {
      call (op, p) {
        if (op === 'setMeta') { meta.set(p[0], p[1]); return true }
        if (op === 'listMetaKeys') return [...meta.keys()]
        if (op === 'deleteMeta') { meta.delete(p); return true }
        if (op === 'getMeta') return meta.has(p) ? meta.get(p) : null
        if (op === 'getAll') return []
        return null
      },
    },
  }
  return state
}

test('two conflict backups of the same base key in the SAME millisecond both survive', () => {
  const realNow = Date.now
  Date.now = () => 1700000000000 // frozen: every mint lands in the same ms (the collision setup)
  try {
    const state = mockState()
    syncApply.writeMetaConflictBackup(state, 'projectCategoryIds', 'loser-ONE')
    syncApply.writeMetaConflictBackup(state, 'projectCategoryIds', 'loser-TWO')
    const backupKeys = [...state.db.call('listMetaKeys')].filter(k => k.startsWith('metaConflictBackup.projectCategoryIds.'))
    assert.equal(backupKeys.length, 2, 'THE FIX: two DISTINCT backup keys (pre-fix the 2nd overwrote the 1st)')
    const values = backupKeys.sort().map(k => JSON.parse(state.db.call('getMeta', k)).value)
    assert.deepEqual(values.sort(), ['loser-ONE', 'loser-TWO'], 'BOTH losing values are recoverable')
    // the count-based prune still keeps lexicographic order (ts36 dominates; counter orders ties)
    const sorted = [...backupKeys].sort()
    assert.equal(sorted[backupKeys.length - 1] >= sorted[0], true)
  } finally {
    Date.now = realNow
  }
})

test('meta conflict backups for DIFFERENT keys in the same ms stay independent and prunable', () => {
  const realNow = Date.now
  Date.now = () => 1700000000000
  try {
    const state = mockState()
    for (let i = 0; i < 5; i++) syncApply.writeMetaConflictBackup(state, 'k' + i, 'v' + i)
    for (let i = 0; i < 5; i++) {
      const keys = [...state.db.call('listMetaKeys')].filter(k => k.startsWith('metaConflictBackup.k' + i + '.'))
      assert.equal(keys.length, 1)
      assert.equal(JSON.parse(state.db.call('getMeta', keys[0])).value, 'v' + i)
    }
  } finally {
    Date.now = realNow
  }
})

/* ---------------- D17 (2026-10-02): prune age order is PARSED (ts, seq), not string order ----------------
 * Within one ms the base-36 counter crosses a digit boundary: seq 35 → 'z', seq 36 → '10'. A raw
 * lexicographic sort ranks '10' BELOW 'z', so the NEWEST backup sorted as if oldest and the
 * count-based prune deleted the freshest losing value. */

test('D17: comparator orders the seq rollover numerically (z=35 < 10=36)', () => {
  const { compareMetaBackupKeys } = syncApply
  const z = 'metaConflictBackup.k.abc-z' // seq 35
  const ten = 'metaConflictBackup.k.abc-10' // seq 36 — lexicographically BELOW 'z'
  assert.ok(compareMetaBackupKeys(z, ten) < 0, "'10' (newer) must sort ABOVE 'z' (older)")
  assert.ok(compareMetaBackupKeys(ten, z) > 0)
  assert.ok(compareMetaBackupKeys(z, z) === 0)
  assert.ok(compareMetaBackupKeys('metaConflictBackup.k.junk', z) < 0, 'unparsable keys sort oldest (pruned first)')
  assert.ok(compareMetaBackupKeys('metaConflictBackup.k.a-5', 'metaConflictBackup.k.b-1') < 0, 'ts dominates seq across milliseconds')
})

test('D17: the count-based prune keeps the numerically NEWEST backups across the seq rollover', () => {
  const realNow = Date.now
  Date.now = () => 1700000000000 // frozen: all 40 mints share one ms → the counter crosses 'z'→'10'
  try {
    const state = mockState()
    const minted = []
    const origCall = state.db.call.bind(state.db)
    state.db.call = (op, p) => {
      if (op === 'setMeta') minted.push(p[0])
      return origCall(op, p)
    }
    const MINTS = 40 // 36+ mints guarantee the base-36 rollover ('z' → '10') inside the window
    for (let i = 0; i < MINTS; i++) syncApply.writeMetaConflictBackup(state, 'roll', 'loser-' + i)
    assert.equal(minted.length, MINTS)
    const kept = [...state.db.call('listMetaKeys')].filter(k => k.startsWith('metaConflictBackup.roll.'))
    assert.equal(kept.length, syncApply.META_CONFLICT_BACKUP_CAP)
    const { parseMetaBackupKeySuffix } = syncApply
    const keptSeqs = kept.map(parseMetaBackupKeySuffix).map(p => p.seq).sort((a, b) => a - b)
    // The 40 minted seqs are S..S+39 (whatever the shared counter started at); the kept 20 must be
    // exactly the LAST 20 minted. Under the old lexicographic prune, the post-rollover keys
    // ('10','11',...) sorted as if oldest and the freshest losers were deleted instead.
    const mintedSeqs = minted.map(parseMetaBackupKeySuffix).map(p => p.seq)
    const expected = mintedSeqs.slice(MINTS - syncApply.META_CONFLICT_BACKUP_CAP).sort((a, b) => a - b)
    assert.ok(mintedSeqs.some(s => String(s).length > 1), 'setup: the window actually crossed the digit rollover')
    assert.deepEqual(keptSeqs, expected, 'red before the fix: the newest (post-rollover) losers were pruned first')
  } finally {
    Date.now = realNow
  }
})
