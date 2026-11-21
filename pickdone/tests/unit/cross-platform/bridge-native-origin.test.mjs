import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { DatabaseSync } from 'node:sqlite'

import { CrossPlatformBridge } from '../../../src/main/cross-platform/http-bridge.mjs'
import { createDesktopRepo } from '../../../src/main/cross-platform/desktop-repo.js'
import { SCHEMA } from '../../../src/main/db-schema.js'

/**
 * qa-r7 P1 regression (S2, 2026-11-10): the AuthGate contract promises a loopback/
 * native passthrough (isLocalLoopback), but the bridge hard-coded it to false, so a
 * REAL native client (Android pair-client.js shape: valid Bearer token + CSRF header,
 * NO Origin header — Capacitor native HTTP does not send browser Origin) was 403
 * origin_rejected even on a fully legitimate loopback session.
 *
 * Fix contract (NO auth weakening):
 *   - remote peer IS loopback AND no Origin header  -> origin check waived (native client)
 *   - Origin header present (loopback or not)       -> normal allowlist check (browsers unchanged)
 *   - bad CSRF / bad token / non-loopback peer      -> still fail closed exactly as before
 *
 * Real node:http server on 127.0.0.1, real fetch() with NO Origin header.
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
    for (const o of (Array.isArray(list) ? list : [list])) {
      stmt.run((o && o.deletedAt) || NOW(), (o && o.updatedAt) || NOW(), String(o ? o.id : o))
    }
    return []
  }
  const OPS = {
    getById: id => stmts.getById.get(String(id)) || null,
    getAll: () => stmts.getAll.all(),
    upsert: row => { stmts.upsertTodo.run(defaults(row)); return true },
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
  return { db, repo: createDesktopRepo((op, p) => { const fn = OPS[op]; if (!fn) throw new Error('unknown op ' + op); return fn(p) }) }
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
let tdb, stores, bridge, port, nativeToken

before(async () => {
  tdb = tempDesktopDb()
  stores = tempStores()
  bridge = new CrossPlatformBridge({ repo: tdb.repo, stores, allowedOrigins: ['http://localhost:5173'], log: (k, m) => auditLog.push(m) })
  port = (await bridge.start({ port: 0 })).port
  // pair exactly like the Android pair-client.js does: one-shot challenge over HTTP
  const ch = bridge.issuePairing('android-native-1', { scope: 'WRITE' })
  const pair = await post(port, '/crossplatform/pair', { challengeId: ch.challengeId, code: ch.code, deviceId: 'android-native-1' })
  assert.equal(pair.status, 200)
  nativeToken = pair.json
})

after(async () => {
  await bridge.close()
  await new Promise(r => setTimeout(r, 300))
})

test('qa-r7 P1: NATIVE client shape (valid token + CSRF, NO Origin header, loopback peer) can pull', async () => {
  const pull = await post(port, '/crossplatform/pull', { deviceId: 'android-native-1', messageId: 'nat-pull-1' }, {
    Authorization: `Bearer ${nativeToken.token}`,
    'X-PickDone-Request': nativeToken.csrfHeader
    // deliberately NO Origin header — the Capacitor native HTTP shape
  })
  assert.equal(pull.status, 200, `native no-Origin pull must pass the gate, got ${pull.status} ${JSON.stringify(pull.json)}`)
  assert.equal(pull.json.ok, true)
})

test('qa-r7 P1: NATIVE client shape can push through the same gate', async () => {
  const push = await post(port, '/crossplatform/push', {
    deviceId: 'android-native-1',
    messageId: 'nat-push-1',
    payload: { ops: [{ entity: 'todos', rows: [{ taskId: 'nat-1', title: 'from android', updatedAt: 900, deleted: 0, deletedAt: 0 }] }] }
  }, { Authorization: `Bearer ${nativeToken.token}`, 'X-PickDone-Request': nativeToken.csrfHeader })
  assert.equal(push.status, 200)
  assert.equal(push.json.result.results[0].outcomes[0].verdict, 'applied')
  assert.equal(tdb.db.prepare('SELECT content FROM todos WHERE id = ?').get('nat-1').content, 'from android')
})

test('NO auth weakening: loopback native peer with a FORGED CSRF header is still 403', async () => {
  const r = await post(port, '/crossplatform/pull', { deviceId: 'android-native-1', messageId: 'nat-csrf-1' }, {
    Authorization: `Bearer ${nativeToken.token}`,
    'X-PickDone-Request': 'forged-nonce'
  })
  assert.equal(r.status, 403)
  assert.equal(r.json.error, 'csrf_rejected')
})

test('NO auth weakening: loopback native peer with NO token is still 401', async () => {
  const r = await post(port, '/crossplatform/pull', { deviceId: 'android-native-1', messageId: 'nat-notok-1' }, {
    'X-PickDone-Request': nativeToken.csrfHeader
  })
  assert.equal(r.status, 401)
  assert.equal(r.json.error, 'token_missing')
})

test('NO auth weakening: FORGED Origin (loopback browser shape, non-allowlisted) is still 403', async () => {
  const r = await post(port, '/crossplatform/pull', { deviceId: 'android-native-1', messageId: 'nat-org-1' }, {
    Authorization: `Bearer ${nativeToken.token}`,
    'X-PickDone-Request': nativeToken.csrfHeader,
    Origin: 'https://evil.example'
  })
  assert.equal(r.status, 403)
  assert.equal(r.json.error, 'origin_rejected')
})

test('NO auth weakening: allowlisted browser Origin still works (controlled CORS unchanged)', async () => {
  const r = await post(port, '/crossplatform/pull', { deviceId: 'android-native-1', messageId: 'nat-org-2' }, {
    Authorization: `Bearer ${nativeToken.token}`,
    'X-PickDone-Request': nativeToken.csrfHeader,
    Origin: 'http://localhost:5173'
  })
  assert.equal(r.status, 200)
})
