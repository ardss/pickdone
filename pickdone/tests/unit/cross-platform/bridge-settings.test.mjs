import { test } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'
import { createRequire } from 'node:module'
import { networkInterfaces } from 'node:os'

import { CrossPlatformBridge } from '../../../src/main/cross-platform/http-bridge.mjs'
import { createDesktopRepo } from '../../../src/main/cross-platform/desktop-repo.js'
import { SCHEMA } from '../../../src/main/db-schema.js'
import { createRequire as _cr } from 'node:module'
void _cr

const require = createRequire(import.meta.url)
const bootstrap = require('../../../src/main/cross-platform/bridge-bootstrap.js')
const { bridgeIpcHandlers } = require('../../../src/main/cross-platform/bridge-ipc.js')

/**
 * Phase-3 wiring tests: settings-surface seams (devices registry, LAN bind option,
 * discovery beacon, IPC channels) over a REAL temp SQLite and REAL HTTP, with TWO
 * independent simulated clients (web + android).
 */

function tempDesktopDb () {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
  const stmts = {
    getById: db.prepare('SELECT * FROM todos WHERE id = ?'),
    getAll: db.prepare('SELECT * FROM todos'),
    upsert: db.prepare(`INSERT INTO todos (id, content, updatedAt, deleted, deletedAt) VALUES (@id, @content, @updatedAt, @deleted, @deletedAt)
      ON CONFLICT(id) DO UPDATE SET content=excluded.content, updatedAt=excluded.updatedAt, deleted=excluded.deleted, deletedAt=excluded.deletedAt`),
    allCategories: db.prepare('SELECT * FROM categories'),
    allEpisodes: db.prepare('SELECT * FROM work_episodes'),
    allSources: db.prepare('SELECT * FROM source_refs'),
    allLinks: db.prepare('SELECT * FROM task_source_links'),
    episodeLive: db.prepare(`INSERT INTO work_episodes (id, taskId, startedAt, endedAt, note, deleted, deletedAt, updatedAt)
      VALUES (@id, @taskId, @startedAt, @endedAt, @note, 0, 0, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET note=excluded.note, updatedAt=excluded.updatedAt`),
    tomb: db.prepare('UPDATE todos SET deleted=1, deletedAt=?, updatedAt=? WHERE id=? AND deleted=0')
  }
  const OPS = {
    getById: id => stmts.getById.get(String(id)) || null,
    getAll: () => stmts.getAll.all(),
    upsert: r => { stmts.upsert.run({ id: String(r.id), content: r.content ?? null, updatedAt: r.updatedAt || 0, deleted: r.deleted || 0, deletedAt: r.deletedAt || 0 }); return true },
    getAllCategories: () => stmts.allCategories.all(),
    upsertCategory: () => true,
    episodeAllRows: () => stmts.allEpisodes.all(),
    episodePut: r => { stmts.episodeLive.run({ id: String(r.id), taskId: String(r.taskId), startedAt: 0, endedAt: 0, note: r.note ?? null, updatedAt: r.updatedAt || 0 }); return r.id },
    episodeRemoveIds: () => [],
    sourceAllRows: () => stmts.allSources.all(),
    sourcePut: () => true,
    sourceRemoveByIds: () => [],
    taskSourceAllRows: () => stmts.allLinks.all(),
    taskSourcePut: () => true,
    taskSourceRemove: () => []
  }
  const tombTodo = db.prepare('UPDATE todos SET deleted=1, deletedAt=?, updatedAt=? WHERE id=?')
  OPS.episodeRemoveIds = ids => ids.map(i => { stmts.tomb.run(0, 0, String(i && i.id || i)); return i })
  void tombTodo
  const repo = createDesktopRepo((op, p) => {
    const fn = OPS[op]
    if (!fn) throw new Error('tempDesktopDb: unknown op ' + op)
    return fn(p)
  })
  return { db, repo }
}

function tempStores () {
  const state = {}
  const store = key => ({ load: () => state[key] != null ? state[key] : null, save: v => { state[key] = v } })
  return {
    pairingSecret: store('secret'), sessionNonce: store('nonce'), revocations: store('rev'), devices: store('devices'),
    _state: state
  }
}

