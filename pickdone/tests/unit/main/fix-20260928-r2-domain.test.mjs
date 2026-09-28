/**
 * r2 domain fixes (2026-09-28), four regressions:
 *  1. fix-util.tryForwardTomatoCmd — the RUNTIME forward path now abandons a stale STAMPED slot
 *     command (age > CLI_SLOT_ABANDON_TTL_MS) instead of executing it the moment the window/
 *     lock recovers. Previously only the startup seed (external-db-watch) checked the TTL; a
 *     command the CLI had already given up on (APP_NOT_RUNNING, e.g. an unpair key rotation)
 *     still fired on recovery because the runtime path checked seq only.
 *  2. The abandon/seed policy lives in ONE place now (cli-slot-policy.js): both
 *     external-db-watch.seedTomatoWatermark and cli-sync-channel.createSyncCmdHandler consume the
 *     shared seedSlotWatermark and the SAME TTL constant — a policy change can no longer drift.
 *  3. db-oplog.oplogEntriesFor('tomatoMigrateFromMeta') is result-aware: result 0 (steady state —
 *     the CLI's open() runs it on EVERY command incl. pure reads) emits NO phantom ('tomato',
 *     '*gc*') pointer; only a real migration (result > 0) does.
 *  4. sync-apply-hydrate.hydrateRow RETHROWS on DB read failure (only legitimate skips return
 *     null); the batch layer (lan-sync-bootstrap getRowsSince) catches per-pointer and counts the
 *     loss into state.egressHydrationFailures + an 'egress-hydration-failed' sync event instead
 *     of silently dropping the pointer while the cursor advances.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { tryForwardTomatoCmd } = require('../../../src/main/fix-util.js')
const { CLI_SLOT_ABANDON_TTL_MS, seedSlotWatermark } = require('../../../src/main/cli-slot-policy.js')
const { seedTomatoWatermark: seedTomatoViaWatch } = require('../../../src/main/external-db-watch.js')
const { createSyncCmdHandler } = require('../../../src/main/cli-sync-channel.js')
const oplogFactory = require('../../../src/main/db-oplog.js')
const { __test: boot } = require('../../../src/main/lan-sync-bootstrap.js')
const { hydrateRow, createHydrationCache } = require('../../../src/main/sync-apply-hydrate.js')

const NOW = Date.now()

/* ---------- 1. runtime TTL abandon in tryForwardTomatoCmd ---------- */

function mockWin () {
  const sent = []
  return { sent, win: { webContents: { send: (ch, cmd) => sent.push({ ch, cmd }) } } }
}

test('runtime forward: stale stamped command is abandoned — not sent, seq consumed, slot cleared', () => {
  const { sent, win } = mockWin()
  const cleared = []
  const st = tryForwardTomatoCmd({
    raw: JSON.stringify({ seq: 7, at: NOW - CLI_SLOT_ABANDON_TTL_MS - 1000, action: 'unpair-like' }),
    lastTomatoCmdRaw: null, lastTomatoSeq: 6,
    getMainWindow: () => win, isLocked: () => false,
    clearCmd: cmd => cleared.push(cmd.seq),
    now: NOW,
  })
  assert.equal(st.sent, false, 'stale command must NOT be forwarded')
  assert.equal(st.abandoned, true, 'reported as abandoned')
  assert.equal(sent.length, 0, 'renderer never sees the stale command')
  assert.equal(st.lastTomatoSeq, 7, 'seq IS consumed — no retry loop every poll')
  assert.equal(st.lastTomatoCmdRaw, JSON.stringify({ seq: 7, at: NOW - CLI_SLOT_ABANDON_TTL_MS - 1000, action: 'unpair-like' }), 'raw consumed')
  assert.deepEqual(cleared, [7], 'caller compare-and-delete still runs so the slot cannot replay')
})

