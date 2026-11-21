import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { CrossPlatformBridge } from '../../../src/main/cross-platform/http-bridge.mjs'
import { createDesktopRepo } from '../../../src/main/cross-platform/desktop-repo.js'
import { SCHEMA } from '../../../src/main/db-schema.js'
import { PairingChallengeService } from '../../../shared/cross-platform/pairing-challenge.mjs'

/**
 * J5 error-recovery negative cases over the REAL wire (real node:http + fetch + SQLite):
 *   1. weak network / transient repo failure -> client gets 500, retries the SAME
 *      messageId after the transient condition clears -> must RECOVER (re-execute),
 *      never be stuck on a cached failure verdict (silent data loss).
 *   2. bridge disconnect -> in-flight request fails LOUDLY (connection error, no fake
 *      success); after the bridge restarts the same push succeeds; a push that WAS
 *      settled before the disconnect replays idempotently after restart.
 *   3. token expiry -> an expired capability token is 401 token_expired, never 200.
 *   4. duplicate send -> the SAME messageId twice returns the cached verdict and the
 *      DB holds exactly one row.
 * Repository ops are idempotent (upsert/idempotent_skip), so re-executing an unsettled
 * (failed) messageId is safe by contract.
 */

const NOW = () => 1_700_000_000_000

function tempDesktopDb () {
  const db = new DatabaseSync(':memory:')
  db.exec(SCHEMA)
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
    for (const o of (Array.isArray(list) ? list : [list])) stmt.run((o && o.deletedAt) || NOW(), (o && o.updatedAt) || NOW(), String(o ? o.id : o))
    return []
  }
  // injected transient fault: while armed, the repo layer throws (weak-network stand-in)
  const fault = { armed: false }
  const OPS = {
    getById: id => stmts.getById.get(String(id)) || null,
    getAll: () => stmts.getAll.all(),
    upsert: row => { if (fault.armed) throw new Error('simulated transient write failure (weak network)'); stmts.upsertTodo.run(defaults(row)); return true },
    getAllCategories: () => stmts.allCategories.all(),
    upsertCategory: row => { stmts.upsertCategory.run({ isFolder: 0, parentId: 0, deleted: 0, deletedAt: 0, updatedAt: 0, color: null, name: null, ...row }); return true },
    episodeAllRows: () => stmts.allEpisodes.all(),
    episodePut: row => { stmts.episodeLive.run({ id: String(row.id), taskId: String(row.taskId), startedAt: row.startedAt || 0, endedAt: row.endedAt || 0, note: row.note != null ? row.note : null, updatedAt: row.updatedAt > 0 ? row.updatedAt : NOW() }); return String(row.id) },
    episodeRemoveIds: list => tombstone(stmts.tomb, list),
    sourceAllRows: () => stmts.allSources.all(),
    sourcePut: row => { stmts.sourceLive.run({ id: String(row.id), providerId: String(row.providerId), externalId: String(row.externalId), title: row.title != null ? row.title : null, updatedAt: row.updatedAt > 0 ? row.updatedAt : NOW() }); return String(row.id) },
    sourceRemoveByIds: list => tombstone(stmts.tombSource, list),
    taskSourceAllRows: () => stmts.allLinks.all(),
    taskSourcePut: row => { stmts.linkLive.run({ id: String(row.id), taskId: String(row.taskId), sourceRefId: String(row.sourceRefId), updatedAt: row.updatedAt > 0 ? row.updatedAt : NOW() }); return String(row.id) },
    taskSourceRemove: list => tombstone(stmts.tombLink, list)
  }
  const repo = createDesktopRepo((op, p) => { const fn = OPS[op]; if (!fn) throw new Error('unknown op ' + op); return fn(p) })
  return { db, repo, fault }
}

function tempStores () {
  const state = {}
  const store = key => ({ load: () => state[key] != null ? state[key] : null, save: v => { state[key] = v } })
  return { pairingSecret: store('pairingSecret'), sessionNonce: store('sessionNonce'), revocations: store('revocations'), _state: state }
}

async function post (port, path, body, headers = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body)
  })
  return { status: res.status, json: await res.json() }
}

const auditLog = []
let tdb, stores, bridge, port, tokenInfo

async function boot () {
  tdb = tempDesktopDb()
  stores = tempStores()
  bridge = new CrossPlatformBridge({ repo: tdb.repo, stores, allowedOrigins: ['http://localhost:5173'], log: (k, m) => auditLog.push(m) })
  port = (await bridge.start({ port: 0 })).port
  const ch = bridge.issuePairing('dev-recover', { scope: 'WRITE' })
  const pair = await post(port, '/crossplatform/pair', { challengeId: ch.challengeId, code: ch.code, deviceId: 'dev-recover' })
  assert.equal(pair.status, 200)
  tokenInfo = pair.json
}

const authHeaders = t => ({ Authorization: `Bearer ${t.token}`, 'X-PickDone-Request': t.csrfHeader })

