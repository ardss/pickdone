/* eslint-env node */
/**
 * Lane A cross-machine E2E server runner (isolated staging ONLY).
 *
 * Hard gate: refuses to open any listener unless BOTH explicit opt-in flags are given:
 *   --enable-bridge                      (level 1: user explicitly turns the bridge on)
 *   --enable-lan --port <n>              (level 2: explicit non-loopback bind + pinned test port)
 * Loopback-only ephemeral is the default when only --enable-bridge is given.
 *
 * State lives in a TEMP SQLite (node:sqlite, canonical SCHEMA DDL) — production DBs untouched.
 * Protocol: prints a JSON line {event:'ready', port, bind, challenge} for the orchestrator,
 * serves until stdin closes, then verifies the listener is gone before exiting.
 */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const args = process.argv.slice(2)
const flag = n => args.includes(n)
const val = n => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null }

const dbPath = val('--db') || 'e2e-temp.sqlite'
const deviceId = val('--pair-device') || 'win-b'
const enableBridge = flag('--enable-bridge')
const enableLan = flag('--enable-lan')
const port = Number(val('--port') || 0)

if (!enableBridge) {
  console.log(JSON.stringify({ event: 'refused', reason: 'level-1 opt-in missing: pass --enable-bridge' }))
  process.exit(2)
}
if (enableLan && (!port || port <= 1024)) {
  console.log(JSON.stringify({ event: 'refused', reason: 'level-2 opt-in needs an explicit --port > 1024' }))
  process.exit(2)
}

const { SCHEMA } = require('../../src/main/db-schema.js')
const { createDesktopRepo } = require('../../src/main/cross-platform/desktop-repo.js')
const { CrossPlatformBridge } = require('../../src/main/cross-platform/http-bridge.mjs')

