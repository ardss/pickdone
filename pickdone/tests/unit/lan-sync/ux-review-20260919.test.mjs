/* UX-review round regression tests (2026-09-19, branch fix/sync-ux-review):
 *   P0-1: a round that applied inbound rows broadcasts the SAME events the local-write path
 *         sends ('todos-changed' / 'tomato-records-changed') so open views refresh live;
 *   P1-2: applied SETTING rows are folded into the db.settingsState blob (so the renderer's
 *         whole-blob mirror can no longer re-stamp stale fields) and hot-apply to the running
 *         renderer via 'external-settings-changed' — the two-writers ping-pong ends;
 *   P1-3: syncUnpairPeer deletes the peer record + push watermark and REVOKES the shared
 *         pairing secret (the removed peer can no longer authenticate = syncing paused);
 *   P1-5: an LWW conflict surfaces AT MOST ONE 'sync-conflict' syncEvent per round;
 *   P1-6: the announce store's prune mutation drops expired entries (ghost-chip fix);
 *   P1-7: quit ordering — the idle announce is written BEFORE the sync node stops;
 *   P1-8: attachment pull fires onArrived per landed file; missing-open kicks a sync round.
 * Run: node --test tests/unit/lan-sync/ux-review-20260919.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const { __test } = require('../../../src/main/lan-sync-bootstrap.js')
const { createAttachmentPuller } = require('../../../src/main/lan-sync/att-transfer.js')

const ROOT = fileURLToPath(new URL('../../../', import.meta.url))

const EMPTY_TABLES = {
  getAll: () => [],
  settingsRowsAll: () => [],
  tomatoAll: () => [],
  categoriesAllRows: () => [], planTombstones: () => [], filterTombstones: () => [],
  planAll: () => [],
  filterList: () => [],
}

/** Mock state with a sender-capture surface: every webContents.send is recorded in `sent`. */
function mockState (tables = {}, writeImpl = {}) {
  const calls = []
  const sent = []
  // One sender: broadcast counts below assume a single window.
  const senders = [{ isDestroyed: () => false, send: (ch, msg) => sent.push({ ch, msg }) }]
  const state = {
    calls,
    sent,
    deviceId: 'local-device',
    localUserId: null,
    applied: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    applyCache: null,
    engine: null,
    node: null,
    timers: [],
    peerWatermarks: new Map(),
    pendingToSeq: 0,
    db: { call (op, params) { calls.push({ op, params }); return tables[op] ? tables[op](params) : (writeImpl[op] ? writeImpl[op](params) : null) } },
    getWindowSenders: () => senders,
  }
  return { state, calls, sent }
}

function fresh (tables, writeImpl) {
  const m = mockState(tables, writeImpl)
  __test.setState(m.state)
  return m
}

test('P0-1: applying a todo row fires the todos-changed broadcast after the round', () => {
  const m = fresh({ ...EMPTY_TABLES })
  const ok = __test.applyRow({ entity: 'todo', id: 't1', seq: 7, ts: 100, updatedAt: 100, deleted: false, deletedAt: 0, data: { taskId: 't1', taskContent: 'hello', updateTime: 100 } })
  assert.equal(ok, true)
  assert.equal(m.sent.length, 0, 'nothing broadcast before the round consumption point')
  __test.emitAppliedRound()
  const bc = m.sent.filter(s => s.ch === 'todos-changed')
  assert.equal(bc.length, 1, 'open views must be told to reload after inbound rows applied')
  assert.equal(bc[0].msg.reason, 'lan-sync-apply')
  // Consume again: no new broadcast without freshly applied rows (no echo loop)
  __test.emitAppliedRound()
  assert.equal(m.sent.filter(s => s.ch === 'todos-changed').length, 1)
})

test('P0-1: a ledger (tomato) row rides tomato-records-changed, like the local-write path', () => {
  const m = fresh({ ...EMPTY_TABLES })
  __test.applyRow({ entity: 'tomato', id: 'tm1', seq: 4, ts: 10, updatedAt: 10, deleted: false, deletedAt: 0, data: { tomatoId: 'tm1', updatedAt: 10 } })
  __test.emitAppliedRound()
  assert.ok(m.sent.some(s => s.ch === 'tomato-records-changed' && s.msg.reason === 'lan-sync-apply'))
})

