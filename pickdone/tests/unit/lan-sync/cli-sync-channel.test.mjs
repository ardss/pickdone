/**
 * CLI sync command channel tests (feat/cli-sync-pair):
 *  - unit: createSyncCmdHandler dispatch/receipt/seq-dedup/error semantics with a fake registry;
 *  - two-node end-to-end: a `pair` command flowed through the channel on node A, answered by a
 *    `pair-respond` command through the channel on node B (real TCP, injected discovery), after
 *    which a normal authenticated sync round succeeds — the full scripted pairing path.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createSyncCmdHandler } = require('../../../src/main/cli-sync-channel.js')
const { createLanSyncNode } = require('../../../src/main/lan-sync/index.js')

const SECRET = 'cli-sync-channel-secret'

function fakeDiscovery () {
  return { startAdvertising() {}, discover() {}, stop() {}, getPeers: () => [] }
}

function makeNode (extra = {}) {
  return createLanSyncNode({
    deviceId: 'node-x',
    name: 'Node X',
    pairingSecret: SECRET,
    port: 0,
    host: '127.0.0.1',
    discoverFn: fakeDiscovery(),
    ingestSegment: () => {},
    ingestSnapshot: () => {},
    buildSegments: () => [],
    ...extra,
  })
}

/** Fake db-sync-ops registry: captures receipts in place of the meta table. */
function fakeChannel (handlers) {
  const receipts = []
  const dispatchLog = []
  const ch = createSyncCmdHandler({
    dispatch: (op, p) => {
      dispatchLog.push([op, p])
      const fn = handlers[op]
      if (!fn) throw new Error('unavailable: ' + op)
      return fn(p)
    },
    setMeta: (k, v) => { assert.equal(k, 'cliSyncState'); receipts.push(JSON.parse(v)) },
    log: { warn: () => {} },
  })
  return { ch, receipts, dispatchLog }
}

test('channel: status dispatches syncGetStatus and writes an ok receipt with the command seq', async () => {
  const { ch, receipts, dispatchLog } = fakeChannel({ syncGetStatus: () => ({ enabled: true, peers: [] }) })
  ch.forward(JSON.stringify({ seq: 7, action: 'status' }))
  await new Promise(r => setTimeout(r, 20))
  assert.equal(receipts.length, 1)
  assert.equal(receipts[0].seq, 7)
  assert.equal(receipts[0].ok, true)
  assert.equal(receipts[0].status.enabled, true)
  assert.deepEqual(dispatchLog, [['syncGetStatus', undefined]])
})

test('channel: seq dedup drops stale/replayed commands', async () => {
  const { ch, receipts, dispatchLog } = fakeChannel({ syncGetStatus: () => ({}) })
  ch.forward(JSON.stringify({ seq: 3, action: 'status' }))
  ch.forward(JSON.stringify({ seq: 3, action: 'status' })) // replay
  ch.forward(JSON.stringify({ seq: 2, action: 'status' })) // stale
  ch.forward('not json') // garbage never throws
  ch.forward(null)
  await new Promise(r => setTimeout(r, 20))
  assert.equal(dispatchLog.length, 1)
  assert.equal(receipts.length, 1)
})

test('channel: unknown action and thrown op errors answer ok:false without throwing', async () => {
  const { ch, receipts } = fakeChannel({ syncGetStatus: () => { throw new Error('sync is not enabled') } })
  ch.forward(JSON.stringify({ seq: 1, action: 'wat' }))
  ch.forward(JSON.stringify({ seq: 2, action: 'status' }))
  await new Promise(r => setTimeout(r, 20))
  assert.equal(receipts[0].ok, false)
  assert.match(receipts[0].error, /unknown cliSyncCmd action: wat/)
  assert.equal(receipts[1].seq, 2)
  assert.equal(receipts[1].ok, false)
  assert.match(receipts[1].error, /sync is not enabled/)
})

test('channel: pair-respond with a pending request mirrors the renderer contract (syncPairRespond accept)', async () => {
  const responds = []
  const { ch, receipts, dispatchLog } = fakeChannel({
    syncGetStatus: () => ({ pendingPair: { deviceId: 'p1', host: '10.0.0.9' } }),
    syncPairRespond: p => { responds.push(p); return { ok: true, accept: p.accept } },
  })
  ch.forward(JSON.stringify({ seq: 4, action: 'pair-respond' })) // no --code, accept defaults true
  await new Promise(r => setTimeout(r, 20))
  assert.deepEqual(responds, [{ accept: true }])
  assert.equal(receipts[0].ok, true)
  assert.equal(dispatchLog[0][0], 'syncGetStatus', 'pending check comes from the same status registry')
  // explicit --code is IGNORED when a pending request exists (the dialog path wins, as in the UI)
  ch.forward(JSON.stringify({ seq: 5, action: 'pair-respond', code: '123456' }))
  await new Promise(r => setTimeout(r, 20))
  assert.equal(responds.length, 2)
  assert.equal(receipts[1].ok, true)
})

