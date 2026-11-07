import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { CrossPlatformBridge } from '../../../src/main/cross-platform/http-bridge.mjs'
import { createDesktopRepo } from '../../../src/main/cross-platform/desktop-repo.js'
import { SCHEMA } from '../../../src/main/db-schema.js'


/**
 * Lane A REAL wiring tests: an actual temp SQLite database carrying the canonical
 * desktop SCHEMA DDL, an actual node:http server bound to 127.0.0.1 (ephemeral port),
 * and actual fetch() round trips. Nothing mocked at the transport layer.
 */

// ---- temp SQLite desktop db + the desktop-repo op map ----

function tempDesktopDb () {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
  const now = () => 1_700_000_000_000
  const stmts = {
    getById: db.prepare('SELECT * FROM todos WHERE id = ?'),
    getAll: db.prepare('SELECT * FROM todos'),
    upsertTodo: db.prepare(`INSERT INTO todos (id, content, description, categoryId, complete, scheduledAt, scheduledDay, remindAt, deadlineTs, createdAt, updatedAt, deleted, deletedAt, version, syncAuthor)
      VALUES (@id, @content, @description, @categoryId, @complete, @scheduledAt, @scheduledDay, @remindAt, @deadlineTs, @createdAt, @updatedAt, @deleted, @deletedAt, @version, @syncAuthor)
      ON CONFLICT(id) DO UPDATE SET content=excluded.content, description=excluded.description, categoryId=excluded.categoryId,
        complete=excluded.complete, scheduledAt=excluded.scheduledAt, scheduledDay=excluded.scheduledDay, remindAt=excluded.remindAt,
        deadlineTs=excluded.deadlineTs, createdAt=excluded.createdAt, updatedAt=excluded.updatedAt, deleted=excluded.deleted,
        deletedAt=excluded.deletedAt, version=excluded.version, syncAuthor=excluded.syncAuthor`),
    allCategories: db.prepare('SELECT * FROM categories'),
    upsertCategory: db.prepare(`INSERT INTO categories (id, name, color, isFolder, parentId, deleted, deletedAt, updatedAt)
      VALUES (@id, @name, @color, @isFolder, @parentId, @deleted, @deletedAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, color=excluded.color, isFolder=excluded.isFolder,
        parentId=excluded.parentId, deleted=excluded.deleted, deletedAt=excluded.deletedAt, updatedAt=excluded.updatedAt`),
    allEpisodes: db.prepare('SELECT * FROM work_episodes'),
    episodeLive: db.prepare(`INSERT INTO work_episodes (id, taskId, startedAt, endedAt, note, deleted, deletedAt, updatedAt)
      VALUES (@id, @taskId, @startedAt, @endedAt, @note, 0, 0, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET taskId=excluded.taskId, startedAt=excluded.startedAt, endedAt=excluded.endedAt,
        note=excluded.note, deleted=0, deletedAt=0, updatedAt=excluded.updatedAt`),
    allSources: db.prepare('SELECT * FROM source_refs'),
    sourceLive: db.prepare(`INSERT INTO source_refs (id, providerId, externalId, title, deleted, deletedAt, updatedAt)
      VALUES (@id, @providerId, @externalId, @title, 0, 0, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, deleted=0, deletedAt=0, updatedAt=excluded.updatedAt`),
    allLinks: db.prepare('SELECT * FROM task_source_links'),
    linkLive: db.prepare(`INSERT INTO task_source_links (id, taskId, sourceRefId, deleted, deletedAt, updatedAt)
      VALUES (@id, @taskId, @sourceRefId, 0, 0, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET taskId=excluded.taskId, sourceRefId=excluded.sourceRefId, deleted=0, deletedAt=0, updatedAt=excluded.updatedAt`),
    tomb: db.prepare('UPDATE work_episodes SET deleted=1, deletedAt=?, updatedAt=? WHERE id=? AND deleted=0'),
    tombSource: db.prepare('UPDATE source_refs SET deleted=1, deletedAt=?, updatedAt=? WHERE id=? AND deleted=0'),
    tombLink: db.prepare('UPDATE task_source_links SET deleted=1, deletedAt=?, updatedAt=? WHERE id=? AND deleted=0')
  }
  const defaults = r => ({
    content: null, description: null, categoryId: 0, complete: 0, scheduledAt: 0, scheduledDay: 0,
    remindAt: null, deadlineTs: 0, createdAt: 0, updatedAt: 0, deleted: 0, deletedAt: 0, version: 0, syncAuthor: null,
    ...r
  })
  const tombstone = (stmt, list) => {
    const stamps = Array.isArray(list) ? list : [list]
    const changed = []
    for (const o of stamps) {
      const r = stmt.run((o && o.deletedAt) || now(), (o && o.updatedAt) || now(), String(o ? o.id : o))
      if (r.changes > 0) changed.push(String(o ? o.id : o))
    }
    return changed
  }
  const OPS = {
    getById: id => stmts.getById.get(String(id)) || null,
    getAll: () => stmts.getAll.all(),
    upsert: row => { stmts.upsertTodo.run(defaults(row)); return true },
    getAllCategories: () => stmts.allCategories.all(),
    upsertCategory: row => { stmts.upsertCategory.run({ isFolder: 0, parentId: 0, deleted: 0, deletedAt: 0, updatedAt: 0, color: null, name: null, ...row }); return true },
    episodeAllRows: () => stmts.allEpisodes.all(),
    episodePut: row => { stmts.episodeLive.run({ id: String(row.id), taskId: String(row.taskId), startedAt: row.startedAt || 0, endedAt: row.endedAt || 0, note: row.note != null ? row.note : null, updatedAt: row.updatedAt > 0 ? row.updatedAt : now() }); return String(row.id) },
    episodeRemoveIds: list => tombstone(stmts.tomb, list),
    sourceAllRows: () => stmts.allSources.all(),
    sourcePut: row => { stmts.sourceLive.run({ id: String(row.id), providerId: String(row.providerId), externalId: String(row.externalId), title: row.title != null ? row.title : null, updatedAt: row.updatedAt > 0 ? row.updatedAt : now() }); return String(row.id) },
    sourceRemoveByIds: list => tombstone(stmts.tombSource, list),
    taskSourceAllRows: () => stmts.allLinks.all(),
    taskSourcePut: row => { stmts.linkLive.run({ id: String(row.id), taskId: String(row.taskId), sourceRefId: String(row.sourceRefId), updatedAt: row.updatedAt > 0 ? row.updatedAt : now() }); return String(row.id) },
    taskSourceRemove: list => tombstone(stmts.tombLink, list)
  }
  const repo = createDesktopRepo((op, params) => {
    const fn = OPS[op]
    if (!fn) throw new Error(`tempDesktopDb: unknown op ${op}`)
    return fn(params)
  })
  return { db, repo }
}

