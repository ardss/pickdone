/* eslint-env node */
/**
 * Lane A REAL-browser CORS proof host: serves the test page on http://localhost:5173
 * (the allowlisted origin) and runs the bridge on an ephemeral loopback port with that
 * origin allowlisted. The page performs a REAL cross-origin fetch flow from Chromium:
 * OPTIONS preflight -> pair -> pull -> push -> (orchestrator revokes) -> expect readable 401.
 * Prints one JSON ready line; results are read from the page's window.__results.
 */
import { createServer } from 'node:http'
import { CrossPlatformBridge } from '../../src/main/cross-platform/http-bridge.mjs'

const PAGE = (portQ) => `<!doctype html><html><body><h1>PD cross-origin bridge proof</h1><pre id="out">running</pre>
<script>
const q = new URLSearchParams(location.search)
const base = 'http://127.0.0.1:' + q.get('port')
const out = []
window.__results = out
const log = (name, ok, detail) => { out.push({ name, ok, detail }); document.getElementById('out').textContent = JSON.stringify(out) }
const post = async (p, body, headers = {}) => {
  const r = await fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) })
  let json = null
  try { json = await r.json() } catch { json = null }
  return { status: r.status, json }
}
;(async () => {
  try {
    const pair = await post('/crossplatform/pair', { challengeId: q.get('challengeId'), code: q.get('code'), deviceId: 'chromium-web' })
    log('pair', pair.status === 200 && pair.json.ok, 'status=' + pair.status + ' scope=' + (pair.json && pair.json.scope))
    if (!pair.json.ok) return
    const t = pair.json
    const auth = () => ({ Authorization: 'Bearer ' + t.token, 'X-PickDone-Request': t.csrfHeader })
    const pull = await post('/crossplatform/pull', { deviceId: 'chromium-web', messageId: 'cr-pull-1' }, auth())
    log('pull', pull.status === 200 && pull.json.ok, 'status=' + pull.status + ' todos=' + (pull.json.result ? pull.json.result.entities.todos.length : '?'))
    const push = await post('/crossplatform/push', { deviceId: 'chromium-web', messageId: 'cr-push-1', payload: { ops: [{ entity: 'todos', rows: [{ taskId: 'cr-1', title: 'written from Chromium', updatedAt: 1000, deleted: 0, deletedAt: 0 }] }] } }, auth())
    log('push', push.status === 200 && push.json.result.results[0].outcomes[0].verdict === 'applied', 'status=' + push.status + ' verdict=' + (push.json.result ? push.json.result.results[0].outcomes[0].verdict : '?'))
    // revoke leg: poll until the desktop-side revocation lands; the 401 must be READABLE
    // from the page (CORS headers on error responses), not a swallowed network failure
    for (let i = 0; i < 20; i++) {
      await new Promise(r => setTimeout(r, 1000))
      const after = await post('/crossplatform/pull', { deviceId: 'chromium-web', messageId: 'cr-pull-after-revoke-' + i }, auth())
      if (after.status === 401) {
        log('after-revoke', after.json && after.json.error === 'token_revoked', 'status=' + after.status + ' error=' + (after.json && after.json.error))
        break
      }
    }
    window.__ready = true
  } catch (e) {
    log('fatal', false, String(e))
  }
})()
</script></body></html>`

const args = process.argv.slice(2)
const flag = n => args.includes(n)
if (!flag('--enable-bridge')) {
  console.log(JSON.stringify({ event: 'refused', reason: 'level-1 opt-in missing: --enable-bridge' }))
  process.exit(2)
}

const { DatabaseSync } = await import('node:sqlite')
const { createRequire } = await import('node:module')
const require = createRequire(import.meta.url)
const { SCHEMA } = require('../../src/main/db-schema.js')

const db = new DatabaseSync(':memory:')
db.exec(SCHEMA)
const stmts = {
  getById: db.prepare('SELECT * FROM todos WHERE id = ?'),
  getAll: db.prepare('SELECT * FROM todos'),
  upsert: db.prepare('INSERT INTO todos (id, content, updatedAt, deleted, deletedAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET content=excluded.content, updatedAt=excluded.updatedAt, deleted=excluded.deleted, deletedAt=excluded.deletedAt'),
  allCategories: db.prepare('SELECT * FROM categories'),
  allEpisodes: db.prepare('SELECT * FROM work_episodes'),
  allSources: db.prepare('SELECT * FROM source_refs'),
  allLinks: db.prepare('SELECT * FROM task_source_links')
}
const OPS = {
  getById: id => stmts.getById.get(String(id)) || null,
  getAll: () => stmts.getAll.all(),
  upsert: (id, content, updatedAt, deleted, deletedAt) => { stmts.upsert.run(String(id), content ?? null, updatedAt || 0, deleted || 0, deletedAt || 0); return true },
  getAllCategories: () => stmts.allCategories.all(),
  upsertCategory: () => true,
  episodeAllRows: () => stmts.allEpisodes.all(),
  episodePut: () => true,
  episodeRemoveIds: () => [],
  sourceAllRows: () => stmts.allSources.all(),
  sourcePut: () => true,
  sourceRemoveByIds: () => [],
  taskSourceAllRows: () => stmts.allLinks.all(),
  taskSourcePut: () => true,
  taskSourceRemove: () => []
}
const bridge = new CrossPlatformBridge({
  repo: { get: (e, id) => OPS.getById(id), put: (e, r) => OPS.upsert(r.id, r.content, r.updatedAt, r.deleted, r.deletedAt), allRows: e => OPS[e === 'todos' ? 'getAll' : 'getAllCategories'] ? (e === 'todos' ? OPS.getAll() : []) : [] },
  stores: {
    pairingSecret: { load: () => null, save: () => {} },
    sessionNonce: { load: () => null, save: () => {} },
    revocations: { load: () => [], save: () => {} }
  },
  allowedOrigins: ['http://localhost:5173']
})
const listening = await bridge.start({ port: 0 })
const ch = bridge.issuePairing('chromium-web', { scope: 'WRITE' })

const pageServer = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(PAGE(listening.port))
})
await new Promise(r => pageServer.listen(5173, '127.0.0.1', r))

const stopFile = process.env.TEMP + String.fromCharCode(92) + 'pd-chromium-cors.stop'
const revokeFile = process.env.TEMP + String.fromCharCode(92) + 'pd-chromium-cors.revoke'
const { existsSync, unlinkSync } = await import('node:fs')
console.log(JSON.stringify({ event: 'ready', bridgePort: listening.port, pagePort: 5173, challenge: { challengeId: ch.challengeId, code: ch.code } }))
let revokedOnce = false
while (!existsSync(stopFile)) {
  if (!revokedOnce && existsSync(revokeFile)) {
    bridge.revokeDevice('chromium-web')
    revokedOnce = true
    try { unlinkSync(revokeFile) } catch {}
    console.log(JSON.stringify({ event: 'revoked', device: 'chromium-web' }))
  }
  await new Promise(r => setTimeout(r, 300))
}
await new Promise(r => pageServer.close(r))
await bridge.close()
console.log(JSON.stringify({ event: 'stopped' }))
process.exit(0)
