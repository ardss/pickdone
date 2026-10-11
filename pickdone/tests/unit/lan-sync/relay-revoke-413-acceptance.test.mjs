/**
 * 2026-10-10 — relay device-revocation × oversize-body HTTP acceptance.
 *
 * The relay has no dedicated revoke endpoint: the only revocation path is
 * secret ROTATION via a proven re-register (registerDevice requires the
 * current secret as proof, 409 otherwise). After rotation the old bearer
 * secret must stop working immediately (authorize compares against the live
 * device row only). These behaviors were only covered at the pair-ops/watermark
 * layer (ux-review P1-3, d16-s3), never at the HTTP surface.
 *
 * 413-drain (cbbff1f5) moved the body-limit check ahead of routing entirely,
 * so an UNAUTHENTICATED oversize upload now resolves 413 — never 401 — and the
 * boundary semantics (exactly 8MB passes, 8MB+1 rejects) are untested.
 *
 * Run: node --test tests/unit/lan-sync/relay-revoke-413-acceptance.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { registerT } from '../../lib/relay-test-http.mjs'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const { memoryStore, createRelay, startRelayServer } = await import(pathToFileURL(path.join(ROOT, 'server/sync-relay.mjs')))

const MAX_BODY_BYTES = 8 * 1024 * 1024
// full-suite load flakes the first exchanges of a fresh relay as `fetch failed`
// (transport-level) — retried here, never HTTP statuses (see tests/lib/relay-test-http.mjs)
const post = async (base, url, body, secret) => {
  let last = null
  for (let i = 1; i <= 3; i++) {
    try {
      return await fetch(base + url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          connection: 'close',
          ...(secret ? { authorization: `Bearer ${secret}` } : {}),
        },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      })
    } catch (e) {
      last = e
      if (i < 3) await new Promise(r => setTimeout(r, 60 * i))
    }
  }
  throw last
}

const register = async (base, account, device, extra = {}) => registerT(post, base, account, device, extra)

/** A push body whose total wire length is exactly `total` bytes (ASCII envelope padding). */
const oversizeBody = total => {
  const envelopeOf = n => JSON.stringify({ account: 'acc', device: 'dev', items: [{ opId: 'op-size', envelope: 'x'.repeat(n) }] })
  const base = Buffer.byteLength(envelopeOf(0))
  return envelopeOf(total - base)
}

test('acceptance: proven re-register rotates the secret and the old secret is revoked immediately (HTTP layer)', async () => {
  const relay = createRelay(memoryStore())
  const server = await startRelayServer(relay, { port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const first = await register(base, 'acc', 'dev')
    assert.equal(first.status, 200)
    const secret1 = first.secret
    assert.ok(secret1, 'first registration mints a bearer secret')

    const pushOk = await post(base, '/v1/sync/push', { account: 'acc', device: first.device, items: [{ opId: 'op-1', envelope: '{"v":1}' }] }, secret1)
    assert.equal(pushOk.status, 200, 'the freshly minted secret authorizes push')

    // Rotation guard: re-register without proof must NOT mint a new secret (409).
    // fallback409:false — this test ASSERTS the 409; the flake-fallback may not eat it.
    const hostile = await register(base, 'acc', 'dev', { fallback409: false })
    assert.equal(hostile.status, 409, 're-register without proof is rejected')
    assert.equal(hostile.secret, undefined, 'no secret leaks on a rejected re-register')

    // Proven rotation: present the current secret, get a fresh one.
    const second = await register(base, 'acc', 'dev', { deviceSecret: secret1 })
    assert.equal(second.status, 200)
    const secret2 = second.secret
    assert.ok(secret2 && secret2 !== secret1, 'proven re-register rotates to a NEW secret')

    // THE revocation contract: the old secret stops working the moment the row rotates.
    const oldPush = await post(base, '/v1/sync/push', { account: 'acc', device: first.device, items: [{ opId: 'op-2', envelope: '{"v":2}' }] }, secret1)
    assert.equal(oldPush.status, 401, 'the pre-rotation secret is revoked (401), not silently accepted')
    const newPush = await post(base, '/v1/sync/push', { account: 'acc', device: first.device, items: [{ opId: 'op-3', envelope: '{"v":3}' }] }, secret2)
    assert.equal(newPush.status, 200, 'the rotated secret authorizes push')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('acceptance: an unauthenticated oversize upload resolves 413 (body-limit check precedes auth), server stays healthy', async () => {
  const relay = createRelay(memoryStore())
  const server = await startRelayServer(relay, { port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    // No Authorization header at all: if auth ran first this would be 401.
    const res = await post(base, '/v1/sync/push', oversizeBody(MAX_BODY_BYTES + 1))
    assert.equal(res.status, 413, 'oversize upload gets 413 even with zero credentials')
    assert.equal((await res.json()).error, 'request body too large')

    // The keep-alive connection pool survives the drain: a normal authorized push still works.
    const reg = await register(base, 'acc', 'dev')
    const ok = await post(base, '/v1/sync/push', { account: 'acc', device: reg.device, items: [{ opId: 'op-ok', envelope: '{"v":1}' }] }, reg.secret)
    assert.equal(ok.status, 200, 'data route works over the same pooled connection after a 413')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})

test('acceptance: 8MB body boundary — exactly the cap passes, one byte over is 413', async () => {
  const relay = createRelay(memoryStore())
  const server = await startRelayServer(relay, { port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${server.address().port}`
  try {
    const reg = await register(base, 'acc', 'dev')

    const atCap = await post(base, '/v1/sync/push', oversizeBody(MAX_BODY_BYTES), reg.secret)
    assert.equal(atCap.status, 200, 'a body of EXACTLY the cap is accepted (limit is strictly >)')
    assert.ok((await atCap.json()).acked, 'the at-cap push was durably acked')

    const overCap = await post(base, '/v1/sync/push', oversizeBody(MAX_BODY_BYTES + 1), reg.secret)
    assert.equal(overCap.status, 413, 'one byte over the cap is rejected with a readable 413')

    // The at-cap envelope was stored, not lost to the later 413. (maxBytes must
    // exceed the single 8MB envelope or the D26 oversize guard reports `skipped`.)
    const pull = await post(base, '/v1/sync/pull', { account: 'acc', afterSeq: 0, maxBytes: 16 * 1024 * 1024 }, reg.secret)
    assert.equal(pull.status, 200)
    const pulled = await pull.json()
    assert.equal(pulled.items.length, 1, 'the at-cap envelope is pullable after the boundary check')
  } finally {
    await new Promise(resolve => server.close(resolve))
  }
})
