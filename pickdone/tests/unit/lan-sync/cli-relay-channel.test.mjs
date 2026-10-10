/**
 * CLI relay channel tests (2026-10-11, journey-relay slice) — the relay transport becomes
 * drivable headlessly through the SAME cliSyncCmd channel the LAN-sync ops use:
 *   - relay-status  → relayGetStatus (status payload straight through)
 *   - relay-enable  → relaySetEnabled {enabled:true, account, baseUrl, rootKey?}
 *   - relay-disable → relaySetEnabled {enabled:false}
 *   - relay-sync    → relaySyncNow (async round result straight through)
 *   - relay-forget  → relayForget
 * Pins: rootKey ABSENT on the wire when not requested (the adapter generates one),
 * ok:false receipt when the op throws (relay not initialized / config invalid).
 * Run: node --test tests/unit/lan-sync/cli-relay-channel.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createSyncCmdHandler } = require('../../../src/main/cli-sync-channel.js')

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

const settle = () => new Promise(r => setTimeout(r, 20))

test('relay-status passes the adapter status straight through', async () => {
  const { ch, receipts, dispatchLog } = fakeChannel({ relayGetStatus: () => ({ enabled: false, cursor: 3 }) })
  ch.forward(JSON.stringify({ seq: 1, action: 'relay-status' }))
  await settle()
  assert.deepEqual(dispatchLog, [['relayGetStatus', undefined]])
  assert.equal(receipts[0].ok, true)
  assert.equal(receipts[0].status.cursor, 3)
})

test('relay-enable forwards account/baseUrl and OMITS an absent rootKey', async () => {
  const { ch, receipts, dispatchLog } = fakeChannel({
    relaySetEnabled: p => {
      assert.equal(p.enabled, true)
      return { enabled: true, account: p.account }
    },
  })
  ch.forward(JSON.stringify({ seq: 2, action: 'relay-enable', account: 'acc-1', baseUrl: 'http://192.168.31.68:58490' }))
  await settle()
  assert.equal(dispatchLog.length, 1)
  const [op, payload] = dispatchLog[0]
  assert.equal(op, 'relaySetEnabled')
  assert.equal(payload.account, 'acc-1')
  assert.equal(payload.baseUrl, 'http://192.168.31.68:58490')
  assert.equal('rootKey' in payload, false, 'absent rootKey must not arrive as null/"" — the adapter generates one')
  assert.equal(receipts[0].ok, true)
  assert.equal(receipts[0].result.account, 'acc-1')
})

test('relay-enable forwards a provided rootKey verbatim (shared-account pairing drill)', async () => {
  const seen = []
  const { ch, receipts } = fakeChannel({ relaySetEnabled: p => { seen.push(p); return { enabled: true } } })
  ch.forward(JSON.stringify({ seq: 3, action: 'relay-enable', account: 'acc-2', baseUrl: 'http://127.0.0.1:1', rootKey: 'a'.repeat(64) }))
  await settle()
  assert.equal(seen[0].rootKey, 'a'.repeat(64))
  assert.equal(receipts[0].ok, true)
})

test('relay-disable / relay-forget map to enabled:false and relayForget', async () => {
  const { ch, receipts, dispatchLog } = fakeChannel({
    relaySetEnabled: p => ({ enabled: p.enabled === true }),
    relayForget: () => ({ enabled: false, registered: false }),
  })
  ch.forward(JSON.stringify({ seq: 4, action: 'relay-disable' }))
  ch.forward(JSON.stringify({ seq: 5, action: 'relay-forget' }))
  await settle()
  assert.deepEqual(dispatchLog, [
    ['relaySetEnabled', { enabled: false }],
    ['relayForget', undefined],
  ])
  assert.equal(receipts[0].ok, true)
  assert.equal(receipts[1].ok, true)
  assert.equal(receipts[1].result.registered, false)
})

test('relay-sync returns the round envelope; a thrown op answers ok:false with the error', async () => {
  const { ch, receipts } = fakeChannel({
    relaySyncNow: async () => ({ ok: true, pushed: 3, pulled: 2, quarantined: 0, cursor: 9, businessApplied: 2 }),
  })
  ch.forward(JSON.stringify({ seq: 6, action: 'relay-sync' }))
  await settle()
  assert.equal(receipts[0].ok, true)
  assert.equal(receipts[0].result.pushed, 3)
  assert.equal(receipts[0].result.pulled, 2)
  assert.equal(receipts[0].result.quarantined, 0)

  const down = fakeChannel({ relaySyncNow: () => { throw new Error('relay op unavailable (relay sync not initialized)') } })
  down.ch.forward(JSON.stringify({ seq: 7, action: 'relay-sync' }))
  await settle()
  assert.equal(down.receipts[0].ok, false)
  assert.match(down.receipts[0].error, /not initialized/)
})