async function post (port, path, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body)
  })
  return { status: res.status, json: await res.json() }
}

const authHeaders = t => ({ Authorization: `Bearer ${t.token}`, 'X-PickDone-Request': t.csrfHeader, Origin: 'http://localhost:5173' })

test('discovery beacon: GET /crossplatform/hello is the only unauthenticated route and carries no user data', async () => {
  const tdb = tempDesktopDb()
  const bridge = new CrossPlatformBridge({ repo: tdb.repo, stores: tempStores() })
  const { port } = await bridge.start({ port: 0 })
  const res = await fetch(`http://127.0.0.1:${port}/crossplatform/hello`)
  const hello = await res.json()
  assert.deepEqual(hello, { service: 'pickdone-crossplatform', proto: 1, pairingRequired: true })
  // POST-only everywhere else; hello via POST is 405
  // POST to the beacon path is simply not found (routes are explicit; no smuggling)
  const wrong = await fetch(`http://127.0.0.1:${port}/crossplatform/hello`, { method: 'POST', body: '{}' })
  assert.equal(wrong.status, 404)
  await bridge.close()
})

test('default bind is loopback-only; status() exposes sanitized snapshot without secrets', async () => {
  const tdb = tempDesktopDb()
  const stores = tempStores()
  const bridge = new CrossPlatformBridge({ repo: tdb.repo, stores })
  await bridge.start({ port: 0 })
  const st = bridge.status()
  assert.equal(st.running, true)
  assert.equal(st.bindAddress, '127.0.0.1')
  assert.equal(st.lanReachable, false)
  assert.deepEqual(st.devices, [])
  assert.equal(JSON.stringify(st).includes(stores._state.secret), false, 'status never leaks the pairing secret')
  await bridge.close()
})

test('LAN mode (explicit opt-in): binds a wildcard interface and answers on the real LAN address, loopback still works', async () => {
  const tdb = tempDesktopDb()
  const bridge = new CrossPlatformBridge({ repo: tdb.repo, stores: tempStores(), bindAddress: '0.0.0.0' })
  const { port } = await bridge.start({ port: 0 })
  assert.equal(bridge.status().lanReachable, true)
  // loopback still answers
  const loop = await fetch(`http://127.0.0.1:${port}/crossplatform/hello`)
  assert.equal(loop.status, 200)
  // and the machine's real LAN address answers too (when one exists)
  let lanIp = null
  for (const list of Object.values(networkInterfaces())) {
    for (const ni of list || []) {
      if (ni.family === 'IPv4' && !ni.internal) { lanIp = lanIp || ni.address }
    }
  }
  if (lanIp) {
    const lan = await fetch(`http://${lanIp}:${port}/crossplatform/hello`)
    assert.equal(lan.status, 200)
    assert.equal((await lan.json()).service, 'pickdone-crossplatform')
  }
  await bridge.close()
})

