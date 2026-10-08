/**
 * D26 — relay pull oversized-envelope deadlock.
 *
 * Push accepts envelopes up to the 8MB body cap, but pull's default byte budget was 4MB
 * and a SINGLE envelope larger than the whole budget used to stop the page at its own seq
 * with items empty: toSeq stayed at the cursor while headSeq sat above it, so every pull
 * below that envelope deadlocked forever (the D25 headSeq<cursor reset never fires — the
 * relay is healthy, one frame is just undeliverable).
 *
 * Fix: relay.pull reports oversize singles as `skipped: [{serverSeq}]` (same quarantine
 * semantics as a corrupt frame, spec §68 — the client can never receive them), and
 * relay-client round() advances its cursor past skipped seqs and acks them. The client
 * also pins maxBytes explicitly (8MB, the relay's push body cap) so behavior no longer
 * rides an implicit server default.
 *
 * Run: node --test tests/unit/lan-sync/d26-relay-pull-oversize.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import path from 'node:path'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const { memoryStore, createRelay, startRelayServer } = await import(pathToFileURL(path.join(ROOT, 'server/sync-relay.mjs')))
const { createRelayClient } = await import(pathToFileURL(path.join(ROOT, 'shared/sync-transport/https/relay-client.mjs')))
const { materialized } = await import(pathToFileURL(path.join(ROOT, 'shared/sync-core/causality/merge.mjs')))
const payloadOf = (client, id) => (materialized(client.store, id).current || {}).payload


test('relay.pull reports a single oversize envelope as skipped instead of deadlocking the page', async () => {
  const store = memoryStore()
  const relay = createRelay(store)
  const BIG = 'x'.repeat(5 * 1024 * 1024)
  const bigSeq = store.appendEnvelope('acc', 'op-big', JSON.stringify({ v: 1, blob: BIG })).serverSeq
  const smallSeq = store.appendEnvelope('acc', 'op-small', JSON.stringify({ v: 1 })).serverSeq

  // a small maxBytes cannot carry the 5MB frame: it must be REPORTED, not dropped silently,
  // and the small envelope after it must still be delivered in the same response
  const r = relay.pull('acc', 0, 64 * 1024)
  assert.deepEqual(r.skipped.map(s => s.serverSeq), [bigSeq], 'oversize single is reported with its serverSeq')
  assert.ok(r.items.some(i => i.serverSeq === smallSeq), 'later small envelopes still arrive')
  assert.equal(r.toSeq, smallSeq, 'toSeq reaches the tail past the skip')

  // default budget (no maxBytes): the 5MB frame still exceeds 4MB — same skip, not a deadlock
  const r2 = relay.pull('acc', 0, null)
  assert.deepEqual(r2.skipped.map(s => s.serverSeq), [bigSeq])
})

test('client round() advances past a relay-skipped oversize envelope; later envelopes still converge', async () => {
  const port = 0 // port 0 direct: freePort can race outgoing fetch connections under suite concurrency
  const store = memoryStore()
  const relay = createRelay(store)
  const server = await startRelayServer(relay, { port, host: '127.0.0.1' })
  const url = `http://127.0.0.1:${server.address().port}`
  try {
    const a = createRelayClient({ nodeId: 'dev-a', account: 'acc-d26-big', baseUrl: url })
    const b = createRelayClient({ nodeId: 'dev-b', account: 'acc-d26-big', baseUrl: url })
    await a.register()
    await b.register()

    // plant the poison directly in the store (push's 8MB cap is what let it in production)
    store.appendEnvelope('acc-d26-big', 'op-big', JSON.stringify({ blob: 'x'.repeat(5 * 1024 * 1024) }))

    // B pushes a fresh SMALL envelope that lands AFTER the oversize one (seq 2)
    await b.commit('tb-1', { title: 'after-the-giant' })
    await b.round()

    // A's first round: without the fix, pull stopped at the giant with items empty and
    // toSeq=cursor → B's write stayed invisible forever
    const r1 = await a.round()
    assert.equal(r1.quarantined, 1, 'the skipped oversize frame is counted as quarantined (spec §68)')
    assert.equal(payloadOf(a, 'tb-1') && payloadOf(a, 'tb-1').title, 'after-the-giant',
      'A received the envelope BEHIND the oversize one (no pull deadlock)')

    // the cursor advanced PAST the skipped seq: the next round does not re-skip or re-ack it
    const r2 = await a.round()
    assert.equal(r2.quarantined, 0, 'cursor moved past the skip — no repeated quarantine')
    assert.ok(r2.cursor >= 2, `cursor advanced past the skipped seq (got ${r2.cursor})`)

    // and the ack reached the relay: the oversize seq must not pin the GC floor
    const dev = store.getDevice('acc-d26-big', 'dev-a')
    assert.ok(dev.lastAck >= 2, 'A acked past the skipped frame')
  } finally {
    await new Promise(r => server.close(r))
  }
})

test('source pins: client pins pull maxBytes and advances past pull.skipped', () => {
  const clientSrc = fs.readFileSync(path.join(ROOT, 'shared/sync-transport/https/relay-client.mjs'), 'utf8')
  assert.match(clientSrc, /maxBytes: PULL_MAX_BYTES/, 'round() must send an explicit maxBytes')
  assert.match(clientSrc, /for \(const sk of pull\.skipped \|\| \[\]\)/, 'round() must advance past skipped frames')
  const relaySrc = fs.readFileSync(path.join(ROOT, 'server/sync-relay.mjs'), 'utf8')
  assert.match(relaySrc, /size > maxBytes\)\s*\{\s*skipped\.push/, 'pull must report oversize singles as skipped')
})