test('runtime forward: fresh command still executes; no-at stamp keeps execute-once', () => {
  const { sent, win } = mockWin()
  const fresh = tryForwardTomatoCmd({
    raw: JSON.stringify({ seq: 7, at: NOW - 1000, action: 'start' }),
    lastTomatoCmdRaw: null, lastTomatoSeq: 6,
    getMainWindow: () => win, isLocked: () => false,
    now: NOW,
  })
  assert.equal(fresh.sent, true)
  assert.equal(fresh.abandoned, false)
  assert.equal(sent[0].cmd.action, 'start')

  const { sent: sent2, win: win2 } = mockWin()
  const legacy = tryForwardTomatoCmd({
    raw: JSON.stringify({ seq: 8, action: 'stop' }), // no `at` (foreign/legacy writer)
    lastTomatoCmdRaw: null, lastTomatoSeq: 7,
    getMainWindow: () => win2, isLocked: () => false,
    now: NOW,
  })
  assert.equal(legacy.sent, true, 'unstampable slot is not guessed stale — same policy as the seed')
  assert.equal(sent2[0].cmd.action, 'stop')
})

/* ---------- 2. shared slot policy (no duplicated TTL logic) ---------- */

test('shared policy: single TTL constant backs seed + runtime paths', () => {
  assert.equal(typeof CLI_SLOT_ABANDON_TTL_MS, 'number')
  assert.equal(CLI_SLOT_ABANDON_TTL_MS, 60 * 1000)
})

function fakeMeta (initial = {}) {
  const store = new Map(Object.entries(initial))
  const deleted = []
  return {
    store, deleted,
    getMeta: k => (store.has(k) ? store.get(k) : null),
    deleteMeta: k => { deleted.push(k); store.delete(k) },
  }
}

test('shared policy: tomato seed and sync channel behave IDENTICALLY for the same slot state', () => {
  const stale = { cliTomatoSeq: '5', cliTomatoCmd: JSON.stringify({ seq: 5, at: NOW - CLI_SLOT_ABANDON_TTL_MS - 1, action: 'start' }) }
  const m1 = fakeMeta(stale)
  assert.equal(seedTomatoViaWatch(m1), 5, 'tomato seed: stale → counter stands')
  assert.deepEqual(m1.deleted, ['cliTomatoCmd'], 'tomato seed: stale slot compare-and-deleted')

  const fresh = { cliSyncSeq: '3', cliSyncCmd: JSON.stringify({ seq: 3, at: NOW - 1000, action: 'status' }) }
  const m2 = fakeMeta(fresh)
  const dispatchLog = []
  const ch = createSyncCmdHandler({
    dispatch: op => { dispatchLog.push(op); return {} }, setMeta: () => {},
    getMeta: m2.getMeta, deleteMeta: m2.deleteMeta, log: { warn: () => {} },
  })
  ch.forward(m2.getMeta('cliSyncCmd'))
  return new Promise(r => setTimeout(r, 20)).then(() => {
    assert.deepEqual(dispatchLog, ['syncGetStatus'], 'sync channel: fresh → execute-once preserved')
    assert.deepEqual(m2.deleted, ['cliSyncCmd'], 'sync channel: handled slot cleared')
  })
})

test('shared policy: seedSlotWatermark pure unit — abandon callback, fresh counter-1, malformed slot', () => {
  const abandoned = []
  // stale → counter stands + onAbandon called with the queued cmd
  assert.equal(seedSlotWatermark({
    counter: 5, slotRaw: JSON.stringify({ seq: 5, at: 1 }), now: 2 * CLI_SLOT_ABANDON_TTL_MS, onAbandon: q => abandoned.push(q.seq),
  }), 5)
  assert.deepEqual(abandoned, [5])
  // fresh → counter-1 (execute-once), no abandon
  assert.equal(seedSlotWatermark({ counter: 5, slotRaw: JSON.stringify({ seq: 5, at: 2 * CLI_SLOT_ABANDON_TTL_MS }), now: 2 * CLI_SLOT_ABANDON_TTL_MS }), 4)
  assert.deepEqual(abandoned, [5])
  // no slot / malformed / seq<counter → counter
  assert.equal(seedSlotWatermark({ counter: 9, slotRaw: null, now: 0 }), 9)
  assert.equal(seedSlotWatermark({ counter: 9, slotRaw: '{oops', now: 0 }), 9)
  assert.equal(seedSlotWatermark({ counter: 9, slotRaw: JSON.stringify({ seq: 3, at: 1 }), now: 9999 }), 9)
})

/* ---------- 3. tomatoMigrateFromMeta result-aware capture ---------- */

