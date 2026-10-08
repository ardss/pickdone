/**
 * D26 — GC floor parity between the relay storage backends.
 *
 * memoryStore got the snapshot-less ACK-ALONE margin fix (GC floor fix, 2026-10-06) but
 * sqliteStore still computed the cut inline and returned 0 when no snapshot existed —
 * self-hosted sqlite relays accumulated envelopes forever. The cut is now ONE shared pure
 * helper (gcCutFloor in server/sync-relay.mjs) used by BOTH backends, and this test pins
 * that they GC the same window in every regime.
 *
 * Run: node --test tests/unit/lan-sync/d26-relay-gc-parity.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const ROOT = path.resolve(import.meta.dirname, '../../..')
const require = createRequire(import.meta.url)
const { memoryStore, gcCutFloor, GC_ACK_ALONE_MARGIN } = await import(pathToFileURL(path.join(ROOT, 'server/sync-relay.mjs')))
const { sqliteStore } = await import(pathToFileURL(path.join(ROOT, 'server/sync-relay-sqlite.mjs')))

// better-sqlite3 is an Electron-ABI module; the app ships a plain-node-loadable vendor copy —
// injected via sqliteStore's { Database } seam so this suite runs under plain `node --test`.
let Database = null
try { Database = require(path.join(ROOT, 'vendor/better-sqlite3-multiple-ciphers')) } catch { /* unavailable: sqlite cases below self-skip */ }

const ACC = 'acc-d26-gc'
const seed = store => {
  for (let i = 1; i <= 5; i++) store.appendEnvelope(ACC, `op-${i}`, JSON.stringify({ i }))
  return store
}
const survivors = store => store.getSince(ACC, 0, 100000).length
// mirror the relay flow: register creates the device row, THEN the ack patch lands —
// sqliteStore's upsert applies patch fields on the conflict-update branch, exactly like
// relay.ack does in production
const ackDevice = (store, ack) => {
  store.upsertDevice(ACC, 'dev-1', {})
  store.upsertDevice(ACC, 'dev-1', { lastAck: ack })
}

test('shared gcCutFloor: all regimes produce the documented cut', () => {
  // snapshot-less ACK-ALONE: margin below the ack floor
  assert.equal(gcCutFloor({ ackFloor: 300000, coversSeq: 0 }), 200000)
  // ack below the margin: nothing removable (replay window intact)
  assert.equal(gcCutFloor({ ackFloor: 50000, coversSeq: 0 }), 0)
  // snapshot caps the floor even when the ack is far ahead
  assert.equal(gcCutFloor({ ackFloor: 300000, coversSeq: 7 }), 7)
  // no acks, no snapshot
  assert.equal(gcCutFloor({ ackFloor: 0, coversSeq: 0 }), 0)
  // the exported margin is the constant both backends ride
  assert.equal(gcCutFloor({ ackFloor: GC_ACK_ALONE_MARGIN + 10, coversSeq: 0 }), 10)
})

// Fresh seq space per case: seqs 1..5 in BOTH backends, so counts compare apples-to-apples.
const CASES = [
  { name: 'ack-alone beyond the margin (no snapshot)', ack: 300000, snapshot: null, survivors: 0 },
  { name: 'ack within the margin (no snapshot)', ack: 50000, snapshot: null, survivors: 5 },
  { name: 'snapshot caps the ack floor', ack: 300000, snapshot: { generation: 1, coversSeq: 2 }, survivors: 3 },
  { name: 'no acks at all', ack: 0, snapshot: null, survivors: 5 },
]

test('memory and sqlite backends GC the same window in every regime', { skip: !Database && 'better-sqlite3 vendor module unavailable' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd26-gc-parity-'))
  try {
    for (const c of CASES) {
      const mem = seed(memoryStore())
      const sq = seed(sqliteStore(path.join(dir, `case-${CASES.indexOf(c)}.db`), { Database }))
      try {
        ackDevice(mem, c.ack)
        ackDevice(sq, c.ack)
        if (c.snapshot) { mem.putSnapshot(ACC, c.snapshot); sq.putSnapshot(ACC, c.snapshot) }
        const memRemoved = mem.gc(ACC)
        const sqRemoved = sq.gc(ACC)
        assert.equal(memRemoved, sqRemoved, `${c.name}: both backends remove the same count`)
        assert.equal(survivors(mem), survivors(sq), `${c.name}: identical survivor sets`)
        assert.equal(survivors(sq), c.survivors, `${c.name}: survivors match the expected cut`)
      } finally {
        sq.close()
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('sqlite gcFloor/gc no longer return 0 forever without a snapshot (the divergence itself)', { skip: !Database && 'better-sqlite3 vendor module unavailable' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd26-gc-sqlite-alone-'))
  const sq = seed(sqliteStore(path.join(dir, 'relay.db'), { Database }))
  try {
    ackDevice(sq, 300000)
    assert.equal(sq.gcFloor(ACC), 300000)
    assert.equal(sq.gc(ACC), 5, 'sqlite GC now removes acked envelopes beyond the margin even snapshot-less')
    assert.equal(survivors(sq), 0)
  } finally {
    sq.close()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
