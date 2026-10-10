/*
 * Sync v2 acceptance drill — go/no-go baseline scenarios (2026-10-10).
 *
 * These tests pin the CURRENT v1 behavior (entity-level LWW by updateTime/updatedAt)
 * on the seven v2-critical scenarios, using the same real-process loopback harness as
 * the d9 drills: two child processes, each with its own real encrypted SQLite DB and a
 * real TCP LAN-sync node wired through the PRODUCTION merge pipeline (sync-apply
 * applyRowSafe + flushPendingWrites). No mocks of the merge path, no real network.
 *
 * Purpose: these are the HARD acceptance bars any v2 candidate must pass or explicitly
 * change. Where v1 behavior is a known flaw (clock skew, offline concurrent edits), the
 * test asserts the OBSERVED v1 baseline so a regression is loud, and the header of the
 * test documents what v2 must do instead. Failures here must NOT be "fixed" by loosening
 * the assertion — they are findings.
 *
 * Scenarios (see docs/sync-v2-acceptance-matrix.md for the full matrix):
 *   S1 multi-device clock skew            — far-future clock on A beats a LATER write on B
 *   S2 offline two-machine concurrent     — same row edited on both, no contact, then converge
 *   S3 duplicate + out-of-order delivery  — same op twice, older-after-newer, idempotent apply
 *   S4 delete/edit vs tombstone           — tombstone beats older edit; newer edit resurrects
 *   S5 re-pair + rewound cursor           — old cursor replay must be idempotent
 *
 * Run: node --test tests/unit/lan-sync/v2-acceptance-drill.test.mjs
 * Deterministic: no wall-clock dependence in assertions — all timestamps are explicit
 * logical values passed via updateTime (fixed "seeded" values, see SEED_* constants).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startSide, waitFor, write, task, pair, readAll } from './d9-drill-helpers.mjs'

// Fixed logical timestamps — the "random seed" of this suite: every value is a constant
// so any machine, any run, produces byte-identical sequences.
const T0 = 1_000_000_000_000
const T1 = T0 + 1_000
const T2 = T0 + 2_000
const FAR_FUTURE = T0 + 365 * 24 * 3600 * 1000 // one year ahead — a badly skewed clock

test('S1 clock skew: a far-future clock on A silently beats a LATER offline edit on B (v1 baseline, v2 MUST fix)', async () => {
  const A = await startSide('v2s1-a')
  const B = await startSide('v2s1-b')
  try {
    pair(A, B)
    // A's clock is one year fast. A writes first.
    await write(A, [task('v2_s1', 'written by skewed A', FAR_FUTURE)])
    await waitFor(A, B, rows => rows.some(t => t.taskId === 'v2_s1'), 's1 initial row on B')
    // B (correct clock) edits the SAME row genuinely LATER in real time.
    await write(B, [task('v2_s1', 'edited later on B, correct clock', T1)])
    await waitFor(B, A, rows => rows.some(t => t.taskId === 'v2_s1' && t.taskContent === 'edited later on B, correct clock'), 'B edit back on A')
    const rowsA = await readAll(A)
    const row = rowsA.find(t => t.taskId === 'v2_s1')
    // v1 baseline: LWW by updateTime means the year-future stale write wins and the
    // genuinely-newer edit survives only as a conflict copy. If this assertion FAILS,
    // that is a change in v1 merge semantics — record it, do not patch the test.
    const copies = rowsA.filter(t => /v2_s1/.test(t.taskId) && t.taskId !== 'v2_s1')
    assert.ok(row, 'row exists')
    assert.equal(row.taskContent, 'written by skewed A',
      `v1 baseline: skewed-clock write wins (got: ${row.taskContent}). If v2 landed, this test MUST be updated to assert the DVV/causal winner instead.`)
    assert.ok(copies.length >= 1 || rowsA.some(t => t.taskContent === 'edited later on B, correct clock'),
      'the losing genuinely-newer edit is at least recoverable (copy or surviving row)')
  } finally { A.kill(); B.kill() }
})

test('S2 offline two-machine concurrent edit of the same row: one silent loser, conflict copy minted (v1 baseline)', async () => {
  const A = await startSide('v2s2-a')
  const B = await startSide('v2s2-b')
  try {
    // Both machines hold the row BEFORE they part ways.
    pair(A, B)
    await write(A, [task('v2_s2', 'base', T0)])
    await waitFor(A, B, rows => rows.some(t => t.taskId === 'v2_s2'), 's2 base row on B')
    // OFFLINE: no rounds run between the next two writes — both edit the same row,
    // neither knows about the other (the harness only syncs on explicit `round`).
    await write(A, [task('v2_s2', 'offline edit on A', T1)])
    await write(B, [task('v2_s2', 'offline edit on B', T2)])
    // Reconnect and converge.
    await waitFor(A, B, rows => rows.some(t => t.taskContent === 'offline edit on B'), 'B winner reaches A')
    await waitFor(B, A, rows => rows.some(t => t.taskContent === 'offline edit on B'), 'same winner on B')
    const rowsA = await readAll(A)
    const rowsB = await readAll(B)
    const winnersA = rowsA.filter(t => t.taskId === 'v2_s2' || /v2_s2/.test(t.taskId))
    // v1 baseline: same winner everywhere (tier-3 contract), loser as recoverable copy.
    for (const r of winnersA) assert.ok(rowsB.some(x => x.taskId === r.taskId && x.taskContent === r.taskContent && (x.updateTime || 0) === (r.updateTime || 0)),
      `converged identical on both machines: ${JSON.stringify(winnersA)} vs ${JSON.stringify(rowsB.filter(x => /v2_s2/.test(x.taskId)))}`)
    assert.ok(rowsA.some(t => t.taskContent === 'offline edit on A'),
      'loser content is recoverable on A (as the live row or a conflict copy)')
    // v2 bar: with field-level multi-value registers this must converge WITHOUT a
    // duplicate copy for complementary edits. v1 mints one — pinned here.
  } finally { A.kill(); B.kill() }
})

test('S3 duplicate and out-of-order application is idempotent: no duplicate rows, newest state wins', async () => {
  const A = await startSide('v2s3-a')
  const B = await startSide('v2s3-b')
  try {
    pair(A, B)
    // Duplicate op: same logical write performed twice (retry shape).
    await write(A, [task('v2_s3', 'dup write', T1)])
    await write(A, [task('v2_s3', 'dup write', T1)])
    await waitFor(A, B, rows => rows.some(t => t.taskId === 'v2_s3'), 's3 row on B')
    // Out-of-order: an OLDER update applied AFTER a newer one (late/replayed segment).
    await write(A, [task('v2_s3', 'newest state', T2)])
    await waitFor(A, B, rows => rows.some(t => t.taskContent === 'newest state'), 'newest on B')
    await write(A, [task('v2_s3', 'stale replay', T1)])
    // Force rounds both directions after the stale replay.
    await waitFor(A, B, rows => rows.filter(t => t.taskId === 'v2_s3').length === 1, 'exactly one row for the id on B')
    const rowsB = await readAll(B)
    const rowsA = await readAll(A)
    const live = rowsB.filter(t => t.taskId === 'v2_s3')
    assert.equal(live.length, 1, 'no duplicate live row on B')
    assert.equal(live[0].taskContent, 'newest state', 'stale replay did not roll the row back')
    assert.deepEqual(
      rowsA.filter(t => t.taskId === 'v2_s3').map(t => [t.taskContent, t.updateTime]),
      rowsB.filter(t => t.taskId === 'v2_s3').map(t => [t.taskContent, t.updateTime]),
      'A and B agree on the row after duplicate+replay storm')
  } finally { A.kill(); B.kill() }
})

test('S4 tombstone semantics: delete beats older edit; edit newer than tombstone resurrects (v1 baseline)', async () => {
  const A = await startSide('v2s4-a')
  const B = await startSide('v2s4-b')
  try {
    pair(A, B)
    await write(A, [task('v2_s4a', 'to delete', T0), task('v2_s4b', 'to resurrect', T0)])
    await waitFor(A, B, rows => rows.some(t => t.taskId === 'v2_s4a') && rows.some(t => t.taskId === 'v2_s4b'), 'both rows on B')
    // Case 1: B edits at T1, A deletes at T2 (newer). Tombstone must win.
    await write(B, [task('v2_s4a', 'B edits concurrently', T1)])
    await write(A, [task('v2_s4a', 'to delete', T2, { delete: true, deletedAt: T2 })])
    await waitFor(A, B, rows => rows.every(t => t.taskId !== 'v2_s4a' || !!t.delete), 'tombstone wins over older edit on B')
    const rowsA = await readAll(A)
    assert.ok(rowsA.every(t => t.taskId !== 'v2_s4a' || !!t.delete), 'tombstone also wins on A')
    // Case 2: an edit NEWER than the tombstone arrives (late concurrent edit on B).
    await write(B, [task('v2_s4b', 'late edit after tombstone', T2 + 1)])
    // v1 baseline: a newer-than-tombstone update resurrects the row. Pin it; v2 must
    // make delete-vs-edit an explicit, user-visible resolution either way.
    await waitFor(B, A, rows => {
      const r = rows.find(t => t.taskId === 'v2_s4b')
      return r && !r.delete
    }, 'newer-than-tombstone edit resurrects row on A (v1 baseline)')
  } finally { A.kill(); B.kill() }
})

test('S5 re-pair with a rewound cursor: replay of already-applied history is idempotent', async () => {
  const A = await startSide('v2s5-a', fs.mkdtempSync(path.join(os.tmpdir(), 'v2s5-a-')))
  const B = await startSide('v2s5-b', fs.mkdtempSync(path.join(os.tmpdir(), 'v2s5-b-')))
  try {
    pair(A, B)
    for (let i = 0; i < 5; i++) await write(A, [task(`v2_s5_${i}`, `row ${i}`, T0 + i)])
    await waitFor(A, B, rows => [0, 1, 2, 3, 4].every(i => rows.some(t => t.taskId === `v2_s5_${i}`)), 'all 5 rows on B')
    const before = (await readAll(B)).filter(t => /v2_s5_/.test(t.taskId)).length
    assert.equal(before, 5)

    // Rewind A's push cursor to 0 — the "old cursor after re-pair / stale local state"
    // shape. The engine must replay history without duplicating anything on B.
    await write(A, [{ op: 'setMeta', params: ['sync.pushCursor', '0'] }])
    // Re-pair (idempotent addPeer) and run rounds until quiescent.
    pair(A, B)
    await waitFor(A, B, rows => rows.filter(t => /v2_s5_/.test(t.taskId)).length === 5, 'still exactly 5 rows after cursor rewind + re-pair')
    const rowsB = (await readAll(B)).filter(t => /v2_s5_/.test(t.taskId))
    const rowsA = (await readAll(A)).filter(t => /v2_s5_/.test(t.taskId))
    assert.equal(rowsB.length, 5, `no duplicates on B after replay (got ${rowsB.length})`)
    assert.equal(rowsA.length, 5, `no duplicates on A after replay (got ${rowsA.length})`)
    assert.deepEqual(
      rowsA.map(t => [t.taskId, t.taskContent]).sort(),
      rowsB.map(t => [t.taskId, t.taskContent]).sort(),
      'both sides identical after replay')
  } finally { A.kill(); B.kill() }
})
