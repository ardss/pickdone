/**
 * [S4 extension RED→GREEN] deliver() — the service-worker delivery function must attach the
 * X-PickDone-Key handshake header (read from chrome.storage.local, where the settings flow
 * stores the key the user pasted) on every POST to the configured endpoint.
 *
 * fetch is stubbed; no chrome.* dependency (deps injected).
 *
 * Run: node --test tests/unit/renderer/extension/deliver.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { createDeliver, KEY_HEADER, DEFAULT_DELIVER_ENDPOINT } from '../../../../extension/shared/deliver.js'
import { DEFAULT_CAPTURE_ENDPOINT } from '../../../../extension/shared/endpoint-contract.js'

function stubFetch (capture) {
  return async (url, init) => {
    capture.push({ url, init })
    return { ok: true, status: 201 }
  }
}

test('deliver: default endpoint is the desktop contract URL', () => {
  assert.equal(DEFAULT_DELIVER_ENDPOINT, 'http://127.0.0.1:7789/capture')
  assert.equal(DEFAULT_DELIVER_ENDPOINT, DEFAULT_CAPTURE_ENDPOINT)
})

test('deliver: posts JSON to the endpoint with the X-PickDone-Key header from storage', async () => {
  const calls = []
  const deliver = createDeliver({
    getEndpoint: async () => 'http://127.0.0.1:7789/capture',
    getKey: async () => 'secret-48-hex',
    fetchImpl: stubFetch(calls)
  })
  await deliver({ content: 'hello' })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://127.0.0.1:7789/capture')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers[KEY_HEADER], 'secret-48-hex')
  assert.deepEqual(JSON.parse(calls[0].init.body), { content: 'hello' })
})

test('deliver: no key stored → request still goes out WITHOUT the handshake header', async () => {
  const calls = []
  const deliver = createDeliver({
    getEndpoint: async () => DEFAULT_DELIVER_ENDPOINT,
    getKey: async () => '',
    fetchImpl: stubFetch(calls)
  })
  await deliver({ content: 'x' })
  assert.ok(!(KEY_HEADER in calls[0].init.headers))
})

test('deliver: non-ok response throws (queue records the failure and backs off)', async () => {
  const deliver = createDeliver({
    getEndpoint: async () => DEFAULT_DELIVER_ENDPOINT,
    getKey: async () => 'k',
    fetchImpl: async () => ({ ok: false, status: 503 })
  })
  await assert.rejects(() => deliver({ content: 'x' }), /HTTP 503/)
})
