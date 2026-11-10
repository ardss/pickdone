import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { CrossPlatformBridge } from '../../../src/main/cross-platform/http-bridge.mjs'

/**
 * Controlled CORS for browser (Web/PWA) clients — QA finding: OPTIONS returned 405
 * with no Access-Control-Allow-*, so a REAL Chromium page could not call the bridge
 * even with correct credentials. Red-first: the preflight tests in this file FAILED
 * before the fix (405 / null ACAO), then went green.
 *
 * Rules under test:
 *   - OPTIONS answered ONLY on existing routes; Origin MUST be on the explicit
 *     allowlist; unknown origins get NO ACAO reflection at all (fail closed)
 *   - method/header whitelist minimal; Vary: Origin; never a wildcard
 *   - actual responses carry ACAO only for allowlisted origins
 */

function makeBridge (origins) {
  return new CrossPlatformBridge({
    repo: { get: () => null, put: () => {}, allRows: () => [] },
    allowedOrigins: origins,
    stores: {
      pairingSecret: { load: () => 'e2e-secret', save: () => {} },
      sessionNonce: { load: () => 'e2e-nonce', save: () => {} },
      revocations: { load: () => [], save: () => {} }
    }
  })
}

test('red reproduces the QA finding on the pre-fix code: OPTIONS was 405 without ACAO', async () => {
  // guards the fix: with CORS implemented these values MUST change
  const bridge = makeBridge(['http://localhost:5173'])
  const { port } = await bridge.start({ port: 0 })
  const opt = await fetch(`http://127.0.0.1:${port}/crossplatform/pair`, {
    method: 'OPTIONS',
    headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization, x-pickdone-request' }
  })
  // post-fix contract:
  assert.equal(opt.status, 204, 'preflight must be 204 on an existing route for an allowed origin')
  assert.equal(opt.headers.get('access-control-allow-origin'), 'http://localhost:5173')
  assert.equal(opt.headers.get('access-control-allow-methods'), 'POST, OPTIONS')
  assert.equal(opt.headers.get('access-control-allow-headers'), 'Authorization, Content-Type, X-PickDone-Request')
  assert.equal(opt.headers.get('vary'), 'Origin')
  assert.ok(opt.headers.get('access-control-max-age'))
  await bridge.close()
})

test('unknown Origin gets NO ACAO reflection and no usable preflight (fail closed)', async () => {
  const bridge = makeBridge(['http://localhost:5173'])
  const { port } = await bridge.start({ port: 0 })
  const opt = await fetch(`http://127.0.0.1:${port}/crossplatform/pull`, {
    method: 'OPTIONS',
    headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' }
  })
  assert.notEqual(opt.status, 204)
  assert.equal(opt.headers.get('access-control-allow-origin'), null, 'unknown origin must never be reflected')
  const text = await opt.text()
  assert.equal(text.includes('*'), false, 'no wildcard anywhere')
  await bridge.close()
})

test('no Origin at all gets no CORS headers (non-browser clients unaffected)', async () => {
  const bridge = makeBridge(['http://localhost:5173'])
  const { port } = await bridge.start({ port: 0 })
  const opt = await fetch(`http://127.0.0.1:${port}/crossplatform/pull`, { method: 'OPTIONS' })
  assert.equal(opt.headers.get('access-control-allow-origin'), null)
  await bridge.close()
})

test('wildcard ACAO is never emitted, even with a broad allowlist', async () => {
  const bridge = makeBridge(['http://localhost:5173', 'http://127.0.0.1:5174'])
  const { port } = await bridge.start({ port: 0 })
  const res = await fetch(`http://127.0.0.1:${port}/crossplatform/hello`, { headers: { Origin: 'http://127.0.0.1:5174' } })
  const aco = res.headers.get('access-control-allow-origin')
  assert.notEqual(aco, '*')
  if (aco) assert.equal(aco, 'http://127.0.0.1:5174', 'origin echoed exactly, never wildcarded')
  assert.equal(res.headers.get('vary'), 'Origin')
  await bridge.close()
})

test('actual POST responses carry the same controlled CORS headers for allowed origins', async () => {
  const bridge = makeBridge(['http://localhost:5173'])
  const { port } = await bridge.start({ port: 0 })
  const res = await fetch(`http://127.0.0.1:${port}/crossplatform/pull`, {
    method: 'POST',
    headers: { Origin: 'http://localhost:5173', 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: 'd', messageId: 'm1' })
  })
  // no CSRF header -> the gate rejects with 403; the browser still needs CORS headers to READ that error
  assert.equal(res.status, 403)
  assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173')
  assert.equal(res.headers.get('vary'), 'Origin')
  await bridge.close()
})

// run-all doctrine (tests/run-all.mjs): the suite runs with --test-force-exit, so a
// file must not leave closing handles behind. undici's global fetch pool tears down its
// keep-alive sockets asynchronously after bridge.close(); give it one settle tick here
// so force-exit finds nothing mid-close (avoids the Windows libuv UV_HANDLE_CLOSING
// assertion at exit).
after(async () => { await new Promise(r => setTimeout(r, 500)) })
