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
 *   [3] both .vue tick handlers actually contain the non-empty guard before the commit —
 *       fails without the fix (they committed unconditionally)
 *
 * Run: node --test tests/unit/renderer/round3-prune-guard.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import tomatoAnnounce from '../../../renderer/js/store/tomatoAnnounce.js'
import { buildAnnounceValue, isStaleAnnounce } from '../../../renderer/js/store/helpers/tomatoAnnounceShared.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const read = p => fs.readFileSync(path.join(ROOT, p), 'utf8')

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

test('both 500ms tick handlers guard the prune commit on a non-empty remote', () => {
  // maint/d11-r4 dedupe: both .vue tick handlers now call the shared pruneRemoteAnnounces
  // helper, which carries the non-empty guard and is the ONLY place that commits the prune.
  const helperSrc = read('renderer/js/store/tomatoAnnounce.js')
  assert.ok(
    /if \(st && st\.remote && Object\.keys\(st\.remote\)\.length\) store\.commit\('tomatoAnnounce\/prune'\)/.test(helperSrc),
    'pruneRemoteAnnounces helper must commit tomatoAnnounce/prune only when remote is non-empty (idle windows must not issue 2Hz commits)')
  // the helper must be the only commit site for the prune in renderer code
  for (const [file, call] of [
    ['renderer/js/views/TomatoFloatPage.vue', 'pruneRemoteAnnounces(this.$store)'],
    ['renderer/js/components/TomatoPanel.vue', 'pruneRemoteAnnounces(store)']
  ]) {
    const src = read(file)
    assert.ok(src.includes(`import { pruneRemoteAnnounces }`), `${file} must use the shared helper`)
    const callSites = src.split(call).length - 1
    assert.ok(callSites >= 1, `${file} must call the helper (${call})`)
    for (const line of src.split('\n')) {
      if (line.includes('tomatoAnnounce/prune')) {
        assert.fail(`${file}: prune commit must live in the guarded helper, not inline (${file})`)
      }
    }
  }
})