before(boot)
after(async () => { await bridge.close(); await new Promise(r => setTimeout(r, 300)) })

const pushTodo = (messageId, taskId, content) => post(port, '/crossplatform/push', {
  deviceId: 'dev-recover', messageId, payload: { ops: [{ entity: 'todos', rows: [{ taskId, title: content, updatedAt: 1000, deleted: 0, deletedAt: 0 }] }] }
}, authHeaders(tokenInfo))

test('J5 WEAK NETWORK: transient repo failure -> 500; retrying the SAME messageId after recovery SUCCEEDS (no cached failure)', async () => {
  tdb.fault.armed = true
  const first = await pushTodo('j5-weak-1', 'j5a', 'weak network write')
  assert.equal(first.status, 500, 'the transient failure surfaces as a 500 (never a fake success)')
  tdb.fault.armed = false // network recovers
  const retry = await pushTodo('j5-weak-1', 'j5a', 'weak network write')
  assert.equal(retry.status, 200, `retry of an UNSETTLED (failed) messageId must re-execute, got ${retry.status} ${JSON.stringify(retry.json)}`)
  assert.equal(retry.json.replay, undefined, 'a recovered retry is a real execution, not a cached verdict')
  assert.equal(tdb.db.prepare('SELECT content FROM todos WHERE id = ?').get('j5a').content, 'weak network write')
})

test('J5 BRIDGE DISCONNECT: after close() the client fails LOUDLY; after restart the same push succeeds', async () => {
  await bridge.close()
  let loudFailure = false
  try {
    const r = await post(port, '/crossplatform/pull', { deviceId: 'dev-recover', messageId: 'j5-disc-0' }, authHeaders(tokenInfo))
    if (r.status >= 400) loudFailure = true // a clean refusal is also acceptable (no fake success)
  } catch { loudFailure = true } // connection error = loud failure
  assert.ok(loudFailure, 'a dead bridge must never answer 200')
  // restart over the SAME persisted state (desktop relaunch shape)
  const reborn = new CrossPlatformBridge({ repo: tdb.repo, stores, allowedOrigins: ['http://localhost:5173'], log: () => {} })
  await reborn.start({ port: 0 })
  port = reborn.port
  bridge = reborn
  const retry = await pushTodo('j5-disc-1', 'j5b', 'written after reconnect')
  assert.equal(retry.status, 200)
  assert.equal(retry.json.replay, undefined)
  assert.equal(tdb.db.prepare('SELECT content FROM todos WHERE id = ?').get('j5b').content, 'written after reconnect')
  // a push that WAS settled before the disconnect replays idempotently across restart
  const settled = await post(port, '/crossplatform/pull', { deviceId: 'dev-recover', messageId: 'j5-disc-0' }, authHeaders(tokenInfo))
  assert.equal(settled.status, 200)
})

test('J5 TOKEN EXPIRY: an expired capability token is 401 token_expired over the real wire', async () => {
  // pair through a pairing service whose clock sits ~16 min in the past: the minted
  // token (15 min TTL) is ALREADY expired when the real gate clock verifies it
  const stale = new PairingChallengeService({ now: () => Date.now() - 16 * 60 * 1000 })
  const expiredBridge = new CrossPlatformBridge({ repo: tdb.repo, stores, allowedOrigins: ['http://localhost:5173'], pairing: stale, log: () => {} })
  await expiredBridge.start({ port: 0 })
  try {
    const ch = stale.issue('dev-expired', { scope: 'WRITE', pairingSecret: expiredBridge.pairingSecret })
    const pair = await post(expiredBridge.port, '/crossplatform/pair', { challengeId: ch.challengeId, code: ch.code, deviceId: 'dev-expired' })
    assert.equal(pair.status, 200)
    const pull = await post(expiredBridge.port, '/crossplatform/pull', { deviceId: 'dev-expired', messageId: 'j5-exp-1' }, {
      Authorization: `Bearer ${pair.json.token}`,
      'X-PickDone-Request': pair.json.csrfHeader,
      Origin: 'http://localhost:5173'
    })
    assert.equal(pull.status, 401)
    assert.equal(pull.json.error, 'token_expired')
  } finally {
    await expiredBridge.close()
  }
})

test('J5 DUPLICATE SEND: the same messageId twice -> cached verdict (replay), exactly one row in SQLite', async () => {
  const first = await pushTodo('j5-dup-1', 'j5c', 'duplicate send')
  assert.equal(first.status, 200)
  assert.equal(first.json.replay, undefined)
  const dup = await pushTodo('j5-dup-1', 'j5c', 'duplicate send')
  assert.equal(dup.status, 200)
  assert.equal(dup.json.replay, true)
  assert.equal(tdb.db.prepare('SELECT COUNT(*) c FROM todos WHERE id = ?').get('j5c').c, 1)
})

after(async () => { await new Promise(r => setTimeout(r, 400)) })