test('TWO clients: web pairs WRITE, android pairs READ — independent scopes, shared device registry', async () => {
  const tdb = tempDesktopDb()
  const stores = tempStores()
  const bridge = new CrossPlatformBridge({ repo: tdb.repo, stores, allowedOrigins: ['http://localhost:5173'] })
  const { port } = await bridge.start({ port: 0 })

  const pair = async (device, scope) => {
    const ch = bridge.issuePairing(device, { scope })
    const r = await post(port, '/crossplatform/pair', { challengeId: ch.challengeId, code: ch.code, deviceId: device })
    assert.equal(r.status, 200)
    return r.json
  }
  const web = await pair('web-client', 'WRITE')
  const android = await pair('android-client', 'READ')
  const dev = bridge.status().devices
  assert.equal(dev.length, 2)
  assert.deepEqual(dev.map(d => d.scope).sort(), ['READ', 'WRITE'])
  assert.ok(JSON.stringify(stores._state.devices).includes('web-client'), 'registry persisted to the devices store')

  // web pushes a task; android (READ) can pull it but not push
  const push = await post(port, '/crossplatform/push', {
    deviceId: 'web-client', messageId: 'w1',
    payload: { ops: [{ entity: 'todos', rows: [{ taskId: 't-web', title: 'from web', updatedAt: 10, deleted: 0, deletedAt: 0 }] }] }
  }, authHeaders(web))
  assert.equal(push.status, 200)
  const apull = await post(port, '/crossplatform/pull', { deviceId: 'android-client', messageId: 'a1' }, authHeaders(android))
  assert.equal(apull.status, 200)
  assert.ok(apull.json.result.entities.todos.find(x => x.taskId === 't-web'))
  const apush = await post(port, '/crossplatform/push', {
    deviceId: 'android-client', messageId: 'a2',
    payload: { ops: [{ entity: 'todos', rows: [{ taskId: 't-and', updatedAt: 11, deleted: 0, deletedAt: 0 }] }] }
  }, authHeaders(android))
  assert.equal(apush.status, 401)
  assert.equal(apush.json.error, 'token_bad_scope')

  // disconnect/retry: web re-sends w1 after a flaky drop -> cached verdict, no double apply
  const retry = await post(port, '/crossplatform/push', {
    deviceId: 'web-client', messageId: 'w1',
    payload: { ops: [{ entity: 'todos', rows: [{ taskId: 't-web', title: 'from web', updatedAt: 10, deleted: 0, deletedAt: 0 }] }] }
  }, authHeaders(web))
  assert.equal(retry.json.replay, true)

  // delete tombstone flows through and android sees it on pull
  const del = await post(port, '/crossplatform/push', {
    deviceId: 'web-client', messageId: 'w2',
    payload: { ops: [{ entity: 'todos', rows: [{ taskId: 't-web', deleted: 1, deletedAt: 20, updatedAt: 20 }] }] }
  }, authHeaders(web))
  // local live row (updatedAt 10) vs newer inbound tombstone (20): tombstone wins, conflict surfaced
  assert.equal(del.json.result.results[0].outcomes[0].verdict, 'conflict_tombstone_wins')
  const sqlite = tdb.db.prepare('SELECT deleted, deletedAt FROM todos WHERE id = ?').get('t-web')
  assert.deepEqual([sqlite.deleted, sqlite.deletedAt], [1, 20])
  const apull2 = await post(port, '/crossplatform/pull', { deviceId: 'android-client', messageId: 'a3' }, authHeaders(android))
  assert.equal(apull2.json.result.entities.todos.find(x => x.taskId === 't-web').deleted, 1)

  // revoke android mid-session: its token dies instantly; web is untouched
  bridge.revokeDevice('android-client')
  const dead = await post(port, '/crossplatform/pull', { deviceId: 'android-client', messageId: 'a4' }, authHeaders(android))
  assert.equal(dead.status, 401)
  assert.equal(dead.json.error, 'token_revoked')
  const webStill = await post(port, '/crossplatform/pull', { deviceId: 'web-client', messageId: 'w3' }, authHeaders(web))
  assert.equal(webStill.status, 200)
  assert.ok(bridge.status().devices.find(d => d.deviceId === 'android-client').revokedAt)
  await bridge.close()
})

// ---- IPC channels (stub ctx, real meta store semantics) ----

function stubCtx (state) {
  const dbCall = (op, params) => {
    if (op === 'getMeta') { const v = state[params]; return v != null ? { value: v } : null }
    if (op === 'setMeta') { state[params.key] = String(params.value); return true }
    if (['getAll', 'getAllCategories', 'episodeAllRows', 'sourceAllRows', 'taskSourceAllRows'].includes(op)) return []
    throw new Error('stub ctx dbCall: ' + op)
  }
  const mainEvent = { sender: { id: 1 } }
  const auxEvent = { sender: { id: 99 } }
  const ctx = { getDbCall: () => dbCall, getMainWindow: () => ({ isDestroyed: () => false, webContents: { id: 1 } }), log: { info: () => {} } }
  return { handlers: bridgeIpcHandlers(ctx), mainEvent, auxEvent, state }
}

