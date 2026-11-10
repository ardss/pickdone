/* eslint-env node */
/**
 * #226 regression runner — SINGLE-MACHINE dual-instance shape (S2/J2, 2026-11-10).
 *
 * Simulates machine A (desktop, bridge server) and machine B (paired client) as TWO
 * isolated instances in ONE process on ONE machine: each instance has its OWN temp
 * SQLite database (canonical SCHEMA DDL), its OWN persisted bridge stores, and its
 * own node:http bridge on an ephemeral loopback port. B talks to A over REAL HTTP
 * with the real protocol (pair -> pull -> push), exactly the e2e-server/e2e-client
 * lane-A runner shape (f83043b2), minus the second physical machine (that is Wave4).
 *
 * Walks the #226 checklist (docs/sync-matrix.md + MEGA-MISSION J2/J5):
 *   pair -> bidirectional data -> LWW conflict (explained verdict) -> tombstone ->
 *   disconnect + retry convergence -> duplicate send idempotency -> credential
 *   revocation -> restart recovery (data + revocation sticky).
 *
 * Safety: temp SQLite files in a temp dir, loopback bind only, wiped on exit.
 * NO production DB, NO production pairing state is touched (see the manual:
 * docs/lane-a-226-single-machine-regression-20261110.md for the Wave4 real-machine
 * dependencies that this runner deliberately does NOT cover).
 *
 * Usage: node scripts/cross-platform/regression-226-single-machine.mjs
 */