test('P1-2: applied settings rows fold into the blob AND hot-apply to the renderer', () => {
  // Blob on disk still holds the STALE value for 'weekStartDay'; the peer's newer row says 'sun'.
  const staleBlob = JSON.stringify({ weekStartDay: 'mon', colorMode: 'light', _savedAt: 1 })
  const m = fresh({
    ...EMPTY_TABLES,
    getMeta: k => (k === 'db.settingsState' ? staleBlob : null),
  })
  __test.applyRow({ entity: 'setting', id: 'weekStartDay', seq: 9, ts: 200, updatedAt: 200, deleted: false, deletedAt: 0, data: { key: 'weekStartDay', value: '"sun"' } })
  __test.emitAppliedRound()
  // (a) the renderer gets the hot-apply patch on the CLI settings channel
  const patch = m.sent.filter(s => s.ch === 'external-settings-changed')
  assert.equal(patch.length, 1)
  assert.deepEqual(patch[0].msg, { weekStartDay: 'sun' })
  // (b) the blob was folded: the next whole-blob mirror can no longer re-stamp the stale field
  const setMeta = m.calls.filter(c => c.op === 'setMeta' && c.params[0] === 'db.settingsState')
  assert.equal(setMeta.length, 1)
  const doc = JSON.parse(setMeta[0].params[1])
  assert.equal(doc.weekStartDay, 'sun', 'blob must adopt the peer-applied value (ends the re-stamp churn)')
  assert.equal(doc.colorMode, 'light', 'untouched blob fields stay put')
})

test('P1-2 regression (two writers, one field changed each): fold keeps blob==rows so the bridge stamps nothing', () => {
  // Simulates the churn: A changed weekStartDay locally, B changed colorMode. B's colorMode row
  // arrives here. After the fold, the LOCAL blob no longer differs from settings_rows on
  // colorMode, so a later whole-blob mirror of the blob produces no re-stamped (newer-ts) rows.
  const blob = JSON.stringify({ weekStartDay: 'sun', colorMode: 'light' })
  const m = fresh({
    ...EMPTY_TABLES,
    getMeta: k => (k === 'db.settingsState' ? blob : null),
    // settings_rows: local weekStartDay='sun' (local edit), colorMode='dark' (older local value)
    settingsRowsAll: () => ([
      { key: 'weekStartDay', value: 'sun', updatedAt: 100, deleted: false, deletedAt: 0 },
      { key: 'colorMode', value: 'dark', updatedAt: 90, deleted: false, deletedAt: 0 },
    ]),
  })
  // Inbound: B's newer colorMode='light' row wins LWW (200 > 90)
  __test.applyRow({ entity: 'setting', id: 'colorMode', seq: 11, ts: 200, updatedAt: 200, deleted: false, deletedAt: 0, data: { key: 'colorMode', value: '"light"' } })
  __test.emitAppliedRound()
  const setMeta = m.calls.find(c => c.op === 'setMeta' && c.params[0] === 'db.settingsState')
  const folded = JSON.parse(setMeta.params[1])
  assert.equal(folded.colorMode, 'light')
  assert.equal(folded.weekStartDay, 'sun', 'the local user\'s own changed field is untouched by the fold')
})

test('P1-3: unpair deletes the peer record + watermark and revokes the shared secret', async () => {
  const peers = [{ deviceId: 'peer-xyz', deviceName: 'DESKTOP', host: '192.168.1.64', port: 58471 }]
  let stopped = false
  const m = fresh({
    ...EMPTY_TABLES,
    settingsRowsAll: () => ([
      { key: 'sync.enabled', value: true, updatedAt: 1, deleted: false, deletedAt: 0 },
      { key: 'sync.deviceId', value: 'local-device', updatedAt: 1, deleted: false, deletedAt: 0 },
      { key: 'sync.deviceName', value: 'LAPTOP', updatedAt: 1, deleted: false, deletedAt: 0 },
      { key: 'sync.pairingSecret', value: 'OLDSECRET', updatedAt: 1, deleted: false, deletedAt: 0 },
      { key: 'sync.manualPeers', value: JSON.stringify([{ host: '192.168.1.64', port: 58471 }]), updatedAt: 1, deleted: false, deletedAt: 0 },
      { key: 'sync.peerWatermarks.v2', value: JSON.stringify({ 'peer-xyz': 4321, 'other': 10 }), updatedAt: 1, deleted: false, deletedAt: 0 },
    ]),
  })
  m.state.peerWatermarks = new Map([['peer-xyz', 4321], ['other', 10]])
  m.state.node = {
    getStatus: () => ({ peers, listening: true, port: 58471, recent: [], security: [], self: {} }),
    removePeer: () => {},
    stop: async () => { stopped = true },
  }
  const r = await __test.unpairPeer({ deviceId: 'peer-xyz' })
  assert.equal(r.unpaired, 'peer-xyz')
  assert.ok(stopped, 'node restarted so the revoked secret takes effect immediately')
  // manual peer record deleted
  const putCalls = m.calls.filter(c => c.op === 'settingsRowPut')
  const manual = putCalls.find(c => c.params.key === 'sync.manualPeers')
  assert.ok(manual, 'manual peer list rewritten')
  assert.equal(JSON.parse(manual.params.value).length, 0, 'peer record deleted')
  // watermark deleted
  const wm = putCalls.find(c => c.params.key === 'sync.peerWatermarks.v2')
  assert.ok(wm)
  const wmMap = JSON.parse(wm.params.value)
  assert.equal(wmMap['peer-xyz'], undefined, 'watermark deleted')
  assert.equal(wmMap.other, 10, 'unrelated peer watermarks untouched')
  // secret revoked
  const secret = putCalls.find(c => c.params.key === 'sync.pairingSecret')
  assert.ok(secret && secret.params.value !== 'OLDSECRET', 'shared pairing secret revoked (both sides must re-pair)')
})

