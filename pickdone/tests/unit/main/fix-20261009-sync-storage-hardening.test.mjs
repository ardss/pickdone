/* Fix round 2026-10-09 (sync/storage hardening):
 * 1. habits blob bridge gate: the setMeta→settings_rows bridge derived its LWW gate from
 *    doc._savedAt only, but the habits writer stamps `savedAt` — every habits mirror write
 *    ran with gateTs=undefined, so stale echoes re-stamped newer rows (revert loop) and
 *    removed fields were never tombstoned (resurrection loop).
 * 2. tomatoAppendMany oplog: params-side id expansion emitted a delta pointer for locally
 *    REJECTED rows — peers hydrated a ghost tombstone and deleted their live copy.
 * 3. tomatoAppendMany upsert: `deleted=0` unconditionally resurrected a tombstone when a
 *    late-landing append raced a newer removal.
 * 4. plan/filter delete-wins early return dropped the losing live edit with NO conflict
 *    backup (it fired before mergeCore / the B16 backup branch).
 * 5. flush-quarantine stored the FULL dropped row set per entry — unbounded bytes.
 * 9. selectPrunes ranked `-dup<n>` collision names by their base stamp lexicographically,
 *    so a same-second dup burst evicted real snapshots from the recent-N tier (D17 says a
 *    dup parses as ts=0, never shadowing a real snapshot).
 * Run: node --test tests/unit/main/fix-20261009-sync-storage-hardening.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const oplogMod = require_('../../../src/main/db-oplog.js')
const autoBackup = require_('../../../src/main/autoBackup.js')
const syncApply = require_('../../../src/main/sync-apply.js')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fix-20261009-storage-'))
db.init(dir)
const rowOf = k => db.call('settingsRowsAll', {}).find(r => r.key === k) || null

/* ---------- Fix 1: bridge gate accepts either stamp spelling ---------- */

test('fix1: a habits-shaped blob ({savedAt}) produces a finite gate — stale echo cannot revert a newer row', () => {
  const T = Date.now() - 60000 // blob snapshot taken a minute ago
  const blob = JSON.stringify({ savedAt: T, habitField: 'v1' })
  db.call('setMeta', ['db.habitsState', blob])
  assert.equal(rowOf('habitField').value, 'v1')
  // A sync-applied row lands AFTER the snapshot: genuinely newer than the blob.
  db.call('settingsRowPut', { key: 'habitField', value: 'applied-by-sync', updatedAt: T + 30000 })
  assert.equal(rowOf('habitField').value, 'applied-by-sync')
  // The stale echo re-mirrors the OLD blob (its savedAt predates the applied row).
  db.call('setMeta', ['db.habitsState', blob])
  assert.equal(rowOf('habitField').value, 'applied-by-sync',
    'the gated bridge must skip the stale echo (pre-fix: gateTs=undefined re-stamped the old value)')
})

test('fix1: a habits blob tombstones its own removed rows but never cross-family rows (family scoping)', () => {
  const T = Date.now() - 60000
  // Real habits writer shape (store/habits.js persist): {schemaV, habits, moments, savedAt}.
  // Row authored BEFORE the snapshot: its absence from the doc proves a real removal.
  db.call('settingsRowPut', { key: 'habits', value: 'old', updatedAt: T - 1000 })
  // Cross-family row: the habits blob is NOT its writer — absence proves nothing (Sync-10b pin).
  db.call('settingsRowPut', { key: 'themeMode', value: 'dark', updatedAt: T - 1000 })
  db.call('setMeta', ['db.habitsState', JSON.stringify({ savedAt: T, moments: [] })])
  assert.equal(rowOf('habits').deleted, true,
    'removed-from-doc habits-family row older than the snapshot stamp must be tombstoned')
  assert.equal(rowOf('themeMode').deleted, false,
    'a habits blob must never tombstone settings-family rows it does not own')
})

/* ---------- Fix 2: tomatoAppendMany oplog drops rejected ids ---------- */

test('fix2: a rejected tomatoId never appears in the tomatoAppendMany delta', () => {
  const ol = oplogMod({ getDb: () => ({}), log: { warn () {}, error () {} } })
  const params = [
    { tomatoId: 'good-1', endTime: 123 },
    { tomatoId: 'bad-1', endTime: 'not-a-number' },
  ]
  const result = { accepted: 1, rejected: [{ index: 1, tomatoId: 'bad-1', reason: 'endTime required' }] }
  const entries = ol.oplogEntriesFor('tomatoAppendMany', params, result)
  const ids = entries.map(e => e.entityId)
  assert.deepEqual(ids, ['good-1'], 'only accepted ids mint deltas')
  assert.equal(ids.includes('bad-1'), false, 'a rejected id must not emit a ghost tombstone pointer')
})

/* ---------- Fix 3: append never resurrects a tombstone ---------- */

