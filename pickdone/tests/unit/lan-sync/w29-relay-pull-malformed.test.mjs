/* W29 (P2) — relay-client pull.items missing must not wedge sync.
 *
 * A relay answering 200 with a malformed pull body (no `items` field) used to make
 * round() throw TypeError on the first `pull.items` access; durable hosts classify a
 * shapeless throw as RETRYABLE, so every retry of the round burned and — the relay
 * answering the same way forever — sync idled permanently.
 *
 * Fix: tolerate the missing field like `skipped` (`pull.items || []`) and report the
 * anomaly as a `malformedPull` diagnostic count on the round result.
 *
 * Run: node --test tests/unit/lan-sync/w29-relay-pull-malformed.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const { createRelayClient } = await import(pathToFileURL(path.join(ROOT, 'shared/sync-transport/https/relay-client.mjs')))

function fakeFetch (pullBody) {
  return async (url) => {
    const p = String(url)
    const json = p.endsWith('/v1/sync/pull')
      ? pullBody
      : (p.endsWith('/v1/sync/ack') ? {} : {})
    return { ok: true, status: 200, json: async () => json }
  }
}

test('w29: a 200 pull without `items` resolves with pulled:0 + malformedPull:1 instead of throwing', async () => {
  const c = createRelayClient({
    nodeId: 'dev-w29-a', account: 'acc-w29', baseUrl: 'http://relay.test',
    deviceSecret: 'preset-secret', fetchImpl: fakeFetch({ headSeq: 0, skipped: [] }),
  })
  // Red before the fix: round() threw TypeError ("Cannot read properties of undefined
  // (reading 'length')") — a shapeless throw the durable host classifies RETRYABLE.
  const r = await c.round()
  assert.equal(r.pulled, 0, 'missing items are tolerated as an empty page')
  assert.equal(r.malformedPull, 1, 'the malformed body is surfaced as a diagnostic count')
  assert.equal(r.quarantined, 0)
})

test('w29: a healthy pull body reports malformedPull:0 (no behavior change)', async () => {
  const c = createRelayClient({
    nodeId: 'dev-w29-b', account: 'acc-w29', baseUrl: 'http://relay.test',
    deviceSecret: 'preset-secret',
    fetchImpl: fakeFetch({ headSeq: 1, items: [], skipped: [] }),
  })
  const r = await c.round()
  assert.equal(r.pulled, 0)
  assert.equal(r.malformedPull, 0)
})