test('P1-5: an LWW conflict emits exactly one sync-conflict syncEvent per round', () => {
  // Local live todo vs a newer remote deletion: the loser is materialized to the recycle bin AND
  // summarized; a second conflict (setting loser, peer version applied) accumulates in the same
  // round; the round consumer emits ONE event even so.
  const m = fresh({
    ...EMPTY_TABLES,
    getAll: () => [{ taskId: 't1', updateTime: 50, delete: false, deletedAt: 0, taskContent: 'local edit' }],
    settingsRowsAll: () => [{ key: 'theme', value: 'light', updatedAt: 50, deleted: false, deletedAt: 0 }],
  })
  __test.applyRow({ entity: 'todo', id: 't1', seq: 7, ts: 100, deleted: true, deletedAt: 99, data: null })
  __test.applyRow({ entity: 'setting', id: 'theme', seq: 8, ts: 100, updatedAt: 100, deleted: false, deletedAt: 0, data: { key: 'theme', value: '"dark"' } })
  __test.emitAppliedRound()
  const evts = m.sent.filter(s => s.ch === 'syncEvent' && s.msg.type === 'sync-conflict')
  assert.equal(evts.length, 1, 'one toast per round, max')
  assert.equal(evts[0].msg.count, 2, 'summary carries the per-round conflict count')
  assert.ok(evts[0].msg.name, 'summary names the conflicted record')
})

test('P1-6: prune drops expired announce entries (ghost chip fix)', async () => {
  const { default: store } = await import('../../../renderer/js/store/tomatoAnnounce.js')
  const now = Date.now()
  const live = { deviceId: 'a', deviceName: 'A', status: 'running', startedAt: now - 1000, plannedSec: 1500, at: now - 1000 }
  const dead = { deviceId: 'b', deviceName: 'B', status: 'running', startedAt: now - 10 * 60 * 1000, plannedSec: 60, at: now - 10 * 60 * 1000 }
  store.state.remote = { a: live, b: dead }
  store.mutations.prune(store.state)
  assert.equal(store.state.remote.b, undefined, 'expired entry removed')
  assert.equal(store.state.remote.a.deviceId, 'a', 'live entry kept')
})

test('P1-7: quit ordering — idle announce is written BEFORE the sync node stops', () => {
  // The idle write's kick is a no-op once the node is stopped; the announce must be written
  // (and its round kicked) BEFORE stopSyncForQuit in the before-quit chain.
  const src = readFileSync(ROOT + 'src/main/index.js', 'utf8')
  const idle = src.indexOf('announceIdleForQuit()')
  const stop = src.indexOf('stopSyncForQuit()')
  assert.ok(idle > -1 && stop > -1)
  assert.ok(idle < stop, 'announceIdleForQuit must run before stopSyncForQuit')
})

test('P1-8: attachment pull fires onArrived per landed file (renderer arrival refresh)', () => {
  const arrived = []
  const files = new Map()
  const puller = createAttachmentPuller({
    send: () => {},
    getKeys: () => ['k1'],
    onArrived: key => arrived.push(key),
    deps: {
      exists: k => files.has(k),
      size: k => files.get(k).length,
      read: (k, s, e) => files.get(k).slice(s, e + 1),
      writeAtomic: (k, buf) => { files.set(k, buf) },
      hashFn: buf => require('node:crypto').createHash('sha256').update(buf).digest('hex'),
    },
  })
  // Fake the sender's answer for key k1
  const content = Buffer.from('hello attachment')
  const hash = require('node:crypto').createHash('sha256').update(content).digest('hex')
  puller.maybeStart(() => {}, () => {})
  assert.equal(puller.onMessage({ type: 'att-meta', id: 'k1', size: content.length, hash }), true)
  assert.equal(puller.onMessage({ type: 'att-chunk', id: 'k1', index: 0, data: content.toString('base64'), final: true }), true)
  assert.equal(puller.onMessage({ type: 'att-end', sent: 1, missing: 0 }), false)
  assert.deepEqual(arrived, ['k1'], 'the host must be told the file landed so the UI can refresh')
})

test('P1-8: open-file with a missing local attachment kicks an immediate sync round', () => {
  // Source anchor on the handler wiring: the missing-file branch must call notifySyncChange
  // (the kickSyncRound bridge) so the targeted pull runs now instead of at the next 5-min round.
  const src = readFileSync(ROOT + 'src/main/handlers/attachments.js', 'utf8')
  assert.match(src, /notifySyncChange\('attachment-missing-open'\)/)
})
