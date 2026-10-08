/**
 * D26 — snapshot coversSeq unbounded → account history wipe.
 *
 * /v1/snapshot/put accepted any integer coversSeq; gc() deletes every envelope at or below
 * a snapshot's coversSeq, so a buggy or hostile device posting coversSeq: 2**53 could wipe
 * the account's ENTIRE envelope history (every other device loses its replay tail). The
 * route now rejects coversSeq > relay.store.lastSeq() or negative with 400: a snapshot can
 * only ever cover envelopes the relay has already issued.
 *
 * Run: node --test tests/unit/lan-sync/d26-snapshot-coversseq-cap.test.mjs
 */
import http from 'node:http'
// node:http with agent:false instead of global fetch: undici's keep-alive pool holds sockets
// open after server.close, so --test-force-exit murders the process mid-teardown and libuv
// asserts on a closing async handle (win/async.c:76, 0xC0000409, suite-only crash). agent:false
// drains every connection per request; the process exits cleanly.
const httpJson = (url, { method = 'POST', headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const req = http.request(url, { method, headers: { 'content-type': 'application/json', ...headers }, agent: false }, res => {
    let data = ''
    res.setEncoding('utf8')
    res.on('data', c => { data += c })
    res.on('end', () => resolve({ status: res.statusCode, json: () => JSON.parse(data) }))
  })
  req.on('error', reject)
  req.end(body ? JSON.stringify(body) : undefined)
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const { memoryStore, createRelay, startRelayServer } = await import(pathToFileURL(path.join(ROOT, 'server/sync-relay.mjs')))

// port 0 direct (relay-auth pattern): a pre-picked freePort can be stolen by an outgoing
// fetch connection between close and rebind under suite concurrency → EADDRINUSE crash
test('snapshot/put rejects coversSeq beyond relay history (and negative), keeps a valid one', async () => {
  const port = 0
  const store = memoryStore()
  const relay = createRelay(store)
  const server = await startRelayServer(relay, { port, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    // register a device to obtain the bearer secret (all data routes demand it)
    const reg = await httpJson(url + '/v1/device/register', { body: { account: 'acc-d26-cap', device: 'dev-1' } }).then(r => r.json())
    const secret = reg.device.deviceSecret
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${secret}` }
    const putSnapshot = snapshot => httpJson(url + '/v1/snapshot/put', { headers: auth, body: { account: 'acc-d26-cap', snapshot } })

    store.appendEnvelope('acc-d26-cap', 'op-1', '{}')
    store.appendEnvelope('acc-d26-cap', 'op-2', '{}')
    const lastSeq = store.lastSeq()
    assert.equal(lastSeq, 2)

    // the attack: a huge coversSeq used to be accepted and gc() would then delete EVERYTHING
    for (const coversSeq of [2 ** 53, lastSeq + 1, -1]) {
      const res = await putSnapshot({ generation: 1, coversSeq })
      assert.equal(res.status, 400, `coversSeq ${coversSeq} must be rejected with 400`)
      const body = await res.json()
      assert.match(body.error, /coversSeq/)
    }
    assert.equal(store.latestSnapshot('acc-d26-cap'), null, 'no poisoned snapshot was stored')
    assert.equal(store.getSince('acc-d26-cap', 0, 100).length, 2, 'envelope history untouched')

    // a legitimate coversSeq (at or below issued history) still lands, and gc keeps working
    const ok = await putSnapshot({ generation: 1, coversSeq: 1 })
    assert.equal(ok.status, 200)
    const snap = store.latestSnapshot('acc-d26-cap')
    assert.equal(snap.coversSeq, 1)
  } finally {
    await new Promise(r => server.close(r))
  }
})