const db = new DatabaseSync(dbPath)
db.exec(SCHEMA)
const stmts = {
  getById: db.prepare('SELECT * FROM todos WHERE id = ?'),
  getAll: db.prepare('SELECT * FROM todos'),
  upsert: db.prepare(`INSERT INTO todos (id, content, updatedAt, deleted, deletedAt) VALUES (@id, @content, @updatedAt, @deleted, @deletedAt)
    ON CONFLICT(id) DO UPDATE SET content=excluded.content, updatedAt=excluded.updatedAt, deleted=excluded.deleted, deletedAt=excluded.deletedAt`),
  allCategories: db.prepare('SELECT * FROM categories'),
  upsertCategory: db.prepare(`INSERT INTO categories (id, name, updatedAt, deleted, deletedAt) VALUES (@id, @name, @updatedAt, @deleted, @deletedAt)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, updatedAt=excluded.updatedAt, deleted=excluded.deleted, deletedAt=excluded.deletedAt`),
  allEpisodes: db.prepare('SELECT * FROM work_episodes'),
  episodePut: db.prepare(`INSERT INTO work_episodes (id, taskId, startedAt, endedAt, note, deleted, deletedAt, updatedAt)
    VALUES (@id, @taskId, @startedAt, @endedAt, @note, 0, 0, @updatedAt)
    ON CONFLICT(id) DO UPDATE SET note=excluded.note, updatedAt=excluded.updatedAt`),
  allSources: db.prepare('SELECT * FROM source_refs'),
  allLinks: db.prepare('SELECT * FROM task_source_links')
}
const OPS = {
  getById: id => stmts.getById.get(String(id)) || null,
  getAll: () => stmts.getAll.all(),
  upsert: r => { stmts.upsert.run({ id: String(r.id), content: r.content ?? null, updatedAt: r.updatedAt || 0, deleted: r.deleted || 0, deletedAt: r.deletedAt || 0 }); return true },
  getAllCategories: () => stmts.allCategories.all(),
  upsertCategory: r => { stmts.upsertCategory.run({ id: Number(r.id), name: r.name ?? null, updatedAt: r.updatedAt || 0, deleted: r.deleted || 0, deletedAt: r.deletedAt || 0 }); return true },
  episodeAllRows: () => stmts.allEpisodes.all(),
  episodePut: r => { stmts.episodePut.run({ id: String(r.id), taskId: String(r.taskId), startedAt: r.startedAt || 0, endedAt: r.endedAt || 0, note: r.note ?? null, updatedAt: r.updatedAt || 0 }); return r.id },
  episodeRemoveIds: list => (Array.isArray(list) ? list : [list]).map(i => { db.prepare('UPDATE work_episodes SET deleted=1, deletedAt=?, updatedAt=? WHERE id=?').run((i && i.deletedAt) || Date.now(), (i && i.updatedAt) || Date.now(), String(i && i.id || i)); return i }),
  sourceAllRows: () => stmts.allSources.all(),
  sourcePut: () => true,
  sourceRemoveByIds: () => [],
  taskSourceAllRows: () => stmts.allLinks.all(),
  taskSourcePut: () => true,
  taskSourceRemove: () => []
}
const logs = []
const bridge = new CrossPlatformBridge({
  repo: createDesktopRepo((op, p) => { const fn = OPS[op]; if (!fn) throw new Error('e2e-server: unknown op ' + op); return fn(p) }),
  stores: {
    pairingSecret: { load: () => db.prepare("SELECT value FROM meta WHERE key='crossplatform.pairingSecret'").get()?.value ?? null, save: v => db.prepare("INSERT INTO meta (key,value) VALUES ('crossplatform.pairingSecret',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(v)) },
    sessionNonce: { load: () => db.prepare("SELECT value FROM meta WHERE key='crossplatform.sessionNonce'").get()?.value ?? null, save: v => db.prepare("INSERT INTO meta (key,value) VALUES ('crossplatform.sessionNonce',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(String(v)) },
    revocations: { load: () => { const r = db.prepare("SELECT value FROM meta WHERE key='crossplatform.revocations'").get(); try { return JSON.parse(r?.value || '[]') } catch { return [] } }, save: a => db.prepare("INSERT INTO meta (key,value) VALUES ('crossplatform.revocations',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(a)) },
    devices: { load: () => { const r = db.prepare("SELECT value FROM meta WHERE key='crossplatform.devices'").get(); try { return JSON.parse(r?.value || '[]') } catch { return [] } }, save: a => db.prepare("INSERT INTO meta (key,value) VALUES ('crossplatform.devices',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(a)) }
  },
  allowedOrigins: (val('--origins') || 'http://localhost:5173').split(','),
  bindAddress: enableLan ? '0.0.0.0' : '127.0.0.1',
  log: (kind, msg) => { logs.push(msg); writeFileSync(dbPath + '.server.log', logs.join('\n')) }
})

const listening = await bridge.start({ port: enableLan ? port : 0 })
const ch = bridge.issuePairing(deviceId, { scope: val('--scope') || 'WRITE' })
const device2 = val('--pair-device-2') || deviceId + '-second'
const ch2 = bridge.issuePairing(device2, { scope: 'READ' })
// DESKTOP-side write (the "A writes" leg): seed directly through the canonical repo path
stmts.upsert.run({ id: 'e2e-a-1', content: 'written on A', updatedAt: 500, deleted: 0, deletedAt: 0 })
console.log(JSON.stringify({ event: 'ready', port: listening.port, bind: listening.address, lan: enableLan, challenge: { challengeId: ch.challengeId, code: ch.code, expiresAt: ch.expiresAt }, challenge2: { challengeId: ch2.challengeId, code: ch2.code, expiresAt: ch2.expiresAt }, deviceId, device2 }))

// serve until the stop file appears (orchestrator-controlled lifecycle)
const stopFile = dbPath + '.stop'
const revokeFile = dbPath + '.revoke-' + device2
let revokedOnce = false
while (!existsSync(stopFile)) {
  if (!revokedOnce && existsSync(revokeFile)) {
    bridge.revokeDevice(device2)
    revokedOnce = true
    try { unlinkSync(revokeFile) } catch {}
    console.log(JSON.stringify({ event: 'revoked', device: device2 }))
  }
  await new Promise(r => setTimeout(r, 300))
}
try { unlinkSync(stopFile) } catch {}
await bridge.close()
// verify the listener is really gone
let closed = false
try { const r = await fetch(`http://127.0.0.1:${listening.port}/crossplatform/hello`, { signal: AbortSignal.timeout(1500) }); closed = !r } catch { closed = true }
console.log(JSON.stringify({ event: 'stopped', port: listening.port, listenerVerifiedClosed: closed }))
process.exit(closed ? 0 : 3)