// ---- persisted stores (same JSON-file discipline the Electron bootstrap will use) ----

function tempStores () {
  const state = {}
  const store = key => ({
    load: () => state[key] != null ? state[key] : null,
    save: v => { state[key] = v }
  })
  return { pairingSecret: store('pairingSecret'), sessionNonce: store('sessionNonce'), revocations: store('revocations'), _state: state }
}

// ---- HTTP helper ----

async function post (port, path, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
  return { status: res.status, json: await res.json() }
}

// ---- shared fixture ----

const auditLog = []
let tdb, stores, bridge, port, tokenInfo, revokedTokenInfo

async function boot () {
  tdb = tempDesktopDb()
  stores = tempStores()
  bridge = new CrossPlatformBridge({ repo: tdb.repo, stores, allowedOrigins: ['http://localhost:5173'], log: (kind, msg) => auditLog.push(msg) })
  const listening = await bridge.start({ port: 0 })
  port = listening.port
}

async function pairDevice (deviceId, scope = 'WRITE') {
  const ch = bridge.issuePairing(deviceId, { scope })
  const pair = await post(port, '/crossplatform/pair', { challengeId: ch.challengeId, code: ch.code, deviceId })
  assert.equal(pair.status, 200)
  assert.equal(pair.json.ok, true)
  return pair.json
}

