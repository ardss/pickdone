/**
 * 2026-10-10 — relay 413 body-limit response must be readable, not ECONNRESET.
 *
 * Independent integration loopback finding: POSTing a 9MB body to the relay made the
 * client's fetch fail with ECONNRESET instead of resolving the HTTP 413. Root cause:
 * startRelayServer wrote the 413 from inside req.on('data') while the client was still
 * uploading, then stopped consuming the socket — the unconsumed request body backed up
 * the connection and Node reset it before the client ever read the response.
 *
 * Fix: over-limit is only FLAGGED in the 'data' handler; the body keeps being consumed
 * and DISCARDED (no buffering, O(1) memory), and exactly one 413 is written on req
 * 'end' — after the client finished uploading and can reliably read it.
 *
 * Run: node --test tests/unit/lan-sync/relay-413-drain.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const { memoryStore, createRelay, startRelayServer } = await import(pathToFileURL(path.join(ROOT, 'server/sync-relay.mjs')))

const bigJsonBody = JSON.stringify({ account: 'acc', device: 'dev', items: [{ opId: 'op-big', envelope: 'x'.repeat(9 * 1024 * 1024) }] })

test('relay: a 9MB POST resolves as HTTP 413 (not ECONNRESET), and the server stays usable afterwards', async () => {
  const relay = createRelay(memoryStore())
  const server = await startRelayServer(relay, { port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    // 1) oversized upload: must be a readable 413, never a socket-level failure.
    //    Before the fix this rejected with FetchError/ECONNRESET while the client
    //    was still writing the body.
    const res = await fetch(base + '/v1/sync/push', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bigJsonBody,
    })
    assert.equal(res.status, 413, 'oversized POST gets an explicit, readable 413')
    const errBody = await res.json()
    assert.equal(errBody.error, 'request body too large')

    // 2) the same server keeps serving small requests after the 413 — the connection
    //    handling did not wedge the listener or leak a half-response.
    const reg = await fetch(base + '/v1/device/register', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'acc', device: 'dev' }),
    })
    assert.equal(reg.status, 200)
    const regBody = await reg.json()
    assert.ok(regBody.device.deviceSecret, 'register still works after the 413')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
