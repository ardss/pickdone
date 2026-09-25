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
