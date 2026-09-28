/**
 * Round fixes 2026-09-28:
 *  1. Abandoned CLI command slots must not replay on restart. The CLI's waitForTomatoAck (8s) /
 *     waitForSyncAck (15s) time out with APP_NOT_RUNNING and leave the meta slot in place; the
 *     counter-1 seed (round-2 P1 2026-09-21) then turned that into a silent execute DAYS later
 *     (tomato start / unpair key rotation). Fix: a queued command at the counter only executes
 *     when FRESH (age <= 60s TTL); an older one is abandoned — counter watermark stands, slot is
 *     compare-and-deleted. Covers both the tomato seed (external-db-watch.seedTomatoWatermark)
 *     and the sync channel (cli-sync-channel.createSyncCmdHandler).
 *  2. awaitFlushAcks must contain a throwing flushMain inside the timer callback (quit teardown
 *     used to be interruptible by an uncaughtException → crashRelaunch).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { seedTomatoWatermark, CLI_SLOT_ABANDON_TTL_MS } = require('../../../src/main/external-db-watch.js')
const { createSyncCmdHandler } = require('../../../src/main/cli-sync-channel.js')
const { createQuitAckTracker, awaitFlushAcks, POLL_MS } = require('../../../src/main/quit-ack.js')

const NOW = Date.now()

function fakeMeta (initial = {}) {
  const store = new Map(Object.entries(initial))
  const deleted = []
  return {
    store,
    deleted,
    getMeta: k => (store.has(k) ? store.get(k) : null),
    setMeta: (k, v) => store.set(k, v),
    deleteMeta: k => { deleted.push(k); store.delete(k) },
  }
}

test('tomato seed: fresh queued command at the counter still executes once (counter-1 seed kept)', () => {
  const m = fakeMeta({
    cliTomatoSeq: '5',
    cliTomatoCmd: JSON.stringify({ seq: 5, at: NOW - 1000, action: 'start' }),
  })
  const seed = seedTomatoWatermark(m)
  assert.equal(seed, 4, 'fresh queued command seeds counter-1 so the forward path executes it once')
  assert.deepEqual(m.deleted, [], 'fresh command slot is NOT deleted')
})

test('tomato seed: stale queued command is abandoned — counter watermark stands and the slot is deleted', () => {
  const m = fakeMeta({
    cliTomatoSeq: '5',
    cliTomatoCmd: JSON.stringify({ seq: 5, at: NOW - CLI_SLOT_ABANDON_TTL_MS - 1000, action: 'start' }),
  })
  const seed = seedTomatoWatermark(m)
  assert.equal(seed, 5, 'abandoned command must NOT seed counter-1 (would replay it)')
  assert.deepEqual(m.deleted, ['cliTomatoCmd'], 'abandoned slot is released')
})

test('tomato seed: abandonment is compare-and-delete — a newer command in the slot survives', () => {
  const m = fakeMeta({
    cliTomatoSeq: '5',
    cliTomatoCmd: JSON.stringify({ seq: 6, at: NOW, action: 'stop' }),
  })
  const seed = seedTomatoWatermark(m)
  assert.equal(seed, 5, 'seq 6 > counter is left to the normal forward path')
  assert.deepEqual(m.deleted, [], 'newer command never eaten by the seed cleanup')
})

test('tomato seed: no queued slot / malformed slot → plain counter watermark', () => {
  assert.equal(seedTomatoWatermark(fakeMeta({ cliTomatoSeq: '9' })), 9)
  assert.equal(seedTomatoWatermark(fakeMeta({
    cliTomatoSeq: '9',
    cliTomatoCmd: '{not json',
  })), 9)
  assert.equal(seedTomatoWatermark(fakeMeta()), 0)
})

test('tomato seed: slot WITHOUT an at stamp keeps execute-once (only CLI-stamped stale slots are abandoned)', () => {
  const m = fakeMeta({
    cliTomatoSeq: '5',
    cliTomatoCmd: JSON.stringify({ seq: 5, action: 'start' }), // no `at`
  })
  assert.equal(seedTomatoWatermark(m), 4, 'unstampable slot is not guessed stale — crash-recovery preserved')
  assert.deepEqual(m.deleted, [])
})

test('sync channel: stale queued command at the counter is not handled and its slot is cleared', async () => {
  const m = fakeMeta({
    cliSyncSeq: '3',
    cliSyncCmd: JSON.stringify({ seq: 3, at: NOW - CLI_SLOT_ABANDON_TTL_MS - 1000, action: 'unpair' }),
  })
  const dispatchLog = []
  const ch = createSyncCmdHandler({
    dispatch: (op) => { dispatchLog.push(op); return {} },
    setMeta: () => {},
    getMeta: m.getMeta,
    deleteMeta: m.deleteMeta,
    log: { warn: () => {} },
  })
  ch.forward(m.getMeta('cliSyncCmd'))
  await new Promise(r => setTimeout(r, 20))
  assert.deepEqual(dispatchLog, [], 'abandoned unpair must NOT execute (secret rotation with nobody home)')
  assert.deepEqual(m.deleted, ['cliSyncCmd'], 'abandoned slot released so it cannot seed counter-1 again')
  // a genuinely new command still flows
  m.setMeta('cliSyncCmd', JSON.stringify({ seq: 4, at: Date.now(), action: 'status' }))
  ch.forward(m.getMeta('cliSyncCmd'))
  await new Promise(r => setTimeout(r, 20))
  assert.deepEqual(dispatchLog, ['syncGetStatus'], 'fresh commands unaffected by the TTL')
})

test('sync channel: fresh queued command at the counter still executes once after restart', async () => {
  const m = fakeMeta({
    cliSyncSeq: '3',
    cliSyncCmd: JSON.stringify({ seq: 3, at: NOW - 1000, action: 'status' }),
  })
  const dispatchLog = []
  const ch = createSyncCmdHandler({
    dispatch: (op) => { dispatchLog.push(op); return {} },
    setMeta: () => {},
    getMeta: m.getMeta,
    deleteMeta: m.deleteMeta,
    log: { warn: () => {} },
  })
  ch.forward(m.getMeta('cliSyncCmd'))
  await new Promise(r => setTimeout(r, 20))
  assert.deepEqual(dispatchLog, ['syncGetStatus'], 'crash-between-write-and-handle still gets execute-once')
  assert.deepEqual(m.deleted, ['cliSyncCmd'], 'handled slot cleared by clearHandledSlot')
})

test('awaitFlushAcks: a throwing flushMain is contained — no uncaughtException, onDone still runs', async () => {
  const tracker = createQuitAckTracker()
  tracker.beginRound(0, tracker.nextToken()) // zero live windows → immediate fast path
  let done = false
  awaitFlushAcks({
    tracker,
    capMs: 100,
    pollMs: 5,
    flushMain: () => { throw new Error('flush exploded mid-teardown') },
    onDone: () => { done = true },
  })
  await new Promise(r => setTimeout(r, POLL_MS + 30))
  assert.equal(done, true, 'teardown continues after flushMain throws')
})

test('awaitFlushAcks: happy path unchanged — flushMain called exactly once on allAcked', async () => {
  const tracker = createQuitAckTracker()
  const token = tracker.nextToken()
  tracker.beginRound(1, token)
  let calls = 0
  awaitFlushAcks({ tracker, capMs: 500, pollMs: 5, flushMain: () => { calls++ } })
  await new Promise(r => setTimeout(r, 10))
  tracker.ack(token, 1)
  await new Promise(r => setTimeout(r, 30))
  assert.equal(calls, 1)
})