test('channel: pair-respond fallback to the manual 6-digit code flow when nothing is pending', async () => {
  const { ch, receipts } = fakeChannel({
    syncGetStatus: () => ({ pendingPair: null }),
    syncPairWithCode: async p => ({ peer: { deviceId: 'peer-a' }, secret: 's2', codeUsed: p.code }),
  })
  ch.forward(JSON.stringify({ seq: 1, action: 'pair-respond', code: '654321' }))
  ch.forward(JSON.stringify({ seq: 2, action: 'pair-respond' })) // neither pending nor code → usage error
  await new Promise(r => setTimeout(r, 30))
  const bySeq = Object.fromEntries(receipts.map(r => [r.seq, r]))
  assert.equal(bySeq[1].ok, true)
  assert.equal(bySeq[1].result.codeUsed, '654321')
  assert.equal(bySeq[2].ok, false)
  assert.match(bySeq[2].error, /no pending pair request/)
})

test('channel: unpair passes deviceId through and surfaces failures', async () => {
  const { ch, receipts } = fakeChannel({
    syncUnpairPeer: p => { if (!p.deviceId) throw new Error('deviceId is required'); return { removed: p.deviceId } },
  })
  ch.forward(JSON.stringify({ seq: 1, action: 'unpair', deviceId: 'dead-beef' }))
  ch.forward(JSON.stringify({ seq: 2, action: 'unpair' }))
  await new Promise(r => setTimeout(r, 20))
  assert.equal(receipts[0].ok, true)
  assert.equal(receipts[0].result.removed, 'dead-beef')
  assert.equal(receipts[1].ok, false)
  assert.match(receipts[1].error, /deviceId is required/)
})

test('channel e2e: pair command on node A + pair-respond command on node B complete a real pairing', async () => {
  // Node B (responder): the channel's pendingPair is fed by the transport's pair-request event —
  // exactly what pendingPairPayload() surfaces in the bootstrap.
  let pendingB = null
  const serverNode = makeNode({ deviceId: 'responder', name: 'Responder' })
  serverNode.on('pair-request', info => { pendingB = { deviceId: info.deviceId, host: info.host, respond: info.respond } })
  serverNode.start()
  const serverPort = await serverNode.whenListening()

  const mkRegistry = node => ({
    syncGetStatus: () => ({ pendingPair: pendingB && typeof pendingB.respond === 'function' ? { deviceId: pendingB.deviceId, host: pendingB.host } : null }),
    syncPairRequest: p => node.requestPair(p.host, p.port),
    syncPairRespond: p => {
      const info = pendingB
      pendingB = null
      if (!info || typeof info.respond !== 'function') return { ok: false, error: 'no pending pair request' }
      info.respond(p.accept !== false)
      return { ok: true, accept: p.accept !== false }
    },
  })
  const mkChannel = (node) => {
    const receipts = new Map()
    const ch = createSyncCmdHandler({
      dispatch: (op, p) => mkRegistry(node)[op](p),
      setMeta: (k, v) => { const r = JSON.parse(v); receipts.set(r.seq, r) },
      log: { warn: () => {} },
    })
    return { ch, receipts }
  }

  const clientNode = makeNode({ deviceId: 'initiator', name: 'Initiator' })
  clientNode.start()
  const client = mkChannel(clientNode)
  const server = mkChannel(serverNode)

  // 1) initiator CLI: sync pair --host ... (receipt arrives only once the peer confirmed)
  client.ch.forward(JSON.stringify({ seq: 1, action: 'pair', host: '127.0.0.1', port: serverPort }))
  // 2) responder CLI: wait for the pending request to surface, then sync pair-respond
  for (let i = 0; i < 500 && !pendingB; i++) await new Promise(r => setTimeout(r, 30))
  assert.ok(pendingB, 'pair request surfaced as pending on the responder')
  server.ch.forward(JSON.stringify({ seq: 1, action: 'pair-respond' }))

  // 3) initiator's receipt: ok, secret adopted (same pairing secret on both sides)
  for (let i = 0; i < 500 && !client.receipts.has(1); i++) await new Promise(r => setTimeout(r, 30))
  const ack = client.receipts.get(1)
  assert.ok(ack, 'initiator got its pair receipt')
  assert.equal(ack.ok, true, 'pair receipt ok: ' + (ack && ack.error))
  assert.equal(ack.status.host, '127.0.0.1')
  // responder also answered its own command
  for (let i = 0; i < 300 && !server.receipts.has(1); i++) await new Promise(r => setTimeout(r, 30))
  assert.equal(server.receipts.get(1).ok, true)

  // 4) post-pairing: a normal authenticated round succeeds with the adopted secret
  clientNode.addPeer({ deviceId: 'responder', host: '127.0.0.1', port: serverPort, name: 'Responder' })
  const round = await clientNode.startSyncRound()
  assert.equal(round.confirmed, 1, 'post-pairing round authenticates')

  await clientNode.stop()
  await serverNode.stop()
})
