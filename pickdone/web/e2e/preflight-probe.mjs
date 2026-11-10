/* eslint-env node */
// Preflight conformance probe — turnkey red/green for the Lane A CORS gap documented in
// E2E-EVIDENCE.md §①. Starts the REAL bridge against an isolated in-memory SQLite (same shape
// as bridge-harness.mjs, no production data), then audits the three /crossplatform/* routes:
//
//   1. OPTIONS preflight must be answered 200/204 (not 405) with
//        Access-Control-Allow-Origin: echo of an ALLOWLISTED origin only (never '*',
//        never a non-allowlisted echo — credential-bearing surface)
//        Access-Control-Allow-Headers: must include Content-Type AND X-PickDone-Request
//        Access-Control-Allow-Methods: must include POST
//   2. A non-allowlisted Origin must NOT be granted Access-Control-Allow-Origin.
//   3. The gated POST itself stays functional (non-browser, no Origin -> 403 origin_rejected
//      or auth-gated 4xx — proves the probe audits preflight only, AuthGate untouched).
//
// Exit 0 = preflight conforms (Lane A fix landed; run web-roundtrip.mjs next).
// Exit 1 = gap still present; each missing header/route printed as a precise diff line.
//
// Usage: node e2e/preflight-probe.mjs [--port 52131]
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, appendFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const RUN = join(HERE, '.run')
// Resolve the sibling test bridge without embedding a workstation-specific path.
const LANE_A = process.env.PICKDONE_BRIDGE_REPO || resolve(HERE, '../..')
const argPort = (() => { const i = process.argv.indexOf('--port'); return i > 0 ? Number(process.argv[i + 1]) : 52131 })()
const PORT = Number.isFinite(argPort) ? argPort : 52131
const WEB_ORIGIN = 'http://127.0.0.1:5173'

mkdirSync(RUN, { recursive: true })
const audit = line => appendFileSync(join(RUN, 'preflight-probe.log'), new Date().toISOString() + ' ' + line + '\n')

const { CrossPlatformBridge } = await import(pathToFileURL(join(LANE_A, 'src/main/cross-platform/http-bridge.mjs')).href)
const { createDesktopRepo } = await import(pathToFileURL(join(LANE_A, 'src/main/cross-platform/desktop-repo.js')).href)
const { SCHEMA } = await import(pathToFileURL(join(LANE_A, 'src/main/db-schema.js')).href)

const db = new DatabaseSync(':memory:')
db.exec(SCHEMA)
const NOW = Date.now()
db.prepare(`INSERT INTO todos (id, content, description, categoryId, complete, scheduledAt, scheduledDay, remindAt, deadlineTs, createdAt, updatedAt, deleted, deletedAt, version, syncAuthor)
  VALUES ('probe-task-1', 'probe seeded task', '', 0, 0, 0, 20261107, NULL, 0, ?, ?, 0, 0, 1, NULL)`).run(NOW, NOW)
const OPS = {
  getById: () => null,
  getAll: () => db.prepare('SELECT * FROM todos').all(),
  upsert: () => true,
  getAllCategories: () => [],
  upsertCategory: () => true,
  episodeAllRows: () => [],
  episodePut: () => '',
  episodeRemoveIds: () => 0,
  sourceAllRows: () => [], sourcePut: () => '', sourceRemoveByIds: () => 0,
  taskSourceAllRows: () => [], taskSourcePut: () => '', taskSourceRemove: () => 0
}
const repo = createDesktopRepo((op, params) => OPS[op](params))
const stores = { pairingSecret: { load: () => null, save: () => {} }, sessionNonce: { load: () => null, save: () => {} }, revocations: { load: () => [], save: () => {} } }
const bridge = new CrossPlatformBridge({
  repo, stores,
  allowedOrigins: [WEB_ORIGIN, 'http://localhost:5173'],
  log: (tag, line) => audit(`[bridge:${tag}] ${line}`)
})
await bridge.start({ port: PORT })

