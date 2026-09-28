/**
 * Round-3 perf (startup-perf-9): TomatoFloatPage.refresh() and TomatoPanel.recalc() run on 500ms
 * timers and used to commit 'tomatoAnnounce/prune' unconditionally (~2Hz per window even when no
 * peer announce exists — the mutation loops an empty object and writes no state).
 * Fix: both callers only commit when `state.tomatoAnnounce.remote` is non-empty.
 *
 * Guards:
 *   [1] the guard is a pure no-op proof: pruning an EMPTY remote map writes no state and cannot
 *       change any observable outcome — so skipping the commit when it is empty is safe
 *   [2] the real mutation still drops an EXPIRED entry (ghost-chip TTL behavior preserved) and
 *       keeps a FRESH one
 *   [3] the shared pruneRemoteAnnounces helper is direct-tested with a stub store: it commits
 *       tomatoAnnounce/prune only when remote is non-empty (r5: replaces the old src.includes
 *       text anchor, which verified the copy surface and stayed green through refactors)
 *
 * Run: node --test tests/unit/renderer/round3-prune-guard.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import tomatoAnnounce, { pruneRemoteAnnounces } from '../../../renderer/js/store/tomatoAnnounce.js'
import { buildAnnounceValue, isStaleAnnounce } from '../../../renderer/js/store/helpers/tomatoAnnounceShared.js'

test('prune on an empty remote map writes no state (skipping the commit is behavior-identical)', () => {
  const state = { remote: {} }
  const before = JSON.stringify(state)
  tomatoAnnounce.mutations.prune(state)
  assert.equal(JSON.stringify(state), before, 'empty-map prune must not touch state')
  // the guard both callers use: zero entries -> no commit issued
  assert.equal(Object.keys(state.remote).length, 0)
})

test('prune still drops an expired entry and keeps a fresh one (TTL behavior preserved)', () => {
  const expired = buildAnnounceValue({
    deviceId: 'peer-old', deviceName: 'Old', status: 'running',
    startedAt: Date.now() - 6 * 3600 * 1000, plannedSec: 1500,
    attachTodoId: 't1', attachTodoTitle: 'ghost chip'
  })
  const fresh = buildAnnounceValue({
    deviceId: 'peer-new', deviceName: 'New', status: 'running',
    startedAt: Date.now() - 60 * 1000, plannedSec: 1500,
    attachTodoId: 't2', attachTodoTitle: 'live'
  })
  assert.ok(isStaleAnnounce(expired, Date.now()), 'fixture must be past TTL')
  assert.ok(!isStaleAnnounce(fresh, Date.now()))

  const state = { remote: { 'peer-old': expired, 'peer-new': fresh } }
  tomatoAnnounce.mutations.prune(state)
  assert.ok(!('peer-old' in state.remote), 'expired announce must be pruned once the commit runs')
  assert.ok('peer-new' in state.remote, 'fresh announce must survive')
  assert.equal(Object.keys(state.remote).length, 1)
})

test('pruneRemoteAnnounces helper commits the prune only when remote is non-empty (behavior, not text anchor)', () => {
  // maint/d11-r5: the old guard asserted src.includes(...) — it verified the copy surface and
  // stayed green through refactors. The helper is exported and store-shaped, so test IT: a stub
  // store records whether tomatoAnnounce/prune was committed.
  const makeStore = remote => ({
    state: { tomatoAnnounce: { remote } },
    commits: 0,
    commit (type) { if (type === 'tomatoAnnounce/prune') this.commits += 1 }
  })
  // empty remote (the idle-window 2Hz case): must not commit
  const idle = makeStore({})
  pruneRemoteAnnounces(idle)
  assert.equal(idle.commits, 0, 'idle window (empty remote) must not issue the prune commit')
  // missing/broken state: must not throw and must not commit
  const broken = { state: {}, commits: 0, commit () { this.commits += 1 } }
  assert.doesNotThrow(() => pruneRemoteAnnounces(broken))
  assert.equal(broken.commits, 0, 'store without tomatoAnnounce state must not commit')
  assert.equal(pruneRemoteAnnounces(null), undefined, 'null store is a tolerated no-op')
  // non-empty remote: exactly one commit
  const live = makeStore({ peer: buildAnnounceValue({ deviceId: 'p', deviceName: 'P', status: 'running', startedAt: Date.now() - 1000, plannedSec: 1500 }) })
  pruneRemoteAnnounces(live)
  assert.equal(live.commits, 1, 'non-empty remote commits the prune exactly once')
})

test('remainingSecOfState is numerically equivalent to remainSecOf (anti-drift, incl. missing-field fallbacks)', async () => {
  // maint/d11-r5: remainingSecOfState's `|| 25` once swallowed a missing restTime (25:00 on a
  // 5-minute rest) while remainSecOf fell back to 5 — drift invisible to the old text-anchor
  // guards, which the d11r4 tests bypassed by always passing restTime: 5. Pin the equivalence.
  const { remainingSecOfState } = await import('../../../renderer/js/store/tomato.js?r5-equiv')
  const { remainSecOf } = await import('../../../renderer/js/utils/tomatoShared.js')
  const t0 = 1_700_000_000_000
  const states = [
    { status: 'startTomatoTime', startedAt: t0, tomatoTime: 25, restTime: 5 },
    { status: 'startTomatoTime', startedAt: t0, tomatoTime: 30 }, // missing restTime
    { status: 'startRestTime', startedAt: t0, tomatoTime: 25, restTime: 5 },
    { status: 'startRestTime', startedAt: t0, tomatoTime: 25 }, // MISSING restTime: the drift case
    { status: 'startTomatoTime', startedAt: t0 }, // missing both durations
    { status: 'startRestTime', startedAt: t0 } // missing both durations, rest phase
  ]
  for (const offsetMs of [0, 500, 61_000, 5 * 60_000, 30 * 60_000]) {
    for (const s of states) {
      const viaState = remainingSecOfState(s, t0 + offsetMs)
      const viaShared = remainSecOf(s.status, s.startedAt, s.tomatoTime, s.restTime, t0 + offsetMs)
      assert.equal(
        viaState, viaShared,
        `remainingSecOfState drifted from remainSecOf at +${offsetMs}ms for ${JSON.stringify(s)}`)
    }
  }
  // The fallback cases specifically: rest ||5, focus ||25 (not one shared ||25)
  assert.equal(remainingSecOfState({ status: 'startRestTime', startedAt: t0 }, t0), 5 * 60, 'rest with missing restTime falls back to 5, not 25')
  assert.equal(remainingSecOfState({ status: 'startTomatoTime', startedAt: t0 }, t0), 25 * 60, 'focus with missing tomatoTime falls back to 25')
})