import { DatabaseSync } from 'node:sqlite'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const root = join(import.meta.url.startsWith('file:') ? new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1') : process.cwd())
const { SCHEMA } = require(join(root, 'src/main/db-schema.js'))
const { createDesktopRepo } = require(join(root, 'src/main/cross-platform/desktop-repo.js'))
const { CrossPlatformBridge } = require(join(root, 'src/main/cross-platform/http-bridge.mjs'))

// ---- verdict ledger ----
const results = []
const step = (name, fn) => fn.then(v => { results.push({ name, ok: v.ok === true, detail: v.detail || '' }); return v })
  .catch(e => { results.push({ name, ok: false, detail: String(e && e.message) }); return { ok: false } })

function instance (dir, name) {
  const dbPath = join(dir, `${name}.sqlite`)
  const db = new DatabaseSync(dbPath)
  db.exec(SCHEMA)
  const stmts = {
    getById: db.prepare('SELECT * FROM todos WHERE id = ?'),
    getAll: db.prepare('SELECT * FROM todos'),
    upsertTodo: db.prepare(`INSERT INTO todos (id, content, description, categoryId, complete, scheduledAt, scheduledDay, remindAt, deadlineTs, createdAt, updatedAt, deleted, deletedAt, version, syncAuthor)
      VALUES (@id, @content, @description, @categoryId, @complete, @scheduledAt, @scheduledDay, @remindAt, @deadlineTs, @createdAt, @updatedAt, @deleted, @deletedAt, @version, @syncAuthor)
      ON CONFLICT(id) DO UPDATE SET content=excluded.content, updatedAt=excluded.updatedAt, deleted=excluded.deleted, deletedAt=excluded.deletedAt`),
    allCategories: db.prepare('SELECT * FROM categories'),
    upsertCategory: db.prepare(`INSERT INTO categories (id, name, color, isFolder, parentId, deleted, deletedAt, updatedAt)
      VALUES (@id, @name, @color, @isFolder, @parentId, @deleted, @deletedAt, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, updatedAt=excluded.updatedAt, deleted=excluded.deleted, deletedAt=excluded.deletedAt`),
    allEpisodes: db.prepare('SELECT * FROM work_episodes'),
    episodeLive: db.prepare(`INSERT INTO work_episodes (id, taskId, startedAt, endedAt, note, deleted, deletedAt, updatedAt)
      VALUES (@id, @taskId, @startedAt, @endedAt, @note, 0, 0, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET taskId=excluded.taskId, note=excluded.note, updatedAt=excluded.updatedAt`),
    allSources: db.prepare('SELECT * FROM source_refs'),
    sourceLive: db.prepare(`INSERT INTO source_refs (id, providerId, externalId, title, deleted, deletedAt, updatedAt)
      VALUES (@id, @providerId, @externalId, @title, 0, 0, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, updatedAt=excluded.updatedAt`),
    allLinks: db.prepare('SELECT * FROM task_source_links'),
    linkLive: db.prepare(`INSERT INTO task_source_links (id, taskId, sourceRefId, deleted, deletedAt, updatedAt)
      VALUES (@id, @taskId, @sourceRefId, 0, 0, @updatedAt)
      ON CONFLICT(id) DO UPDATE SET taskId=excluded.taskId, sourceRefId=excluded.sourceRefId, updatedAt=excluded.updatedAt`),
    tomb: db.prepare('UPDATE work_episodes SET deleted=1, deletedAt=?, updatedAt=? WHERE id=? AND deleted=0'),
    tombSource: db.prepare('UPDATE source_refs SET deleted=1, deletedAt=?, updatedAt=? WHERE id=? AND deleted=0'),
    tombLink: db.prepare('UPDATE task_source_links SET deleted=1, deletedAt=?, updatedAt=? WHERE id=? AND deleted=0')
  }
  const tomb = (stmt, list) => { for (const o of (Array.isArray(list) ? list : [list])) stmt.run(Date.now(), Date.now(), String(o ? o.id : o)); return [] }
  const OPS = {
    getById: id => stmts.getById.get(String(id)) || null,
    getAll: () => stmts.getAll.all(),
    upsert: row => { stmts.upsertTodo.run({ content: null, description: null, categoryId: 0, complete: 0, scheduledAt: 0, scheduledDay: 0, remindAt: null, deadlineTs: 0, createdAt: 0, updatedAt: 0, deleted: 0, deletedAt: 0, version: 0, syncAuthor: null, ...row }); return true },
    getAllCategories: () => stmts.allCategories.all(),
    upsertCategory: row => { stmts.upsertCategory.run({ isFolder: 0, parentId: 0, deleted: 0, deletedAt: 0, updatedAt: 0, color: null, name: null, ...row }); return true },
    episodeAllRows: () => stmts.allEpisodes.all(),
    episodePut: row => { stmts.episodeLive.run({ id: String(row.id), taskId: String(row.taskId), startedAt: row.startedAt || 0, endedAt: row.endedAt || 0, note: row.note != null ? row.note : null, updatedAt: row.updatedAt > 0 ? row.updatedAt : Date.now() }); return String(row.id) },
    episodeRemoveIds: l => tomb(stmts.tomb, l),
    sourceAllRows: () => stmts.allSources.all(),
    sourcePut: row => { stmts.sourceLive.run({ id: String(row.id), providerId: String(row.providerId), externalId: String(row.externalId), title: row.title != null ? row.title : null, updatedAt: row.updatedAt > 0 ? row.updatedAt : Date.now() }); return String(row.id) },
    sourceRemoveByIds: l => tomb(stmts.tombSource, l),
    taskSourceAllRows: () => stmts.allLinks.all(),
    taskSourcePut: row => { stmts.linkLive.run({ id: String(row.id), taskId: String(row.taskId), sourceRefId: String(row.sourceRefId), updatedAt: row.updatedAt > 0 ? row.updatedAt : Date.now() }); return String(row.id) },
    taskSourceRemove: l => tomb(stmts.tombLink, l)
  }
  const store = key => ({
    load: () => db.prepare("SELECT value FROM meta WHERE key=?").get(`crossplatform.${key}`)?.value ?? null,
    save: v => db.prepare("INSERT INTO meta (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`crossplatform.${key}`, String(v))
  })
  const bridge = new CrossPlatformBridge({
    repo: createDesktopRepo((op, p) => { const fn = OPS[op]; if (!fn) throw new Error(`instance ${name}: unknown op ${op}`); return fn(p) }),
    stores: { pairingSecret: store('pairingSecret'), sessionNonce: store('sessionNonce'), revocations: { load: () => { try { return JSON.parse(store('revocations').load() || '[]') } catch { return [] } }, save: a => store('revocations').save(JSON.stringify(a)) } },
    allowedOrigins: ['http://localhost:5173'],
    log: () => {}
  })
  return { name, db, bridge, stmts, OPS, dbPath }
}

async function post (port, path, body, headers = {}, deviceIdOverride) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
    return { status: res.status, json: await res.json() }
  } catch (e) {
    return { status: 0, error: e && e.cause ? e.cause.code : String(e && e.message) }
  }
}