const ROUTES = ['/crossplatform/pair', '/crossplatform/pull', '/crossplatform/push']
const failures = []
const ok = (cond, passMsg, failMsg) => { if (cond) console.log('  ✓ ' + passMsg); else { console.log('  ✗ ' + failMsg); failures.push(failMsg) } }

async function preflight (route, origin) {
  const res = await fetch(`http://127.0.0.1:${PORT}${route}`, {
    method: 'OPTIONS',
    headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, x-pickdone-request' }
  })
  return { status: res.status, headers: Object.fromEntries(res.headers.entries()) }
}

console.log('PickDone cross-platform bridge — CORS preflight conformance probe')
console.log('bridge under test: ' + LANE_A + ' @ 127.0.0.1:' + PORT)
for (const route of ROUTES) {
  console.log('— ' + route)
  const good = await preflight(route, WEB_ORIGIN)
  ok(good.status === 200 || good.status === 204,
    `${route} OPTIONS answered ${good.status}`,
    `${route} OPTIONS answered ${good.status} (spec: 200/204 — 405 means route not registered for OPTIONS)`)
  const acao = good.headers['access-control-allow-origin']
  ok(acao === WEB_ORIGIN,
    `Allow-Origin echoes the allowlisted origin (${acao})`,
    `Allow-Origin is "${acao ?? '(absent)'}" (spec: echo ${WEB_ORIGIN} for allowlisted origins; '*' forbidden on a credential surface)`)
  const allowHeaders = String(good.headers['access-control-allow-headers'] || '').toLowerCase()
  ok(allowHeaders.includes('content-type') && allowHeaders.includes('x-pickdone-request'),
    `Allow-Headers covers Content-Type + X-PickDone-Request (${good.headers['access-control-allow-headers']})`,
    `Allow-Headers is "${good.headers['access-control-allow-headers'] ?? '(absent)'}" (browser preflight will reject; the CSRF header must be allowlisted)`)
  const allowMethods = String(good.headers['access-control-allow-methods'] || '').toUpperCase()
  ok(allowMethods.includes('POST'),
    `Allow-Methods includes POST (${good.headers['access-control-allow-methods']})`,
    `Allow-Methods is "${good.headers['access-control-allow-methods'] ?? '(absent)'}" (spec: POST)`)
  // negative: a non-allowlisted origin must receive NO Allow-Origin grant
  const evil = await preflight(route, 'http://evil.example')
  ok(!evil.headers['access-control-allow-origin'],
    'non-allowlisted Origin gets no Allow-Origin grant',
    `non-allowlisted Origin got Allow-Origin "${evil.headers['access-control-allow-origin']}" — origin allowlist is bypassed on the preflight path`)
}

// sanity: the gated POST itself still enforces AuthGate (probe audits preflight ONLY)
const post = await fetch(`http://127.0.0.1:${PORT}/crossplatform/pull`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Origin: WEB_ORIGIN },
  body: JSON.stringify({ deviceId: 'probe-no-auth', pull: {} })
}).catch(e => ({ error: String(e && e.message) }))
ok(post && (post.status === 401 || post.status === 403 || post.status === 400 || post.error),
  `gated POST still auth-gated without a token (HTTP ${post.status ?? post.error})`,
  `gated POST unexpectedly answered ${post.status} without a token — AuthGate changed?`)

try { bridge.close() } catch { /* best effort */ }
console.log('')
if (failures.length) {
  console.log(`RESULT: FAIL — ${failures.length} gap(s). This is the documented Lane A CORS preflight gap`)
  console.log('(E2E-EVIDENCE.md §①). Client lane cannot dodge it; server fix spec is in that file.')
  process.exit(1)
}
console.log('RESULT: PASS — preflight conforms. Next: node e2e/web-roundtrip.mjs for the full browser acceptance.')
process.exit(0)