const authHeaders = t => ({
  Authorization: `Bearer ${t.token}`,
  'X-PickDone-Request': t.csrfHeader,
  Origin: 'http://localhost:5173'
})

before(async () => { await boot() })
after(async () => { await bridge.close() })

test('boot binds loopback only on an ephemeral port; unknown routes are 404; wrong methods 405', async () => {
  assert.equal(port > 0, true)
  const nf = await fetch(`http://127.0.0.1:${port}/crossplatform/sql`, { method: 'POST', body: 'SELECT 1' })
  assert.equal(nf.status, 404, 'no SQLite/file/command surface: unknown route rejected')
  const mf = await fetch(`http://127.0.0.1:${port}/crossplatform/pull`, { method: 'GET' })
  assert.equal(mf.status, 405)
})

test('UNPAIRED device: pull/push without a token fail closed with 401 token_missing', async () => {
  const noTok = await post(port, '/crossplatform/pull', { deviceId: 'stranger', messageId: 'x1' }, { 'X-PickDone-Request': stores._state.sessionNonce, Origin: 'http://localhost:5173' })
  assert.equal(noTok.status, 401)
  assert.equal(noTok.json.error, 'token_missing')
  // no headers at all -> origin gate rejects even earlier (fail-closed, no payload feedback)
  const bare = await post(port, '/crossplatform/push', { deviceId: 'stranger', messageId: 'x2', payload: { ops: [] } })
  assert.equal(bare.status, 403)
  assert.equal(bare.json.error, 'origin_rejected')
  // correct headers but no bearer -> 401, and the probe learns nothing about payload shape
  const noCreds = await post(port, '/crossplatform/push', { deviceId: 'stranger', messageId: 'x3', payload: { ops: [] } }, { 'X-PickDone-Request': stores._state.sessionNonce, Origin: 'http://localhost:5173' })
  assert.equal(noCreds.status, 401)
  assert.equal(noCreds.json.error, 'token_missing')
})

test('WRONG credentials: forged CSRF header and foreign origin are rejected before auth', async () => {
  const ch = bridge.issuePairing('dev-web', { scope: 'WRITE' })
  const t = await post(port, '/crossplatform/pair', { challengeId: ch.challengeId, code: ch.code, deviceId: 'dev-web' })
  assert.equal(t.status, 200)
  tokenInfo = t.json
  const csrf = await post(port, '/crossplatform/pull', { deviceId: 'dev-web', messageId: 'c1' }, { Authorization: `Bearer ${t.json.token}`, 'X-PickDone-Request': 'forged', Origin: 'http://localhost:5173' })
  assert.equal(csrf.status, 403)
  assert.equal(csrf.json.error, 'csrf_rejected')
  const evil = await post(port, '/crossplatform/pull', { deviceId: 'dev-web', messageId: 'c2' }, { Authorization: `Bearer ${t.json.token}`, 'X-PickDone-Request': t.json.csrfHeader, Origin: 'https://evil.example' })
  assert.equal(evil.status, 403)
  assert.equal(evil.json.error, 'origin_rejected')
})

test('one-shot pairing: replaying the same challenge over HTTP fails with 410 challenge_burned', async () => {
  const ch = bridge.issuePairing('dev-android')
  const first = await post(port, '/crossplatform/pair', { challengeId: ch.challengeId, code: ch.code, deviceId: 'dev-android' })
  assert.equal(first.status, 200)
  const replay = await post(port, '/crossplatform/pair', { challengeId: ch.challengeId, code: ch.code, deviceId: 'dev-android' })
  assert.equal(replay.status, 410)
  assert.equal(replay.json.error, 'challenge_burned')
  // wrong code is 401
  const ch2 = bridge.issuePairing('dev-android2')
  const bad = await post(port, '/crossplatform/pair', { challengeId: ch2.challengeId, code: '000000', deviceId: 'dev-android2' })
  assert.equal(bad.status, 401)
  assert.equal(bad.json.error, 'challenge_bad_code')
})

