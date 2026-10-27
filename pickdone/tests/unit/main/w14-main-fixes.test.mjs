/**
 * W14 (2026-10-27) main-process fix batch regression:
 *   - Bug2 (P1): tomatoAppendMany counts a tombstone-gated (changes=0) upsert as rejected —
 *     it used to count accepted while never landing, so the sync flush acked the segment and
 *     the sender's push watermark advanced past a row that exists nowhere (one-way loss).
 *   - Bug3 (P2): the fresh-install encryption rebuild aborts when the plaintext todos.db
 *     cannot be deleted (rmSync swallowed) — the session used to keep running on the OLD
 *     plaintext db with an inert PRAGMA key, and the next boot read dbEncMismatch ("data
 *     all lost"). -wal/-shm failures stay tolerable.
 *   - Bug4 (P2): computeMetaGc accepts ANY dot-free id in the stamped
 *     `catFiltersBak.<deletedAt>.<id>` shape (non-numeric victim ids leaked forever under
 *     the digit-only regex, falling into the never-expiring legacy rule).
 *   - Bug5 (P3): quit-ack abandon() enforces the same expected-set membership as ack().
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const db = require('../../../src/main/db.js')
const { computeMetaGc } = require('../../../src/main/handlers/shared.js')
const { createQuitAckTracker } = require('../../../src/main/quit-ack.js')

const rec = over => Object.assign({
  tomatoId: 'tmt_w14_' + Math.random().toString(36).slice(2),
  endTime: Date.now(), dateKey: '', focus: '', focusTaskId: null,
  focusDuration: 25, rest: 5, restDuration: 5, succeed: true, manual: false,
  status: 'local', abandonReason: ''
}, over)

// ===== Bug2: tombstone-gated tomatoAppendMany rows count as rejected =====

test('w14 tomatoAppendMany: a stale re-append onto a tombstone is rejected (tombstone-gated), never counted accepted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w14-tomato-'))
  db.init(dir)
  try {
    const T = Date.now() - 60000
    db.call('tomatoAppendMany', rec({ tomatoId: 'tmt_w14_gate', endTime: T }))
    db.call('tomatoRemoveByIds', [{ tomatoId: 'tmt_w14_gate', deletedAt: T + 5000, updatedAt: T + 5000 }])
    // Stale sync re-push: updatedAt strictly older than the tombstone's deletedAt → the
    // DO UPDATE gate blocks the write (changes=0). Must count as REJECTED, not accepted.
    const r1 = db.call('tomatoAppendMany', [{ ...rec({ tomatoId: 'tmt_w14_gate', endTime: T + 1000 }), updatedAt: T + 1000 }])
    assert.equal(r1.accepted, 0, 'a gated row must not be counted accepted')
    assert.equal(r1.rejected.length, 1, 'the gated row must surface in rejected (flush quarantines + renderer drops it)')
    assert.equal(r1.rejected[0].reason, 'tombstone-gated')
    assert.equal(r1.rejected[0].index, 0)
    assert.ok(db.call('tomatoTombstones').some(x => x.tomatoId === 'tmt_w14_gate'), 'the tombstone stands (no resurrection)')
    // LWW-newer re-append still lands (the gate allows resurrection by a newer stamp).
    const r2 = db.call('tomatoAppendMany', [{ ...rec({ tomatoId: 'tmt_w14_gate', endTime: T + 2000 }), updatedAt: T + 9999 }])
    assert.equal(r2.accepted, 1)
    assert.equal(r2.rejected.length, 0)
    assert.ok(db.call('tomatoAll').some(x => x.tomatoId === 'tmt_w14_gate'), 'a newer legitimate re-append lands')
    // Live-row idempotent re-land still accepted (gate passes, changes=1).
    const r3 = db.call('tomatoAppendMany', [{ ...rec({ tomatoId: 'tmt_w14_gate', endTime: T + 2000 }), updatedAt: T + 9999 }])
    assert.equal(r3.accepted, 1, 're-landing a live row (upsert merge) remains accepted')
  } finally {
    try { db.close() } catch { /* temp db teardown best-effort */ }
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp dir best-effort */ }
  }
})

// ===== Bug3: fresh-install encryption rebuild aborts when the plaintext file survives =====

