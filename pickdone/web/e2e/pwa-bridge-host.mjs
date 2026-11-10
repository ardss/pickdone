#!/usr/bin/env node
/* eslint-env node */
/**
 * S5 E2E host: the REAL desktop cross-platform bridge (src/main/cross-platform/http-bridge.mjs)
 * backed by a REAL sqlite file DB, plus an HTTPS static server for the built PWA
 * (service workers require a secure context) and a loopback-only control server for the
 * orchestrator (seed desktop tasks / dump desktop rows / stop).
 *
 * Credentials (self-signed cert) live ONLY in a K:\tmp scratch dir; nothing is committed.
 * Prints one JSON ready line on stdout: {event:'ready', bridgePort, httpsPort, controlPort, challenge}.
 */
import { createServer } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { readFileSync, existsSync } from 'node:fs'
import { join, extname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { CrossPlatformBridge } from '../../src/main/cross-platform/http-bridge.mjs'
import { SCHEMA } from '../../src/main/db-schema.js'

const args = process.argv.slice(2)
const arg = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d }
if (!args.includes('--enable-bridge')) { console.log(JSON.stringify({ event: 'refused', reason: 'opt-in missing: --enable-bridge' })); process.exit(2) }

const DIST = arg('--dist', new URL('../dist', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const DB_PATH = arg('--db')
const CERT_DIR = arg('--certs')
if (!DB_PATH || !CERT_DIR || !existsSync(join(DIST, 'index.html'))) {
  console.log(JSON.stringify({ event: 'refused', reason: 'missing --db / --certs / dist build' })); process.exit(2)
}

// ---- desktop side: real sqlite file + full-column repo shim ----
const db = new DatabaseSync(DB_PATH)
db.exec(SCHEMA)
const columns = {}
for (const table of ['todos', 'categories', 'work_episodes']) {
  columns[table] = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name)
}
function upsertRow(table, row) {
  const cols = columns[table].filter(c => c in row && row[c] !== undefined)
  if (!cols.includes('id') || !cols.length) return false
  const sql = `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${cols.filter(c => c !== 'id').map(c => `${c}=excluded.${c}`).join(',') || 'id=id'}`
  db.prepare(sql).run(...cols.map(c => row[c]))
  return true
}
const repo = {
  get: (entity, id) => db.prepare(`SELECT * FROM ${entity} WHERE id = ?`).get(String(id)) || null,
  put: (entity, row) => upsertRow(entity, row),
  allRows: entity => db.prepare(`SELECT * FROM ${entity}`).all()
}

// ---- HTTPS static server for the built PWA (bind first so the origin allowlist knows the port) ----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json', '.png': 'image/png', '.json': 'application/json' }
const tls = { key: readFileSync(join(CERT_DIR, 'key.pem')), cert: readFileSync(join(CERT_DIR, 'cert.pem')) }
const web = httpsServer(tls, (req, res) => {
  const path = (req.url || '/').split('?')[0]
  const file = path === '/' ? '/index.html' : path
  const full = join(DIST, file.replace(/^\/+/, ''))
  if (!full.startsWith(DIST) || !existsSync(full)) { res.writeHead(404); res.end('not found'); return }
  res.writeHead(200, { 'Content-Type': (MIME[extname(full)] || 'application/octet-stream') + '; charset=utf-8' })
  res.end(readFileSync(full))
})
await new Promise(r => web.listen(0, '127.0.0.1', r))
const httpsPort = web.address().port

// ---- the REAL desktop bridge, allowlisted to the PWA origin only ----
const DEVICE = 'web-pwa-e2e'
const live = new CrossPlatformBridge({
  repo,
  stores: {
    pairingSecret: { load: () => null, save: () => {} },
    sessionNonce: { load: () => null, save: () => {} },
    revocations: { load: () => [], save: () => {} }
  },
  allowedOrigins: ['https://localhost:' + httpsPort]
})
const bound = await live.start({ port: 0 })
const challenge2 = live.issuePairing(DEVICE, { scope: 'WRITE' })

// ---- control server (loopback only, no user data) ----
let stopRequested = false
const control = createServer((req, res) => {
  const path = (req.url || '').split('?')[0]
  if (req.method === 'POST' && path === '/seed') {
    let raw = ''
    req.on('data', c => { raw += c })
    req.on('end', () => {
      try {
        const body = raw ? JSON.parse(raw) : {}
        const now = Date.now()
        const row = {
          id: body.id || ('e2eDesktopSeed' + now),
          content: body.content || 'Desktop seed task',
          description: '', complete: 0, completedAt: 0, deleted: 0, deletedAt: 0,
          createdAt: now, updatedAt: now, syncTime: now, scheduledAt: 0,
          scheduledDay: body.scheduledDay || now ? Number(new Intl.DateTimeFormat('en-CA').format(now).replaceAll('-', '')) : 0,
          sort: now, categoryId: body.categoryId || 0, priority: 0, deadlineTs: 0,
          important: 0, urgent: 0, status: 'add', version: 1
        }
        upsertRow('todos', row)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, id: row.id, content: row.content }))
      } catch (e) { res.writeHead(400); res.end(JSON.stringify({ ok: false, error: String(e) })) }
    })
    return
  }
  if (req.method === 'GET' && path === '/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      todos: db.prepare('SELECT id, content, deleted, updatedAt, version FROM todos').all(),
      categories: db.prepare('SELECT id, name, deleted, updatedAt FROM categories').all(),
      episodes: db.prepare('SELECT id, taskId, note, deleted, updatedAt FROM work_episodes').all()
    }))
    return
  }
  if (req.method === 'POST' && path === '/stop') { stopRequested = true; res.writeHead(200); res.end('{"ok":true}'); return }
  res.writeHead(404); res.end()
})
await new Promise(r => control.listen(0, '127.0.0.1', r))

console.log(JSON.stringify({
  event: 'ready',
  bridgePort: bound.port,
  httpsPort,
  controlPort: control.address().port,
  challenge: { challengeId: challenge2.challengeId, code: challenge2.code, deviceId: DEVICE }
}))
while (!stopRequested) await new Promise(r => setTimeout(r, 300))
await new Promise(r => control.close(r))
await new Promise(r => web.close(r))
await live.close()
console.log(JSON.stringify({ event: 'stopped' }))
process.exit(0)
