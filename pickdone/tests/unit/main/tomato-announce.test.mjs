/** Running-tomato cross-device announcements (feature regression tests):
 *  - announce value build/parse roundtrip + malformed-shape trust boundary;
 *  - staleness/TTL rules (ran out, peer died without idle announce);
 *  - remaining-seconds derivation;
 *  - meta key `tomatoRunAnnounce.<deviceId>` is NOT machine-local: it hydrates/ingresses
 *    through the regular meta entity (the whole point — it must sync);
 *  - the sync-apply hook fans a landed announce out to subscribers (and drops own echoes);
 *  - listAnnounces enumerates stored announces via the oplog-pointer scan;
 *  - the quit hook flips a running announce to idle (best-effort).
 * Run: node --test tests/unit/main/tomato-announce.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ta = require('../../../src/main/tomato-announce.js')
const syncApply = require('../../../src/main/sync-apply.js')

test('announce: build/parse roundtrip keeps runtime fields; idle drops attach info', () => {
  const v = ta.buildAnnounceValue({ deviceId: 'dev-a', deviceName: 'Desk', status: 'running', startedAt: 1000, plannedSec: 1500, attachTodoId: 't1', attachTodoTitle: 'Report' })
  assert.equal(v.attachTodoId, 't1')
  assert.equal(v.attachTodoTitle, 'Report')
  assert.equal(v.status, 'running')
  const parsed = ta.parseAnnounce(JSON.stringify(v))
  assert.equal(parsed.attachTodoId, 't1')
  const idle = ta.buildAnnounceValue({ deviceId: 'dev-a', deviceName: 'Desk', status: 'idle', startedAt: 0, plannedSec: 0 })
  assert.equal(idle.attachTodoId, undefined, 'idle announces carry no attach payload')
  assert.equal(ta.parseAnnounce('not-json'), null)
  assert.equal(ta.parseAnnounce({ status: 'weird', deviceId: 'x' }), null)
  assert.equal(ta.parseAnnounce(null), null)
})

test('announce: staleness rules — ran out, TTL for a crashed peer, idle always stale', () => {
  const now = 100000
  const running = { deviceId: 'a', deviceName: 'A', status: 'running', startedAt: now - 600000, plannedSec: 1500, at: now - 600000 }
  assert.equal(ta.isStaleAnnounce(running, now), false, '10 min into a 25 min focus is live')
  assert.equal(ta.remainSecOfAnnounce(running, now), 900)
  const ranOut = { ...running, startedAt: now - 1600000 }
  assert.equal(ta.isStaleAnnounce(ranOut, now), true, 'startedAt+plannedSec < now is stale')
  assert.equal(ta.remainSecOfAnnounce(ranOut, now), 0)
  const crashed = { ...running, startedAt: now - 3100000, at: now - 3100000 } // > 2x planned
  assert.equal(ta.isStaleAnnounce(crashed, now), true, 'entry older than 2x plannedSec expires (peer died mid-focus)')
  const idle = { ...running, status: 'idle' }
  assert.equal(ta.isStaleAnnounce(idle, now), true, 'idle entries never show')
})

function mockState (tables = {}) {
  const calls = []
  return {
    calls,
    state: {
      calls, deviceId: 'local-device', localUserId: null,
      pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
      db: { call (op, params) { calls.push({ op, params }); return tables[op] ? tables[op](params) : null } },
    },
  }
}

test('announce: the announce key is NOT filtered — it hydrates for egress and ingresses via setMeta', () => {
  const stored = JSON.stringify({ deviceId: 'dev-a', deviceName: 'A', status: 'running', startedAt: 1, plannedSec: 1500, at: 1 })
  const key = ta.keyFor('dev-a')
  const m = mockState({ getMeta: k => (k === key ? stored : null), syncOplogSince: () => [] })
  const live = syncApply.hydrateRow(m.state, { entity: 'meta', entityId: key, seq: 3, ts: 111 })
  assert.ok(live && !live.deleted, 'announce meta pointer must hydrate (must sync, both directions)')
  const newer = JSON.stringify({ deviceId: 'dev-a', deviceName: 'A', status: 'idle', startedAt: 0, plannedSec: 0, at: 2 })
  const row = { entity: 'meta', id: key, seq: 9, ts: 200, updatedAt: 200, deleted: false, deletedAt: 0, data: { key, value: newer } }
  assert.equal(syncApply.applyRowSafe(m.state, row), true, 'a NEWER inbound announce applies like any meta row')
  assert.equal(syncApply.applyRowSafe(m.state, { ...row, data: { key, value: stored } }), false, 'identical announce content is a no-op (no echo churn)')
  assert.equal(m.calls.filter(c => c.op === 'setMeta').length, 1)
})

test('announce: a landed inbound announce fans out to subscribers; own echo is dropped', () => {
  ta.__reset()
  ta.init({ dbCall: () => null, getIdentity: () => ({ deviceId: 'local-device', deviceName: 'L' }) })
  const seen = []
  ta.onRemoteAnnounce(v => seen.push(v))
  const key = ta.keyFor('dev-a')
  ta.emitRemoteAnnounce(key, JSON.stringify({ deviceId: 'dev-a', deviceName: 'A', status: 'running', startedAt: Date.now(), plannedSec: 1500 }))
  assert.equal(seen.length, 1)
  assert.equal(seen[0].deviceId, 'dev-a')
  ta.emitRemoteAnnounce('sync.pushCursor', '1') // non-announce keys never fan out
  ta.emitRemoteAnnounce(ta.keyFor('local-device'), JSON.stringify({ deviceId: 'local-device', deviceName: 'L', status: 'running', startedAt: Date.now(), plannedSec: 1500 }), )
  assert.equal(seen.length, 1, 'own-echo + non-announce keys are dropped')
  ta.__reset()
})

test('announce: listAnnounces enumerates stored announces via oplog pointers + getMeta', () => {
  ta.__reset()
  const store = {
    [ta.keyFor('dev-a')]: JSON.stringify({ deviceId: 'dev-a', deviceName: 'A', status: 'running', startedAt: 1, plannedSec: 1500, at: 1 }),
    [ta.keyFor('dev-b')]: JSON.stringify({ deviceId: 'dev-b', deviceName: 'B', status: 'idle', startedAt: 0, plannedSec: 0, at: 2 }),
  }
  const dbCall = (op, p) => {
    if (op === 'syncOplogSince') {
      return [
        { seq: 1, entity: 'meta', entityId: ta.keyFor('dev-a'), ts: 5 },
        { seq: 2, entity: 'meta', entityId: 'todosVersion', ts: 6 },
        { seq: 3, entity: 'meta', entityId: ta.keyFor('dev-b'), ts: 7 },
      ]
    }
    if (op === 'getMeta') return store[p]
    return null
  }
  ta.init({ dbCall, getIdentity: () => ({ deviceId: 'local-device', deviceName: 'L' }), kickRound: () => {} })
  const list = ta.listAnnounces()
  assert.equal(list.length, 2)
  assert.deepEqual(list.map(v => v.deviceId).sort(), ['dev-a', 'dev-b'])
  ta.__reset()
})

test('announce: quit hook flips a running announce to idle; no-op when already idle', () => {
  ta.__reset()
  let stored = JSON.stringify({ deviceId: 'local-device', deviceName: 'L', status: 'running', startedAt: Date.now() - 1000, plannedSec: 1500, at: Date.now() - 1000, attachTodoId: 't1', attachTodoTitle: 'x' })
  const writes = []
  const dbCall = (op, p) => {
    if (op === 'getMeta') return stored
    if (op === 'setMeta') { writes.push(p); stored = p[1]; return true }
    return null
  }
  ta.init({ dbCall, getIdentity: () => ({ deviceId: 'local-device', deviceName: 'L' }) })
  assert.equal(ta.announceIdleForQuit(), true)
  assert.equal(JSON.parse(stored).status, 'idle')
  assert.equal(ta.announceIdleForQuit(), false, 'already idle: no second write')
  ta.__reset()
})
