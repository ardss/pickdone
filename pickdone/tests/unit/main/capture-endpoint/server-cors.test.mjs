/**
 * [S4 capture-endpoint RED→GREEN] CORS surface — the browser extension's origin is a random
 * chrome-extension:// id, so the endpoint answers with Access-Control-Allow-Origin: * (the
 * X-PickDone-Key handshake, not CORS, is the security boundary) and handles the OPTIONS
 * preflight without touching the db.
 *
 * Each test pins a DISTINCT base port: node:test runs after() hooks between tests, and on
 * Windows rebinding a loopback port the instant its previous listener closed gets the new
 * connection RST (ECONNRESET) — a fresh port sidesteps that entirely.
 *
 * Run: node --test tests/unit/main/capture-endpoint/server-cors.test.mjs
 */
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'

import { startCaptureServer } from '../../../../src/main/capture-endpoint/server.js'

function request (port, method, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, res => {
      let body = ''
      res.on('data', c => { body += c })
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })
}

test('CORS: every response carries Access-Control-Allow-Origin: *', async () => {
  const srv = startCaptureServer({ port: 0, isEnabled: () => true, getSecret: () => 'k'.repeat(48) })
  after(() => srv.close())
  await srv.ready
  const denied = await request(srv.actualPort, 'POST', '/capture', { 'content-type': 'application/json' })
  assert.equal(denied.status, 401)
  assert.equal(denied.headers['access-control-allow-origin'], '*')

  const ok = await request(srv.actualPort, 'POST', '/capture', {
    'content-type': 'application/json',
    'x-pickdone-key': 'k'.repeat(48)
  })
  assert.equal(ok.headers['access-control-allow-origin'], '*')
})

test('CORS: OPTIONS preflight → 204 with allow-origin/methods/headers, no db touch', async () => {
  const srv = startCaptureServer({ port: 7791, isEnabled: () => true, getSecret: () => 'k'.repeat(48) })
  after(() => srv.close())
  await srv.ready
  const pre = await request(srv.actualPort, 'OPTIONS', '/capture', {
    'origin': 'chrome-extension://abcdef',
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'content-type,x-pickdone-key'
  })
  assert.equal(pre.status, 204)
  assert.equal(pre.headers['access-control-allow-origin'], '*')
  assert.match(pre.headers['access-control-allow-methods'], /POST/)
  assert.match(pre.headers['access-control-allow-headers'], /x-pickdone-key/i)
})

test('CORS: preflight happens BEFORE auth/kill-switch (no key required, disabled still 204)', async () => {
  const srv = startCaptureServer({ port: 7793, isEnabled: () => false, getSecret: () => null })
  after(() => srv.close())
  await srv.ready
  const pre = await request(srv.actualPort, 'OPTIONS', '/capture')
  assert.equal(pre.status, 204)
  assert.equal(pre.headers['access-control-allow-origin'], '*')
})
