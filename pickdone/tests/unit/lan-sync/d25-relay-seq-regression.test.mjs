/* maint/d25 drill-2 regression — relay torn-state seq reset used to cause SILENT LOSS:
 * the relay rebooting from a torn state file restarts serverSeq at 1 while a client's durable
 * cursor sits above the new head. The old client (a) suppressed re-push (its pushed-set says
 * everything is acked on a relay that lost those frames) and (b) pulled nothing (cursor above
 * the re-issued seqs) — fresh writes could never reach peers. Fix, three parts:
 *   1. relay pull response carries headSeq (the live max serverSeq);
 *   2. client round() detects headSeq < cursor → resets cursor+pushed-set, next round re-pushes
 *      and re-pulls from 0 (replays are duplicates/ignored; LWW convergence safe);
 *   3. client post() re-registers once on 401 (registry died with the old store) and register()
 *      resets the stale sync state.
 * Run: node --test tests/unit/lan-sync/d25-relay-seq-regression.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import net from 'node:net'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const { fileStore, createRelay, startRelayServer } = await import(pathToFileURL(path.join(ROOT, 'server/sync-relay.mjs')))
const { createRelayClient } = await import(pathToFileURL(path.join(ROOT, 'shared/sync-transport/https/relay-client.mjs')))
const { materialized } = await import(pathToFileURL(path.join(ROOT, 'shared/sync-core/causality/merge.mjs')))
// client.materialized() returns payloadHashes; assertions want payloads
const payloadOf = (client, id) => (materialized(client.store, id).current || {}).payload

// fixed port across restarts (like the drill harness): clients keep their baseUrl while the
// relay reboots — that is exactly the production shape
const relayPort = await new Promise((resolve, reject) => {
  const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)) }); s.on('error', reject)
})
async function startRelay (dataDir) {
  const store = fileStore(dataDir)
  const relay = createRelay(store)
  const server = await startRelayServer(relay, { port: relayPort, host: '127.0.0.1' })
  return { server, url: `http://127.0.0.1:${relayPort}`, store }
}

test('d25 relay torn-state reset: fresh writes still converge after the relay loses its store', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'd25-relay-regression-'))
  let relay
  try {
    relay = await startRelay(dataDir)
    const a = createRelayClient({ nodeId: 'dev-a', account: 'acc-d25', baseUrl: relay.url, store: undefined })
    const b = createRelayClient({ nodeId: 'dev-b', account: 'acc-d25', baseUrl: relay.url, store: undefined })
    await a.register()
    await b.register()
    await a.commit('ta-pre', { title: 'pre-torn' })
    await a.round()
    await b.round()
    assert.equal(payloadOf(b, 'ta-pre') && payloadOf(b, 'ta-pre').title, 'pre-torn')

    // --- torn-state reboot: corrupt the relay state file, restart the relay fresh ---
    await new Promise(r => relay.server.close(r))
    if (relay.server.closeAllConnections) relay.server.closeAllConnections()
    const stateFile = path.join(dataDir, 'relay-state.json')
    fs.writeFileSync(stateFile, fs.readFileSync(stateFile, 'utf8').slice(0, 500)) // torn JSON
    relay = await startRelay(dataDir) // quarantines the torn file, seq restarts at 1

    // pre-fix, this is where writes died: client cursor=1..2, pushed-set full, relay seq=0
    await new Promise(r => setTimeout(r, 150)) // let the old listener's socket fully release the port
    await a.commit('ta-post', { title: 'post-torn fresh write' })
    // rounds tolerate the reboot window's transient conn errors (same retry shape as the drill harness)
    let lastErr = null
    for (let i = 0; i < 6; i++) {
      try { await a.round(); await b.round(); lastErr = null } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 200)) }
    }
    if (lastErr) throw lastErr

    assert.equal(payloadOf(a, 'ta-post') && payloadOf(a, 'ta-post').title, 'post-torn fresh write', 'A holds its own write')
    assert.equal(payloadOf(b, 'ta-post') && payloadOf(b, 'ta-post').title, 'post-torn fresh write',
      'B received the post-torn write (no silent loss across the relay seq reset)')
    assert.equal(payloadOf(b, 'ta-pre') && payloadOf(b, 'ta-pre').title, 'pre-torn', 'pre-torn state also re-converged')
  } finally {
    try { if (relay) await new Promise(r => relay.server.close(r)) } catch {}
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('d25 source pins: relay pull carries headSeq; client resets state on head-below-cursor and re-registers on 401', () => {
  const fs2 = fs
  const relaySrc = fs2.readFileSync(path.join(ROOT, 'server/sync-relay.mjs'), 'utf8')
  assert.match(relaySrc, /headSeq: store\.lastSeq\(\)/, 'both pull return points must carry headSeq')
  const clientSrc = fs2.readFileSync(path.join(ROOT, 'shared/sync-transport/https/relay-client.mjs'), 'utf8')
  assert.match(clientSrc, /pull\.headSeq < cursorState\.cursor/, 'round() must detect the seq regression')
  assert.match(clientSrc, /cursorState\.pushed\.clear\(\)/, 'stale pushed-set must be cleared (re-push guarantee)')
  assert.match(clientSrc, /res\.status === 401 && !retried/, 'post() must re-auth once on 401 (registry died with the store)')
})