const oplog = oplogFactory({ getDb: () => { throw new Error('getDb must not be needed for migrate capture') }, log: { warn: () => {} } })

test('tomatoMigrateFromMeta: result 0 (steady state) emits NO phantom gc pointer', () => {
  assert.deepEqual(oplog.oplogEntriesFor('tomatoMigrateFromMeta', undefined, 0), [],
    'every CLI command runs the migrate check via open(); result 0 must not write a sync pointer')
})

test('tomatoMigrateFromMeta: a real migration (result > 0) still emits the gc marker', () => {
  const rows = oplog.oplogEntriesFor('tomatoMigrateFromMeta', undefined, 3)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].entity, 'tomato')
  assert.equal(rows[0].entityId, '*gc*')
})

/* ---------- 4. hydrateRow failure is distinguishable from a legitimate skip ---------- */

const EMPTY_TABLES = {
  getAll: () => [], settingsRowsAll: () => [], tomatoAll: () => [],
  categoriesAllRows: () => [], planTombstones: () => [], filterTombstones: () => [],
  planAll: () => [], filterList: () => [],
}

test('hydrateRow: DB read failure RETHROWS with pointer context (no longer collapsed to null)', () => {
  const state = { db: { call (op) { if (op === 'getAll') throw new Error('db locked'); return [] } } }
  assert.throws(
    () => hydrateRow(state, { entity: 'todo', entityId: 't1', seq: 4, ts: 9 }, createHydrationCache(state)),
    e => e.message === 'db locked' && e.egressHydration && e.egressHydration.entity === 'todo' &&
         e.egressHydration.id === 't1' && e.egressHydration.seq === 4,
  )
})

test('hydrateRow: legitimate skips still return null (gc marker, unknown entity); unknown todo → tombstone (not an error)', () => {
  const state = { db: { call: () => [] } }
  const cache = createHydrationCache(state)
  assert.equal(hydrateRow(state, { entity: 'tomato', entityId: '*gc*', seq: 1, ts: 2 }, cache), null)
  assert.equal(hydrateRow(state, { entity: 'nonentity', entityId: 'x', seq: 1, ts: 2 }, cache), null)
  const tomb = hydrateRow(state, { entity: 'todo', entityId: 'unknown', seq: 1, ts: 2 }, cache)
  assert.equal(tomb.deleted, true, 'unknown-id todo hydrates as a legit tombstone — distinct from a thrown read failure')
})

test('getRowsSince: a failing pointer is counted into the egress report, good rows still push', () => {
  let failOnes = 0 // fail only the FIRST getAll read, so exactly one pointer hits the bad read
  const state = {
    db: {
      call (op, p) {
        if (op === 'syncOplogSince') {
          return [
            { entity: 'todo', entityId: 'ok', seq: 1, ts: 5 },
            { entity: 'todo', entityId: 'bad', seq: 2, ts: 6 },
          ]
        }
        if (op === 'getAll') {
          if (failOnes++ === 0) throw new Error('hydr read boom')
          return [{ taskId: 'ok', updateTime: 5, delete: 0, deletedAt: 0 }, { taskId: 'bad', updateTime: 6, delete: 0, deletedAt: 0 }]
        }
        return EMPTY_TABLES[op] ? EMPTY_TABLES[op](p) : []
      },
    },
  }
  boot.setState(state)
  const rows = boot.getRowsSince(0)
  // whichever pointer hit the throwing read, the failure must be VISIBLE and the good row present
  assert.equal(state.egressHydrationFailures.length, 1, 'exactly one pointer counted as failed')
  const f = state.egressHydrationFailures[0]
  assert.equal(f.entity, 'todo')
  assert.match(f.error, /hydr read boom/)
  assert.equal(rows.length, 1, 'the healthy pointer still hydrates and pushes')
  assert.equal(rows[0].id, f.id === 'ok' ? 'bad' : 'ok', 'the pushed row is the OTHER pointer — loss is no longer silent')
  // recovery: with the read healthy, a subsequent pass reports zero failures
  const rows2 = boot.getRowsSince(0)
  assert.equal(rows2.length, 2)
  assert.deepEqual(state.egressHydrationFailures, [], 'report resets on a clean pass')
})