test('REAL pull: desktop sqlite rows come back as unified DTOs with aliases and tombstones', async () => {
  tdb.repo.put('todos', { id: 'd1', content: 'Desktop task', updatedAt: 111, deleted: 0, deletedAt: 0 })
  tdb.repo.put('todos', { id: 'd2', content: 'Deleted one', updatedAt: 222, deleted: 1, deletedAt: 220 })
  tdb.repo.put('categories', { id: 7, name: 'Work', updatedAt: 5, deleted: 0, deletedAt: 0 })
  tdb.repo.put('work_episodes', { id: 'e1', taskId: 'd1', startedAt: 10, endedAt: 20, note: 'focus', updatedAt: 9, deleted: 0, deletedAt: 0 })
  tdb.repo.put('source_refs', { id: 'r1', providerId: 'jira', externalId: 'X-1', title: 'Bug', updatedAt: 3, deleted: 0, deletedAt: 0 })
  tdb.repo.put('task_source_links', { id: 'l1', taskId: 'd1', sourceRefId: 'r1', updatedAt: 3, deleted: 0, deletedAt: 0 })

  const t = await pairDevice('dev-pull')
  const pull = await post(port, '/crossplatform/pull', { deviceId: 'dev-pull', messageId: 'p1' }, authHeaders(t))
  assert.equal(pull.status, 200)
  assert.equal(pull.json.ok, true)
  const ents = pull.json.result.entities
  const todo = ents.todos.find(x => x.taskId === 'd1')
  assert.equal(todo.title, 'Desktop task')
  const tomb = ents.todos.find(x => x.taskId === 'd2')
  assert.deepEqual([tomb.deleted, tomb.deletedAt], [1, 220])
  assert.equal(ents.categories.find(c => c.id === 7).name, 'Work')
  assert.equal(ents.work_episodes.find(e => e.episodeId === 'e1').summary, 'focus')
  assert.equal(ents.source_refs.find(r => r.id === 'r1').providerId, 'jira')
  assert.equal(ents.task_source_links.find(l => l.id === 'l1').sourceRefId, 'r1')
})

test('REAL push: web client task lands in desktop SQLite; duplicate messageId is idempotent (no double write)', async () => {
  const pushBody = {
    deviceId: 'dev-web',
    messageId: 'push-m1',
    payload: { ops: [{ entity: 'todos', rows: [{ taskId: 'w1', title: 'From web', updatedAt: 500, deleted: 0, deletedAt: 0 }] }] }
  }
  const first = await post(port, '/crossplatform/push', pushBody, authHeaders(tokenInfo))
  assert.equal(first.status, 200)
  assert.equal(first.json.result.results[0].outcomes[0].verdict, 'applied')
  const row = tdb.db.prepare('SELECT id, content, updatedAt FROM todos WHERE id = ?').get('w1')
  assert.equal(row.content, 'From web')
  assert.equal(row.updatedAt, 500)

  // flaky-network retry: the SAME messageId returns the cached verdict, the DB is untouched
  const retry = await post(port, '/crossplatform/push', pushBody, authHeaders(tokenInfo))
  assert.equal(retry.status, 200)
  assert.equal(retry.json.replay, true)
  assert.equal(tdb.db.prepare('SELECT COUNT(*) c FROM todos WHERE id = ?').get('w1').c, 1)

  // a DIFFERENT messageId with the same row content is an idempotent skip at the repo layer
  const again = await post(port, '/crossplatform/push', { ...pushBody, messageId: 'push-m2' }, authHeaders(tokenInfo))
  assert.equal(again.json.result.results[0].outcomes[0].verdict, 'idempotent_skip')
})