test('w14 db fresh-install rebuild: un-deletable plaintext todos.db aborts init instead of running plaintext', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w14-enc-'))
  const origRm = fs.rmSync
  fs.rmSync = (p, opts) => {
    if (String(p).endsWith('todos.db')) {
      const e = new Error("EPERM: operation not permitted, unlink '" + p + "'")
      e.code = 'EPERM'
      throw e
    }
    return origRm(p, opts)
  }
  let threw = null
  try {
    try { db.init(dir) } catch (e) { threw = e }
  } finally { fs.rmSync = origRm }
  assert.ok(threw, 'init must NOT silently continue on the old plaintext db')
  assert.match(String(threw && threw.message), /加密重建失败|删除不掉/)
  assert.equal(fs.existsSync(path.join(dir, 'todos.db')), true, 'the plaintext db is still there — no rebuild may have happened over it')
  assert.equal(fs.existsSync(path.join(dir, 'db.key')), false, 'no db.key may be written once the rebuild aborted')
  // Recovery path still works: a normal init on the same dir now succeeds (encrypts fresh).
  db.init(dir)
  assert.equal(db.isOpen(), true)
  try { db.close() } catch { /* teardown best-effort */ }
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* temp dir best-effort */ }
})

// ===== Bug4: catFiltersBak GC accepts non-numeric victim ids in the stamped shape =====

test('w14 computeMetaGc: stamped catFiltersBak keys with non-numeric ids expire by timestamp', () => {
  const now = 1800000000000
  const retentionMs = 30 * 86400000
  const deadTs = now - retentionMs - 1000
  const freshTs = now - 1000
  const cats = [{ id: 'catA' }, { id: 'catB' }]
  const keys = [
    'catFiltersBak.' + deadTs + '.cat-victim-xyz', // non-numeric victim id, expired
    'catFiltersBak.' + freshTs + '.cat-victim-xyz', // non-numeric victim id, inside window
    'catFiltersBak.' + deadTs + '.12345', // numeric victim id, expired (old shape still works)
    'catFiltersBak.legacy-dead-id', // legacy unstamped, dead id → conservatively kept
    'catFiltersBak.catA', // legacy unstamped, live id → stale orphan, GC'd
  ]
  const out = computeMetaGc(keys, cats, [], { now, catFiltersBakRetentionMs: retentionMs })
  assert.ok(out.includes('catFiltersBak.' + deadTs + '.cat-victim-xyz'), 'expired stamped key with a NON-NUMERIC id must GC (was leaked forever)')
  assert.ok(!out.includes('catFiltersBak.' + freshTs + '.cat-victim-xyz'), 'stamped key inside the recover window stays')
  assert.ok(out.includes('catFiltersBak.' + deadTs + '.12345'), 'numeric-id stamped key still GCs by timestamp')
  assert.ok(!out.includes('catFiltersBak.legacy-dead-id'), 'legacy unstamped dead-id key is still conservatively kept')
  assert.ok(out.includes('catFiltersBak.catA'), 'legacy unstamped live-id orphan still GCs')
})

// ===== Bug5: quit-ack abandon enforces expected-set membership =====

test('w14 quit-ack abandon: a stale webContents id from an aborted round cannot decrement the current round', () => {
  const t = createQuitAckTracker()
  const tok1 = t.nextToken()
  t.beginRound([101, 102], tok1)
  t.abandon(101) // round 1 progress (never completed — quit aborted)
  // Round 2 opens on a DIFFERENT sender set; round-1 leftovers must not count here.
  const tok2 = t.nextToken()
  t.beginRound([201, 202], tok2)
  assert.equal(t.abandon(999), false, 'an id we never sent to must be ignored (was: expected decremented to early-ack)')
  assert.equal(t.abandon(101), false, 'a stale id from the previous round must be ignored')
  assert.equal(t.abandon(201), true, 'a real member abandons normally')
  assert.equal(t.allAcked(), false, 'expected must still be 2 — the round cannot be satisfied prematurely')
  assert.equal(t.ack(tok2, 202), true)
  assert.equal(t.allAcked(), true, 'all genuine members accounted → allAcked')
})

test('w14 quit-ack abandon: legacy count-based rounds keep the old behavior', () => {
  const t = createQuitAckTracker()
  const tok = t.nextToken()
  t.beginRound(2, tok) // legacy COUNT form: no membership set, any sender may abandon/ack
  assert.equal(t.abandon(777), true, 'legacy form has no membership gate')
  assert.equal(t.allAcked(), false)
  assert.equal(t.ack(tok, 888), true)
  assert.equal(t.allAcked(), true)
})