const authHeaders = t => ({ Authorization: `Bearer ${t.token}`, 'X-PickDone-Request': t.csrfHeader })
const push = (port, t, messageId, rows) => post(port, '/crossplatform/push', { deviceId: t.deviceId, messageId, payload: { ops: rows } }, authHeaders(t))
const pull = (port, t, messageId) => post(port, '/crossplatform/pull', { deviceId: t.deviceId, messageId }, authHeaders(t))

const dir = mkdtempSync(join(tmpdir(), 'pd226-'))
const A = instance(dir, 'A')
const B = instance(dir, 'B')
await A.bridge.start({ port: 0 }) // real loopback listener, ephemeral port
await B.bridge.start({ port: 0 })
let tokenB // B's WRITE token against A
let tokenA // A-side client token against B (bidirectional leg)

try {
  // S1: production-pairing shape over the wire (one-shot challenge)
  await step('S1 pair', Promise.resolve().then(async () => {
    const ch = A.bridge.issuePairing('B-machine', { scope: 'WRITE' })
    const p = await post(A.bridge.port, '/crossplatform/pair', { challengeId: ch.challengeId, code: ch.code, deviceId: 'B-machine' })
    tokenB = p.json
    const ch2 = B.bridge.issuePairing('A-machine', { scope: 'WRITE' })
    const p2 = await post(B.bridge.port, '/crossplatform/pair', { challengeId: ch2.challengeId, code: ch2.code, deviceId: 'A-machine' })
    tokenA = p2.json
    return { ok: p.status === 200 && p2.status === 200 && !!tokenB.token && !!tokenA.token, detail: `pair statuses ${p.status}/${p2.status}` }
  }))

  // S2: bidirectional push/pull with both sides asserting
  await step('S2 bidirectional', Promise.resolve().then(async () => {
    const up = await push(A.bridge.port, tokenB, 's2-b2a', [{ entity: 'todos', rows: [{ taskId: 'b1', title: 'from B', updatedAt: 100, deleted: 0, deletedAt: 0 }] }])
    const down = await push(B.bridge.port, tokenA, 's2-a2b', [{ entity: 'todos', rows: [{ taskId: 'a1', title: 'from A', updatedAt: 200, deleted: 0, deletedAt: 0 }] }])
    const pl = await pull(A.bridge.port, tokenB, 's2-pull-b')
    const gotB = pl.json?.result?.entities?.todos?.find(t => t.taskId === 'b1')
    const gotA = B.db.prepare('SELECT content FROM todos WHERE id = ?').get('a1')
    return { ok: up.status === 200 && down.status === 200 && gotB?.title === 'from B' && gotA?.content === 'from A', detail: `B->A push ${up.status}, A->B push ${down.status}, A holds b1=${gotB?.title}, B holds a1=${gotA?.content}` }
  }))

  // S3: LWW conflict with explained verdict + tombstone delete wins
  await step('S3 conflict+tombstone', Promise.resolve().then(async () => {
    A.stmts.upsertTodo.run({ id: 'b1', content: 'newer A edit', updatedAt: 1000, deleted: 0, deletedAt: 0, createdAt: 0, scheduledAt: 0, scheduledDay: 0, remindAt: null, deadlineTs: 0, version: 0, syncAuthor: null, description: null, categoryId: 0, complete: 0 })
    const stale = await push(A.bridge.port, tokenB, 's3-stale', [{ entity: 'todos', rows: [{ taskId: 'b1', title: 'stale B edit', updatedAt: 900, deleted: 0, deletedAt: 0 }] }])
    const del = await push(A.bridge.port, tokenB, 's3-del', [{ entity: 'todos', rows: [{ taskId: 'b1', title: 'newer A edit', deleted: 1, deletedAt: 1200, updatedAt: 1200 }] }])
    const row = A.db.prepare('SELECT deleted, deletedAt, updatedAt FROM todos WHERE id = ?').get('b1')
    const staleV = stale.json?.result?.results?.[0]?.outcomes?.[0]?.verdict
    const delV = del.json?.result?.results?.[0]?.outcomes?.[0]?.verdict
    return { ok: staleV === 'stale_skip' && delV === 'conflict_tombstone_wins' && row.deleted === 1 && row.updatedAt === 1200, detail: `stale=${staleV}, delete=${delV}, row=${JSON.stringify(row)}` }
  }))

  // S4: disconnect + retry convergence (bridge down = loud failure; retry after restart)
  await step('S4 disconnect+retry', Promise.resolve().then(async () => {
    const portA = A.bridge.port
    await A.bridge.close()
    const dead = await push(portA, tokenB, 's4-1', [{ entity: 'todos', rows: [{ taskId: 'b2', title: 'offline write', updatedAt: 300, deleted: 0, deletedAt: 0 }] }])
    const loudFail = dead.status === 0 || dead.status >= 400 // never a fake success
    const reborn = new CrossPlatformBridge({ repo: createDesktopRepo((op, p) => { const f = A.OPS[op]; if (!f) throw new Error('op ' + op); return f(p) }), stores: A.bridge.stores, allowedOrigins: ['http://localhost:5173'], log: () => {} })
    await reborn.start({ port: 0 })
    A.bridge = reborn
    const retry = await push(A.bridge.port, tokenB, 's4-1', [{ entity: 'todos', rows: [{ taskId: 'b2', title: 'offline write', updatedAt: 300, deleted: 0, deletedAt: 0 }] }])
    const row = A.db.prepare('SELECT content FROM todos WHERE id = ?').get('b2')
    return { ok: loudFail && retry.status === 200 && row?.content === 'offline write', detail: `dead=${dead.status || dead.error}, retry=${retry.status}, row=${row?.content}` }
  }))

  // S5: duplicate send idempotency
  await step('S5 duplicate send', Promise.resolve().then(async () => {
    const one = await push(A.bridge.port, tokenB, 's5-1', [{ entity: 'todos', rows: [{ taskId: 'b3', title: 'dup', updatedAt: 400, deleted: 0, deletedAt: 0 }] }])
    const two = await push(A.bridge.port, tokenB, 's5-1', [{ entity: 'todos', rows: [{ taskId: 'b3', title: 'dup', updatedAt: 400, deleted: 0, deletedAt: 0 }] }])
    const c = A.db.prepare('SELECT COUNT(*) c FROM todos WHERE id = ?').get('b3').c
    return { ok: one.status === 200 && two.status === 200 && two.json.replay === true && c === 1, detail: `replay=${two.json?.replay}, rows=${c}` }
  }))

  // S6: credential revocation mid-session
  await step('S6 revocation', Promise.resolve().then(async () => {
    A.bridge.revokeDevice('B-machine')
    const after = await pull(A.bridge.port, tokenB, 's6-1')
    return { ok: after.status === 401 && after.json?.error === 'token_revoked', detail: `status=${after.status}, error=${after.json?.error}` }
  }))

  // S7: restart recovery (token validity + revocation sticky across restart)
  await step('S7 restart recovery', Promise.resolve().then(async () => {
    await A.bridge.close()
    const reborn = new CrossPlatformBridge({ repo: createDesktopRepo((op, p) => { const f = A.OPS[op]; if (!f) throw new Error('op ' + op); return f(p) }), stores: A.bridge.stores, allowedOrigins: ['http://localhost:5173'], log: () => {} })
    await reborn.start({ port: 0 })
    A.bridge = reborn
    const ch = reborn.issuePairing('B-machine-2', { scope: 'WRITE' })
    const p = await post(A.bridge.port, '/crossplatform/pair', { challengeId: ch.challengeId, code: ch.code, deviceId: 'B-machine-2' })
    const revokedStill = await pull(A.bridge.port, tokenB, 's7-1')
    const fresh = await pull(A.bridge.port, p.json, 's7-2')
    // A-side rows survived restart AND the B-side row (A->B leg) is still there
    const dataSurvived = A.db.prepare("SELECT COUNT(*) c FROM todos WHERE id IN ('b1','b2','b3')").get().c
    const bHoldsA = B.db.prepare('SELECT content FROM todos WHERE id = ?').get('a1')
    return { ok: revokedStill.status === 401 && fresh.status === 200 && dataSurvived === 3 && bHoldsA?.content === 'from A', detail: `revoked=${revokedStill.status}, fresh=${fresh.status}, A rows=${dataSurvived}, B a1=${bHoldsA?.content}` }
  }))
} finally {
  await A.bridge.close().catch(() => {})
  await B.bridge.close().catch(() => {})
}

// ---- report ----
const pass = results.filter(r => r.ok).length
for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  ${r.detail}`)
console.log(`#226 single-machine regression: ${pass}/${results.length} steps passed`)
try { rmSync(dir, { recursive: true, force: true }) } catch {}
process.exit(pass === results.length ? 0 : 1)