test('tombstone conflict through the real wire: newer delete wins onto SQLite, verdict is surfaced', async () => {
  tdb.repo.put('todos', { id: 'w1', content: 'From web', updatedAt: 500, deleted: 0, deletedAt: 0 })
  const r = await post(port, '/crossplatform/push', {
    deviceId: 'dev-web',
    messageId: 'push-del1',
    payload: { ops: [{ entity: 'todos', rows: [{ taskId: 'w1', title: 'From web', deleted: 1, deletedAt: 600, updatedAt: 600 }] }] }
  }, authHeaders(tokenInfo))
  assert.equal(r.json.result.results[0].outcomes[0].verdict, 'conflict_tombstone_wins')
  const row = tdb.db.prepare('SELECT deleted, deletedAt, updatedAt FROM todos WHERE id = ?').get('w1')
  assert.deepEqual([row.deleted, row.deletedAt, row.updatedAt], [1, 600, 600])
  // stale delete must NOT regress a newer local edit
  const r2 = await post(port, '/crossplatform/push', {
    deviceId: 'dev-web',
    messageId: 'push-del2',
    payload: { ops: [{ entity: 'todos', rows: [{ taskId: 'w1', deleted: 1, deletedAt: 10, updatedAt: 10 }] }] }
  }, authHeaders(tokenInfo))
  assert.equal(r2.json.result.results[0].outcomes[0].verdict, 'stale_skip')
  assert.equal(tdb.db.prepare('SELECT updatedAt FROM todos WHERE id = ?').get('w1').updatedAt, 600)
})

test('episode + source + link round trip through the real repo onto SQLite', async () => {
  const r = await post(port, '/crossplatform/push', {
    deviceId: 'dev-web',
    messageId: 'push-ep1',
    payload: {
      ops: [
        { entity: 'work_episodes', rows: [{ episodeId: 'wep1', taskId: 'w1', startedAt: 1, endedAt: 2, summary: 'web focus', updatedAt: 700, deleted: 0, deletedAt: 0 }] },
        { entity: 'source_refs', rows: [{ id: 'wsr1', providerId: 'webclip', externalId: 'u1', title: 'Page', updatedAt: 700, deleted: 0, deletedAt: 0 }] },
        { entity: 'task_source_links', rows: [{ id: 'wlk1', taskId: 'w1', sourceRefId: 'wsr1', updatedAt: 700, deleted: 0, deletedAt: 0 }] }
      ]
    }
  }, authHeaders(tokenInfo))
  assert.equal(r.status, 200)
  const [ep, sr, lk] = r.json.result.results
  assert.equal(ep.outcomes[0].verdict, 'applied')
  assert.equal(tdb.db.prepare('SELECT note FROM work_episodes WHERE id = ?').get('wep1').note, 'web focus')
  assert.equal(sr.outcomes[0].verdict, 'applied')
  assert.equal(tdb.db.prepare('SELECT externalId FROM source_refs WHERE id = ?').get('wsr1').externalId, 'u1')
  assert.equal(lk.outcomes[0].verdict, 'applied')
  assert.equal(tdb.db.prepare('SELECT sourceRefId FROM task_source_links WHERE id = ?').get('wlk1').sourceRefId, 'wsr1')
  // inbound tombstone for the episode goes through the stamp-preserving remove path
  const r2 = await post(port, '/crossplatform/push', {
    deviceId: 'dev-web',
    messageId: 'push-ep2',
    payload: { ops: [{ entity: 'work_episodes', rows: [{ episodeId: 'wep1', taskId: 'w1', deleted: 1, deletedAt: 800, updatedAt: 800 }] }] }
  }, authHeaders(tokenInfo))
  const row = tdb.db.prepare('SELECT deleted, deletedAt, updatedAt FROM work_episodes WHERE id = ?').get('wep1')
  assert.deepEqual([row.deleted, row.deletedAt, row.updatedAt], [1, 800, 800])
  void r2
})

test('REVOKE: desktop revokeDevice kills the token mid-session over the real wire, and stays revoked', async () => {
  const t = await pairDevice('dev-kill', 'READ')
  revokedTokenInfo = t
  const ok = await post(port, '/crossplatform/pull', { deviceId: 'dev-kill', messageId: 'k0' }, authHeaders(t))
  assert.equal(ok.status, 200)
  bridge.revokeDevice('dev-kill')
  const after = await post(port, '/crossplatform/pull', { deviceId: 'dev-kill', messageId: 'k1' }, authHeaders(t))
  assert.equal(after.status, 401)
  assert.equal(after.json.error, 'token_revoked')
})

