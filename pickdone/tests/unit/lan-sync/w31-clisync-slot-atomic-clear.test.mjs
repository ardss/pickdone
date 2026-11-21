/**
 * W31 P2 regression: the handled-slot clear in cli-sync-channel was fire-and-forget
 * (`Promise.resolve(handle(cmd)).finally(() => { clearHandledSlot(cmd) })`) — the async
 * deleteMeta was never awaited, so if the app exited between the receipt write and the
 * delete landing, the slot survived the run and the next startup's slot seed REPLAYED an
 * already-executed command (an unpair replay re-rotates the pairing secret — not idempotent).
 *
 * Contract under test (user-visible: replay prevention):
 *  1. after `forward` resolves for a handled command, the slot is ALREADY cleared
 *     synchronously (awaited delete), so an exit right after the receipt cannot replay it;
 *  2. the compare-and-delete guard keeps the failure-path semantics: a slot that no longer
 *     holds the handled seq (a newer command took over) is never eaten;
 *  3. a clearing failure is logged, not thrown, and the receipt is still delivered.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createSyncCmdHandler } = require('../../../src/main/cli-sync-channel.js')

/** Meta table fake whose deleteMeta persists asynchronously (like a real write-through). */
function metaBackedHandler ({ deleteDelayMs = 5, failDelete = false } = {}) {
  const meta = new Map()
  const receipts = []
  const warnings = []
  const ch = createSyncCmdHandler({
    dispatch: (op) => {
      if (op === 'syncGetStatus') return { enabled: true, peers: [] }
      if (op === 'syncUnpairPeer') return { ok: true }
      throw new Error('unavailable: ' + op)
    },
    setMeta: (k, v) => { meta.set(k, v) },
    getMeta: (k) => meta.get(k) ?? null,
    deleteMeta: async (k) => {
      await new Promise(r => setTimeout(r, deleteDelayMs))
      if (failDelete) throw new Error('disk gone')
      meta.delete(k)
    },
    log: { warn: (...a) => warnings.push(a.join(' ')) },
  })
  return {
    ch, receipts: () => receipts, warnings,
    slot: () => meta.get('cliSyncCmd') ?? null,
    put: (k, v) => meta.set(k, v),
  }
}

test('forward resolves only after the handled slot is cleared (no exit-replay window)', async () => {
  const h = metaBackedHandler()
  h.put('cliSyncSeq', '10')
  const raw = JSON.stringify({ seq: 11, at: Date.now(), action: 'unpair', deviceId: 'd1' })
  h.put('cliSyncCmd', raw) // simulate the CLI having written the slot before the poll tick
  await h.ch.forward(raw)
  // Synchronous-after-await assertion: the delete has LANDED by the time the command is done.
  assert.equal(h.slot(), null, 'cliSyncCmd slot must be cleared before forward resolves')
})

test('compare-and-delete still protects a newer command on a stale cleanup (failure path)', async () => {
  const h = metaBackedHandler()
  h.put('cliSyncSeq', '10')
  const newer = JSON.stringify({ seq: 12, at: Date.now(), action: 'status' })
  // A newer command lands in the slot BEFORE the handled one's cleanup reads it.
  const p = h.ch.forward(JSON.stringify({ seq: 11, at: Date.now(), action: 'unpair', deviceId: 'd1' }))
  h.put('cliSyncCmd', newer)
  await p
  assert.equal(h.slot(), newer, 'a newer command in the slot must never be eaten by an older cleanup')
})

test('a clearing failure is logged and must not lose the receipt', async () => {
  const h = metaBackedHandler({ failDelete: true })
  h.put('cliSyncSeq', '10')
  const raw = JSON.stringify({ seq: 13, at: Date.now(), action: 'unpair', deviceId: 'd1' })
  h.put('cliSyncCmd', raw)
  await h.ch.forward(raw)
  assert.ok(h.slot(), 'slot survives when the delete itself fails (replay recovery intact)')
  assert.ok(h.warnings.some(w => w.includes('sync slot cleanup failed')), 'cleanup failure is warned')
})
