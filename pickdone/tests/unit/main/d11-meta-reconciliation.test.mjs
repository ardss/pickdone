/* D11 finding 4 regression tests (meta snapshot reconciliation / oplog-trim starvation):
 *   A live user-data meta key whose oplog pointers fell out of the 10k ring used to be
 *   unsyncable FOREVER: egress snapshots enumerated meta only from retained pointers, and
 *   ingress refused every row for a live key with no local pointer (B13 age-unknown gate).
 *   Fix: the trimmed pointer still proves a BOUND — the local write happened at or before the
 *   ring's oldest retained ts (metaFloorTs). Ingress accepts an inbound row stamped NEWER than
 *   that floor; egress (metaSnapshotRows) enumerates the meta TABLE so trimmed live keys ride
 *   snapshots with the floor as their honest age bound.
 * Real better-sqlite3, fresh temp dirs (round7-sync-lww pattern; never the real %APPDATA%).
 * Run: node --test tests/unit/main/d11-meta-reconciliation.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const syncApply = require_('../../../src/main/sync-apply.js')

/** A device whose oplog RING has fully trimmed the target key's pointers: syncOplogSince reads
 *  are intercepted to return nothing (the steady state after >10k later writes), while every
 *  other op (reads AND writes) goes to the real db. */
function trimmedDevice () {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd11-meta-'))
  db.init(dir)
  const raw = (op, p) => db.call(op, p)
  const state = {
    dir,
    deviceId: 'devD11meta',
    localUserId: null,
    applyCache: null,
    applied: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    db: { call: (op, p) => (op === 'syncOplogSince' ? [] : raw(op, p)) },
  }
  return { state, raw }
}

test('finding 4 ingress: a live trimmed key accepts an inbound row stamped newer than the floor', () => {
  const { state } = trimmedDevice()
  db.call('setMeta', ['projectDeadline:d11', '2026-09-01']) // live value, pointer "trimmed" by the interceptor
  const T = Date.now() - 1000 // any real ts > floor(0) is provably newer than the trimmed local write
  const ok = syncApply.applyRowSafe(state, {
    entity: 'meta', id: 'projectDeadline:d11', seq: 9, ts: T, updatedAt: T, deleted: false, deletedAt: 0,
    data: { key: 'projectDeadline:d11', value: '2026-10-15' },
  })
  assert.equal(ok, true, 'the peer edit must LAND (was refused forever by the B13 age-unknown gate)')
  assert.equal(db.call('getMeta', 'projectDeadline:d11'), '2026-10-15', 'the peer value is now the local value')
  db.close()
})

test('finding 4 ingress: an inbound stamp at/below the floor stays refused (genuinely ambiguous)', () => {
  const { state } = trimmedDevice()
  db.call('setMeta', ['projectDeadline:d11b', '2026-09-01'])
  const ok = syncApply.applyRowSafe(state, {
    entity: 'meta', id: 'projectDeadline:d11b', seq: 9, ts: 0, updatedAt: 0, deleted: false, deletedAt: 0,
    data: { key: 'projectDeadline:d11b', value: 'stale' },
  })
  assert.equal(ok, false, 'an epoch-0 stamp proves nothing — the local live value stands')
  assert.equal(db.call('getMeta', 'projectDeadline:d11b'), '2026-09-01')
  db.close()
})

test('finding 4 egress: metaSnapshotRows enumerates live TABLE keys the trimmed oplog lost', () => {
  const { state } = trimmedDevice()
  db.call('setMeta', ['repeatRule:d11x', JSON.stringify({ mode: 'daily' })]) // user-data key
  db.call('setMeta', ['sync.flushQuarantine.todos', '[]']) // machine-local: must NOT egress
  db.call('setMeta', ['db.settingsState', '{}']) // sync blob: field-granular via the setting entity
  const rows = syncApply.metaSnapshotRows(state)
  const hit = rows.find(r => r.entity === 'meta' && r.id === 'repeatRule:d11x')
  assert.ok(hit, 'the live trimmed key rides the snapshot (was invisible: pointers-only enumeration)')
  assert.ok(!rows.some(r => r.id === 'sync.flushQuarantine.todos'), 'machine-local meta never egresses')
  assert.ok(!rows.some(r => r.id === 'db.settingsState'), 'the settings blob never egresses as meta')
  assert.equal(hit.value ?? hit.data.value, JSON.stringify({ mode: 'daily' }))
  db.close()
})

test('finding 4: metaFloorTs is the oldest retained oplog ts (the trimmed-pointer bound)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd11-meta-floor-'))
  db.init(dir)
  const t0 = Date.now() - 5000
  db.call('setMeta', ['k.floorprobe', 'a'])
  // Backdate the pointer row so the floor is unmistakable, then add a newer row.
  const Database = require_('../../../vendor/better-sqlite3-multiple-ciphers')
  const key = fs.readFileSync(path.join(dir, 'db.key'), 'utf8').trim()
  const d = new Database(path.join(dir, 'todos.db'))
  d.pragma(`key='${key}'`)
  d.prepare('UPDATE sync_oplog SET ts = ? WHERE entityId = ?').run(t0, 'k.floorprobe')
  d.close()
  db.call('setMeta', ['k.floorprobe2', 'b'])
  const state = { db: { call: (op, p) => db.call(op, p) } }
  const cache = syncApply.createHydrationCache(state)
  const floor = cache.metaFloorTs()
  assert.equal(floor, t0, 'the floor is the OLDEST retained row ts (provable upper bound for trimmed keys)')
  assert.ok(cache.metaTs().get('k.floorprobe2') > floor)
  db.close()
})
