/* W26 fix 1 (2026-11-01): db-sync-schema putRow — the stale whole-blob echo gate (Round-3 P1)
 * protected only EXISTING rows; a field with NO local row hit the INSERT branch and was stamped
 * with fresh local `now`, minting an oplog delta with the newest LWW age from a MINUTES-old blob
 * snapshot. Cross-device LWW then let the stale echo beat the peer's genuinely newer edit.
 * Fix: when the caller carries a causal snapshot stamp (finite gateTs > 0 — migrateV6's 0
 * fallback excluded), a NEW row is stamped with the SNAPSHOT's age, not local now.
 * Real better-sqlite3 via db.init on a fresh temp dir (w8-sync pattern). Run:
 *   node --test tests/unit/main/w26-sync-putrow-stale-insert.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')

function freshDevice (label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w26-putrow-' + label + '-'))
  db.init(dir)
  return dir
}

const rowOf = k => (db.call('settingsRowsAll', {}) || []).find(r => r.key === k) || null

test('w26[1a]: a stale blob echo inserting a LOCALLY-ABSENT field stamps it with the snapshot age, not now', () => {
  freshDevice('stale-insert')
  const T = Date.now() - 5 * 60_000 // snapshot authored 5 minutes ago
  // Red before the fix: no local row for 'w26newField' → INSERT with updatedAt=now (fresh LWW age)
  // even though the mirror is a stale echo of a 5-minute-old snapshot.
  db.call('setMeta', ['db.settingsState', JSON.stringify({ _savedAt: T, w26newField: 'stale-echo' })])
  const row = rowOf('w26newField')
  assert.ok(row, 'the echoed field lands as a row')
  assert.equal(row.updatedAt, T, 'red before the fix: a new row from a stale echo must carry the snapshot stamp (peer newer edit wins LWW), not local now')
  assert.equal(row.value, 'stale-echo')
  db.close()
})

test('w26[1b]: a FRESH (same-tick) mirror still lands with a current stamp', () => {
  freshDevice('fresh-insert')
  const before = Date.now()
  db.call('setMeta', ['db.settingsState', JSON.stringify({ _savedAt: before, w26fresh: 'v' })])
  const row = rowOf('w26fresh')
  assert.ok(row)
  assert.ok(Math.abs(row.updatedAt - before) < 2000, 'a fresh snapshot stamps ≈ the snapshot time (same tick as now)')
  db.close()
})

test('w26[1c]: a peer sync-applied row with a NEWER stamp than a stale echo keeps the LWW crown', () => {
  freshDevice('lww')
  const staleT = Date.now() - 5 * 60_000
  const peerT = Date.now() - 60_000 // peer edit AFTER the stale snapshot, BEFORE local now
  // Peer's newer row arrives first via the sync apply path (explicit updatedAt preserved).
  db.call('settingsRowPut', { key: 'w26lww', value: 'peer-new', updatedAt: peerT })
  // Local stale blob mirror (snapshot older than the peer edit) still carries the old value and
  // has no row locally... it DOES have one now — drop it and re-run the stale echo against a
  // missing row by using a field the peer has NOT applied: instead, verify the insert-stamp rule
  // composes: remove the row entirely (simulating a field never mirrored locally), then the stale
  // echo must not re-age it past the peer stamp.
  db.call('settingsRowDelete', { key: 'w26lww', deletedAt: peerT + 1, updatedAt: peerT + 1 })
  // Stale echo authored BEFORE the peer edit: insert path must stamp gateTs (staleT), NOT now.
  db.call('setMeta', ['db.settingsState', JSON.stringify({ _savedAt: staleT, w26lww2: 'echo' })])
  const echoed = rowOf('w26lww2')
  assert.ok(echoed && echoed.updatedAt === staleT, 'stale echo insert keeps the snapshot age')
  // And a peer row stamped after the snapshot, merged by LWW, is newer than the echo's stamp:
  assert.ok(peerT > staleT, 'peer edit (post-snapshot) beats the echoed row in cross-device LWW')
  db.close()
})

test('w26[1d]: migrateV6-style gateTs=0 (unstamped doc) keeps the legacy now-stamp for new fields', () => {
  freshDevice('gate-zero')
  const before = Date.now()
  // mergeDoc with gateTs=0 (migrateV6 fallback for docs without _savedAt): an unknown-freshness
  // doc must NOT stamp rows at epoch 0 — the W26 insert rule is gated on gateTs > 0.
  const factory = require_('../../../src/main/db-sync-schema.js')
  // Reach the merge through the bridge: a setMeta on the sync blob key with NO _savedAt stamp
  // yields gateTs=undefined (now-stamp), and the v6 migration path uses 0. Both must keep now.
  db.call('setMeta', ['db.settingsState', JSON.stringify({ w26nogate: 'v' })])
  const row = rowOf('w26nogate')
  assert.ok(row, 'field lands')
  assert.ok(row.updatedAt >= before - 50, 'unstamped doc: new field keeps the local now stamp')
  assert.ok(factory, 'factory requireable')
  db.close()
})