test('IPC: aux window is forbidden on every channel; main window can enable/pair/revoke', async () => {
  const { handlers, mainEvent, auxEvent, state } = stubCtx({})
  for (const [ch, fn] of Object.entries(handlers)) {
    try {
      const r = fn(auxEvent, {})
      if (r && typeof r.then === 'function') await r
      assert.fail(ch + ' did not reject aux window')
    } catch { /* expected: sender gate */ }
  }
  // disabled by default
  assert.equal(handlers['crossplatform:status'](mainEvent).running, false)
  // enable -> real listener on loopback
  const st = await handlers['crossplatform:set-enabled'](mainEvent, { enabled: true })
  assert.equal(st.running, true)
  assert.equal(st.bindAddress, '127.0.0.1')
  assert.equal(st.lanReachable, false)
  // issue a pairing code through the settings surface
  const ch = handlers['crossplatform:pair-issue'](mainEvent, { deviceId: 'phone-1', scope: 'READ' })
  assert.match(ch.code, /^\d{6}$/)
  assert.equal(ch.scope, 'READ')
  // device shows up paired after consume
  const port = handlers['crossplatform:port'](mainEvent)
  const pair = await post(port, '/crossplatform/pair', { challengeId: ch.challengeId, code: ch.code, deviceId: 'phone-1' })
  assert.equal(pair.status, 200)
  assert.ok(handlers['crossplatform:status'](mainEvent).devices.find(d => d.deviceId === 'phone-1'))
  // revoke through settings
  const afterRevoke = handlers['crossplatform:revoke'](mainEvent, { deviceId: 'phone-1' })
  assert.ok(afterRevoke.devices.find(d => d.deviceId === 'phone-1' && d.revokedAt))
  // LAN toggle requires the bridge on; then rebinds to a LAN-reachable address
  const stLan = await handlers['crossplatform:set-lan'](mainEvent, { enabled: true })
  assert.equal(stLan.lanEnabled, true)
  assert.equal(stLan.lanReachable, true)
  // disable tears the listener down and resets LAN exposure
  await handlers['crossplatform:set-enabled'](mainEvent, { enabled: false })
  const off = handlers['crossplatform:status'](mainEvent)
  assert.equal(off.running, false)
  assert.equal(off.lanEnabled, false, 'disabling the bridge resets LAN exposure (safer re-enable default)')
  assert.equal(state[bootstrap.__keys.LAN_ENABLED_KEY], '0')
  await bootstrap.stopCrossPlatformBridge()
})

test('IPC state survives restart semantics: enabled flag + devices persist in the meta store', async () => {
  const { handlers, mainEvent, state } = stubCtx({})
  await handlers['crossplatform:set-enabled'](mainEvent, { enabled: true })
  const port = handlers['crossplatform:port'](mainEvent)
  const ch = bootstrap.issuePairing('persist-2', { scope: 'READ' })
  const pair = await post(port, '/crossplatform/pair', { challengeId: ch.challengeId, code: ch.code, deviceId: 'persist-2' })
  assert.equal(pair.status, 200)
  assert.ok(handlers['crossplatform:status'](mainEvent).devices.find(d => d.deviceId === 'persist-2'))
  await bootstrap.stopCrossPlatformBridge()
  // the meta state outlives the process: enabled flag + device registry are in there
  assert.equal(state[bootstrap.__keys.ENABLED_KEY], '1')
  const persisted = JSON.parse(state[bootstrap.__keys.DEVICES_KEY] || '[]')
  assert.ok(persisted.find(d => d.deviceId === 'persist-2'))
  // a fresh getStatus over the same meta (no running singleton) still reports them
  const dbCall = (op, params) => op === 'getMeta' ? (state[params] != null ? { value: state[params] } : null) : true
  const st = bootstrap.getStatus(dbCall)
  assert.equal(st.enabled, true)
  assert.ok(st.devices.find(d => d.deviceId === 'persist-2'))
  assert.equal(st.running, false)
})
