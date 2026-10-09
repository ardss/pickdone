/**
 * 2026-10-10 relay hardening (CTO sweep B#1/B#5) — the open-registration door:
 *  - per-IP register rate limit (10/min): an unauthenticated flood must hit 429;
 *  - optional enrollment secret: when the operator sets one, register without it is 403
 *    (timing-safe compare) and with it succeeds — closing the guess-an-account takeover.
 * Run: node --test tests/unit/lan-sync/relay-registration-guard.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const { memoryStore, createRelay, startRelayServer } = await import(pathToFileURL(path.join(ROOT, 'server/sync-relay.mjs')))

const register = (url, account, enrollment, header) => fetch(url + '/v1/device/register', {
  method: 'POST',
  // Connection: close (2026-10-10 R2b): undici's pooled keep-alive teardown hits a libuv
  // assertion (`!(handle->flags & UV_HANDLE_CLOSING)`, src/win/async.c) when the server
  // closes under concurrent suite load — a native 0xC0000409 process abort that failed
  // ~half of all full-suite runs. Per-request sockets drain and close server-side, no
  // pooling, so the crash class (and the closeAllConnections workaround) disappears.
  headers: { 'content-type': 'application/json', connection: 'close', ...(header ? { 'x-enrollment': header } : {}) },
  body: JSON.stringify({ account, device: 'dev-guard', ...(enrollment ? { enrollment } : {}) }),
})

test('relay: register rate limit — the 11th registration from one address in a window is 429', async () => {
  const { server, url } = await boot({ enrollment: '' })
  try {
    let last = null
    for (let i = 0; i < 11; i++) last = await register(url, 'acc-rl-' + i)
    assert.equal(last.status, 429, 'the flood must be capped')
    const body = await last.json()
    assert.match(body.error, /too many registrations/)
  } finally { await shutdown(server) }
})

test('relay: enrollment secret set — register without it is 403, with it succeeds', async () => {
  const { server, url } = await boot({ enrollment: 's3cret-enroll' })
  try {
    const denied = await register(url, 'acc-enroll-a')
    assert.equal(denied.status, 403, 'missing enrollment must be rejected')
    assert.match((await denied.json()).error, /enrollment secret required/)

    const badHeader = await register(url, 'acc-enroll-b', 'wrong', 'wrong')
    assert.equal(badHeader.status, 403, 'wrong enrollment (header) must be rejected')

    const okBody = await register(url, 'acc-enroll-c', 's3cret-enroll')
    assert.equal(okBody.status, 200, 'correct enrollment (body) registers')
    const okHeader = await register(url, 'acc-enroll-d', null, 's3cret-enroll')
    assert.equal(okHeader.status, 200, 'correct enrollment (header) registers')
  } finally { await shutdown(server) }
})

test('relay: enrollment unset keeps the historical open registration (clients unaffected)', async () => {
  const { server, url } = await boot({ enrollment: '' })
  try {
    const r = await register(url, 'acc-open-reg')
    assert.equal(r.status, 200, 'no enrollment configured -> open registration unchanged')
  } finally { await shutdown(server) }
})

async function boot ({ enrollment }) {
  const server = await startRelayServer(createRelay(memoryStore(), { enrollment }), { port: 0, host: '127.0.0.1' })
  const { port } = server.address()
  return { server, url: `http://127.0.0.1:${port}` }
}
async function shutdown (server) {
  // with connection:close requests the server drains naturally; the belt-and-suspenders
  // socket kill stays for any stray keep-alive (see the register() note on the libuv crash)
  if (server.closeAllConnections) server.closeAllConnections()
  await new Promise(r => server.close(r))
}
