/**
 * Tomato phase-sync stale-peer guard (2026-09-27) — regression tests.
 *
 * Root cause fixed here: a throttled float window can persist its stale mid-focus blob AFTER the
 * main window already flipped focus->rest. syncFromStorage's Object.assign used to roll the main
 * window's phase back to the stale 'startTomatoTime'; the phase claim recorded during the first
 * completion then made every retry tick no-op, wedging the tomato phase until the 24h rollover.
 * Fix: patch stamps phaseTs on every status change; syncFromStorage refuses to apply a peer phase
 * older than the local one (preferences still sync).
 *
 * Run: node --test tests/unit/renderer/tomato-phase-guard.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

const tomato = (await import('../../../renderer/js/store/tomato.js')).default

const LS_KEY = 'tomatoState'

test('patch stamps phaseTs when the status changes', () => {
  const s = { ...JSON.parse(JSON.stringify({ status: 'startTomatoTime', startedAt: 1000, tomatoTime: 25, restTime: 5, remainSec: 1500, todayTomatoCount: 0, tomatoRecordList: [], phaseTs: 0 })) }
  tomato.mutations.patch(s, { status: 'startRestTime', startedAt: 2000, remainSec: 300 })
  assert.ok(s.phaseTs > 0, 'status transition must stamp phaseTs')
})

test('patch does not stamp phaseTs when status is unchanged', () => {
  const s = { status: 'startTomatoTime', startedAt: 1000, tomatoTime: 25, restTime: 5, remainSec: 1500, todayTomatoCount: 0, tomatoRecordList: [], phaseTs: 555 }
  tomato.mutations.patch(s, { todayTomatoCount: 3 })
  assert.equal(s.phaseTs, 555)
})

test('syncFromStorage refuses a stale peer phase (no resurrection of a transitioned-past focus)', () => {
  const now = Date.now()
  const s = {
    status: 'startRestTime', startedAt: now - 1000, remainSec: 300, phaseTs: now - 500,
    tomatoTime: 25, restTime: 5, todayTomatoCount: 1, tomatoRecordList: [{ tomatoId: 'tmt_f_1' }],
    enableNotification: true,
  }
  // Throttled peer writes its stale mid-focus blob (phaseTs older than the local flip).
  globalThis.localStorage.setItem(LS_KEY, JSON.stringify({
    status: 'startTomatoTime', startedAt: now - 26 * 60000, tomatoTime: 30, restTime: 5, remainSec: 0, phaseTs: now - 30 * 60000,
  }))
  globalThis.localStorage.setItem('tomatoSyncPing', 'ping-1')
  tomato.mutations.syncFromStorage(s)
  assert.equal(s.status, 'startRestTime', 'stale peer blob must not roll the local phase back')
  assert.equal(s.startedAt, now - 1000, 'local phase timestamps stay')
  assert.equal(s.tomatoTime, 30, 'non-phase preference fields still sync')
})

test('syncFromStorage still applies a peer phase that is not older (fresh peer start)', () => {
  const now = Date.now()
  const s = {
    status: 'default', startedAt: 0, remainSec: 1500, phaseTs: now - 60 * 60000,
    tomatoTime: 25, restTime: 5, todayTomatoCount: 0, tomatoRecordList: [],
  }
  // Peer legitimately started a focus moments ago (newer phaseTs): must sync.
  globalThis.localStorage.setItem(LS_KEY, JSON.stringify({
    status: 'startTomatoTime', startedAt: now - 5000, tomatoTime: 25, restTime: 5, remainSec: 1500, phaseTs: now - 4000,
  }))
  globalThis.localStorage.setItem('tomatoSyncPing', 'ping-2')
  tomato.mutations.syncFromStorage(s)
  assert.equal(s.status, 'startTomatoTime', 'a newer peer phase must sync across windows')
  assert.equal(s.startedAt, now - 5000)
})