test('RESTART recovery: a fresh bridge over the SAME persisted state keeps tokens valid and revocations sticky', async () => {
  await pairDevice('dev-persist')
  await bridge.close()
  // desktop restart: same stores (simulating the persisted meta), new process
  const reborn = new CrossPlatformBridge({ repo: tdb.repo, stores, allowedOrigins: ['http://localhost:5173'], log: () => {} })
  await reborn.start({ port: 0 })
  const newPort = reborn.port
  // old token still verifies (same HMAC secret), revocation persisted earlier still holds
  const still = await post(newPort, '/crossplatform/pull', { deviceId: 'dev-web', messageId: 'restart-1' }, authHeaders(tokenInfo))
  assert.equal(still.status, 200)
  const revoked = await post(newPort, '/crossplatform/pull', { deviceId: 'dev-kill', messageId: 'restart-2' }, authHeaders(revokedTokenInfo))
  assert.equal(revoked.status, 401)
  assert.equal(revoked.json.error, 'token_revoked')
  // pairing secret survived: a challenge issued by the NEW bridge consumes fine
  const ch = reborn.issuePairing('dev-new')
  const pair = await post(newPort, '/crossplatform/pair', { challengeId: ch.challengeId, code: ch.code, deviceId: 'dev-new' })
  assert.equal(pair.status, 200)
  await reborn.close()
  // bring the original bridge back so later tests in this file have a live server
  const relistened = await bridge.start({ port: 0 })
  port = relistened.port
})

test('malformed bodies fail closed with explicit codes; oversized payload is 413', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/crossplatform/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json'
  })
  assert.equal(res.status, 400)
  assert.equal((await res.json()).error, 'invalid_json')
  const big = await post(port, '/crossplatform/push', { deviceId: 'dev-web', messageId: 'big1', payload: { ops: [{ entity: 'todos', rows: new Array(501).fill({ taskId: 'x', updatedAt: 1, deleted: 0, deletedAt: 0 }) }] } }, authHeaders(tokenInfo))
  assert.equal(big.status, 400, 'push batch over the 500-op ceiling is rejected')
})

test('READ scope enforcement on the real wire: a READ-only paired device cannot push', async () => {
  const t = await pairDevice('dev-read', 'READ')
  const r = await post(port, '/crossplatform/push', {
    deviceId: 'dev-read',
    messageId: 'read-1',
    payload: { ops: [{ entity: 'todos', rows: [{ taskId: 'nope', updatedAt: 1, deleted: 0, deletedAt: 0 }] }] }
  }, authHeaders(t))
  assert.equal(r.status, 401)
  assert.equal(r.json.error, 'token_bad_scope')
  assert.equal(tdb.db.prepare('SELECT COUNT(*) c FROM todos WHERE id = ?').get('nope').c, 0)
  // but READ pull works
  const ok = await post(port, '/crossplatform/pull', { deviceId: 'dev-read', messageId: 'read-2' }, authHeaders(t))
  assert.equal(ok.status, 200)
})

test('audit trail captured real security events', () => {
  assert.ok(auditLog.some(m => m.includes('paired device dev-web')), 'pairing audited')
  assert.ok(auditLog.some(m => m.includes('device revoked: dev-kill')), 'revocation audited')
  assert.ok(auditLog.some(m => m.includes('listening on 127.0.0.1:')), 'bind address audited')
})

// run-all doctrine (tests/run-all.mjs): the suite runs with --test-force-exit, so a
// file must not leave closing handles behind. undici's global fetch pool tears down its
// keep-alive sockets asynchronously after bridge.close(); give it one settle tick here
// so force-exit finds nothing mid-close (avoids the Windows libuv UV_HANDLE_CLOSING
// assertion at exit).
after(async () => { await new Promise(r => setTimeout(r, 500)) })
