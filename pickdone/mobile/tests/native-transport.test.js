import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBridgeFetch } from '../src/sync/native-transport.js'

test('native transport sends exact JSON + scoped auth headers without browser Origin or redirects', async () => {
  let received
  const request = createBridgeFetch({
    isNative: () => true,
    nativeRequest: async options => {
      received = options
      return { status: 200, data: { ok: true, result: { entities: { todos: [] } } } }
    },
    webFetch: () => { throw new Error('browser fetch must not run on Android') }
  })
  const result = await request('http://127.0.0.1:4702/crossplatform/pull', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-only', 'X-PickDone-Request': 'nonce-test-only' },
    body: JSON.stringify({ deviceId: 'qa-android', messageId: 'qa-001', payload: {} })
  })
  assert.equal(received.url, 'http://127.0.0.1:4702/crossplatform/pull')
  assert.equal(received.method, 'POST')
  assert.deepEqual(received.data, { deviceId: 'qa-android', messageId: 'qa-001', payload: {} })
  assert.equal(received.headers.Authorization, 'Bearer test-only')
  assert.equal(received.headers['X-PickDone-Request'], 'nonce-test-only')
  assert.equal(Object.hasOwn(received.headers, 'Origin'), false)
  assert.equal(received.disableRedirects, true)
  assert.equal(result.status, 200)
  assert.deepEqual((await result.json()).result.entities.todos, [])
})

test('native 403 stays a rejected HTTP response for bridge auth errors', async () => {
  const request = createBridgeFetch({
    isNative: () => true,
    nativeRequest: async () => ({ status: 403, data: '{"ok":false,"error":"csrf_rejected"}' })
  })
  const response = await request('https://localhost/crossplatform/pull', { method: 'POST', body: '{}' })
  assert.equal(response.ok, false)
  assert.equal(response.status, 403)
  assert.equal((await response.json()).error, 'csrf_rejected')
})

test('web PWA keeps real browser fetch and its CORS policy', async () => {
  let hit = false
  const request = createBridgeFetch({
    isNative: () => false,
    nativeRequest: () => { throw new Error('native must not run in web PWA') },
    webFetch: async (url, init) => {
      hit = true
      assert.equal(url, 'http://127.0.0.1:18796/crossplatform/pair')
      assert.equal(init.method, 'POST')
      return { ok: true, status: 200, json: async () => ({ ok: true }) }
    }
  })
  const result = await request('http://127.0.0.1:18796/crossplatform/pair', { method: 'POST', body: '{}' })
  assert.equal(hit, true)
  assert.equal(result.ok, true)
})