test('fix3: append → remove → re-append the same tomatoId keeps the row deleted', async () => {
  const rec = { tomatoId: 'fix3-race', endTime: Date.now() - 5000, focus: 'task', focusDuration: 1, succeed: true }
  db.call('tomatoAppendMany', [rec])
  assert.ok(db.call('tomatoGetById', 'fix3-race'), 'first append lands live')
  db.call('tomatoRemoveByIds', ['fix3-race'])
  assert.equal(db.call('tomatoGetById', 'fix3-race'), null, 'removal tombstones the row')
  // Late-landing append of the SAME id (in-flight race / stale peer row) must NOT resurrect.
  // Refined contract (2026-10-11): the arbiter is LWW — an append older than the tombstone's
  // deletedAt is a stale echo and stays blocked; an append NEWER than the remove is a genuine
  // re-record of the same deterministic id (unit-db-ledger: 删除-再补录) and resurrects.
  db.call('tomatoAppendMany', [{ ...rec, focus: 'late-landing', updatedAt: Date.now() - 60000 }])
  assert.equal(db.call('tomatoGetById', 'fix3-race'), null,
    'an append must never resurrect a tombstone (pre-fix: upsert set deleted=0 unconditionally)')
  assert.ok(db.call('tomatoTombstones', {}).some(t => t.tomatoId === 'fix3-race'), 'stale append: tombstone survives')
  // a NEWER append (updatedAt after the remove) is a legitimate re-record and resurrects:
  await new Promise(r => setTimeout(r, 3))
  db.call('tomatoAppendMany', [{ ...rec, focusDuration: 40 }])
  const revived = db.call('tomatoGetById', 'fix3-race')
  assert.ok(revived && !revived.deleted, 'fresh re-record (updatedAt > deletedAt) resurrects as a new fact')
  assert.equal(revived.focusDuration, 40, 'the re-record payload wins')
  // The WHERE guard must not break the normal upsert path: re-appends of LIVE rows still merge.
  const live = { tomatoId: 'fix3-live', endTime: Date.now() - 4000, focus: 'first', focusDuration: 2, succeed: true }
  db.call('tomatoAppendMany', [live])
  db.call('tomatoAppendMany', [{ ...live, focus: 'merged' }])
  const merged = db.call('tomatoGetById', 'fix3-live')
  assert.ok(merged, 'live-row re-append lands')
  assert.equal(merged.focus, 'merged', 'the re-append merged into the live row')
})

/* ---------- Fix 4: plan/filter delete-wins backs up the losing edit ---------- */

function mockState (tables = {}) {
  const calls = []
  const state = {
    calls,
    deviceId: 'local-device',
    localUserId: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    db: { call (op, params) { calls.push({ op, params }); return tables[op] ? tables[op](params) : null } },
  }
  return { state, calls }
}
const opCalls = (m, op) => m.calls.filter(c => c.op === op)

test('fix4: delete-wins on a plan with a newer peer edit materializes a metaConflictBackup key', () => {
  const m = mockState({
    planAll: () => [], // live lookup misses: local row is a tombstone
    planTombstones: () => [{ id: 'fix4-chip', updatedAt: 500, deletedAt: 500 }],
    listMetaKeys: () => [],
  })
  // Peer edit authored BEFORE our deletion (updatedAt 200 < deletedAt 500): delete wins.
  const ok = syncApply.applyRowSafe(m.state, {
    entity: 'plan', id: 'fix4-chip', seq: 9, ts: 200, updatedAt: 200, deleted: false, deletedAt: 0,
    data: { id: 'fix4-chip', taskId: 't1', day: '2026-10-09', deleted: 0, updatedAt: 200 },
  })
  assert.equal(ok, false, 'delete-wins: the tombstone stands, nothing applied')
  const setMeta = opCalls(m, 'setMeta')
  assert.equal(setMeta.length, 1, 'the losing peer edit must be backed up (pre-fix: silently dropped)')
  const [backupKey, payload] = setMeta[0].params
  assert.ok(String(backupKey).startsWith('metaConflictBackup.plan:fix4-chip.'), 'entity-scoped machine-local backup key: ' + backupKey)
  const parsed = JSON.parse(payload)
  assert.equal(parsed.key, 'plan:fix4-chip')
  assert.equal(parsed.value.day, '2026-10-09', 'the LOSING content survives')
  assert.equal(syncApply.isMachineLocalMetaKey(backupKey), true, 'backup never syncs back')
  const round = syncApply.consumeAppliedRound(m.state)
  assert.ok(round && round.conflicts.some(c => c.entity === 'plan' && c.name === 'fix4-chip'),
    'the conflict is surfaced in the round summary')
})

test('fix4: delete-wins on a filter with a newer peer edit also backs up the loser', () => {
  const m = mockState({
    filterList: () => [],
    filterTombstones: () => [{ id: 7, updatedAt: 900, deletedAt: 900 }],
    listMetaKeys: () => [],
  })
  const ok = syncApply.applyRowSafe(m.state, {
    entity: 'filter', id: '7', seq: 9, ts: 300, updatedAt: 300, deleted: false, deletedAt: 0,
    data: { id: 7, name: 'peer-filter', deleted: 0, updatedAt: 300 },
  })
  assert.equal(ok, false)
  const setMeta = opCalls(m, 'setMeta')
  assert.equal(setMeta.length, 1)
  assert.ok(String(setMeta[0].params[0]).startsWith('metaConflictBackup.filter:7.'))
})

/* ---------- Fix 5: flush-quarantine bytes are bounded ---------- */

test('fix5: a huge dropped row set is stored as a bounded sample; the summary still reports the total', () => {
  const stored = {}
  const m = mockState({
    getMeta: k => (k in stored ? stored[k] : null),
    listMetaKeys: () => Object.keys(stored),
    // setMeta records the quarantine blob (mockState passes ONE params arg: [k, v]);
    // every BULK op throws (the poison-flush scenario).
    setMeta: p => { stored[p[0]] = p[1] },
  })
  const origCall = m.state.db.call
  m.state.db.call = (op, params) => {
    if (!(op === 'getMeta' || op === 'listMetaKeys' || op === 'setMeta')) throw new Error('poison bulk op: ' + op)
    return origCall(op, params)
  }
  const big = Array.from({ length: 5000 }, (_, i) => ({ taskId: 't' + i, taskContent: 'x'.repeat(200) }))
  m.state.pendingWrites.todos = big
  const res = syncApply.flushPendingWrites(m.state)
  assert.equal(res.ok, true, 'quarantine parking succeeded — the ack is not failed')
  assert.equal(res.quarantined.length, 1)
  const qkey = syncApply.META_FLUSH_QUARANTINE_PREFIX + 'upsertMany'
  const blob = stored[qkey]
  assert.ok(blob, 'quarantine blob stored')
  assert.ok(blob.length < 64 * 1024, 'stored blob stays bounded (pre-fix: ~1MB+ full row set), got ' + blob.length)
  const parked = JSON.parse(blob)
  const entry = parked[parked.length - 1]
  assert.equal(entry.count, 5000, 'entry reports the TRUE dropped count')
  assert.equal(entry.rows.length, syncApply.QUARANTINE_ROW_SAMPLE + 1, 'bounded sample + one truncation marker')
  assert.deepEqual(entry.rows[entry.rows.length - 1], { truncated: true, omitted: 5000 - syncApply.QUARANTINE_ROW_SAMPLE })
  // The recovery surface keeps working on the truncated shape.
  const summary = require_('../../../src/main/flush-quarantine-view.js').summarizeFlushQuarantine({ call: (op, p) => origCallImpl(op, p) })
  function origCallImpl (op, p) {
    if (op === 'listMetaKeys') return Object.keys(stored)
    if (op === 'getMeta') return stored[p] != null ? stored[p] : null
    return null
  }
  const q = summary.find(s => s.op === 'upsertMany')
  assert.ok(q, 'quarantine summary lists the op')
  assert.equal(q.count, 5000, 'summary reports the full dropped count')
})

/* ---------- Fix 9: dup collision names never shadow real snapshots ---------- */

test('fix9: a same-second dup burst does not evict real snapshots from the recent tier', () => {
  const dups = Array.from({ length: 30 }, (_, i) => `auto-20261001-120000-dup${i + 1}.json`)
  const reals = [
    'auto-20261001-120000.json', // same second as the dup burst
    'auto-20260925-090000.json',
    'auto-20260920-090000.json',
    'auto-20260915-090000.json',
    'auto-20260910-090000.json',
  ]
  const prunes = autoBackup.selectPrunes([...dups, ...reals], { recent: 24, dailyDays: 0, weeklyWeeks: 0 })
  for (const real of reals) {
    assert.equal(prunes.includes(real), false,
      'real snapshot ' + real + ' must survive the recent tier (pre-fix: dup names ranked by base stamp and evicted it)')
  }
  // The dups themselves are prunable bookkeeping: with the reals kept, the recent tier has
  // room for only 19 dups — at least the OLDEST dups must be pruned.
  assert.ok(dups.some(d => prunes.includes(d)), 'dup names are pruned before real snapshots')
  // D17 semantics preserved: a dup name parses as ts=0 through the rank (real snapshots
  // always outrank dups even when their stamps are older).
  const prunes2 = autoBackup.selectPrunes(['auto-20201001-000000.json', 'auto-20261001-120000-dup1.json'], { recent: 1, dailyDays: 0, weeklyWeeks: 0 })
  assert.deepEqual(prunes2, ['auto-20261001-120000-dup1.json'], 'an ancient real beats a fresh dup burst for the recent slot')
})

/* ---------- Fix 3 sanity: tomato module export shape unchanged ---------- */

test('fix3b: tomatoAppendMany still reports the {accepted, rejected} contract', () => {
  const viaDb = db.call('tomatoAppendMany', [
    { tomatoId: 'fix3b-ok', endTime: Date.now() - 1000 },
    { tomatoId: '', endTime: Date.now() - 1000 },
  ])
  assert.equal(typeof viaDb.accepted, 'number')
  assert.ok(Array.isArray(viaDb.rejected) && viaDb.rejected.length === 1, 'rejected row surfaced per-row')
})
