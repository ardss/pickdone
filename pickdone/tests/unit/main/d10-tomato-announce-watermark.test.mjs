/** D10 (2026-09-27): tomato-announce watermark must survive an in-place DB rebuild. The module
 *  cache watermark is monotonic; after a rebuild the oplog seq space restarts LOW, so the paged
 *  scan read 0 rows forever and tomato chips went blind until process restart. A zero-row scan
 *  with a live watermark now probes the seq space, detects the shrink, resets the cache and
 *  rescans from seq 0.
 * Run: node --test tests/unit/main/d10-tomato-announce-watermark.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ta = require('../../../src/main/tomato-announce.js')

function oplogDb (rows, store) {
  return (op, p) => {
    if (op === 'syncOplogSince') {
      return rows.filter(r => r.seq > (p.sinceSeq || 0)).slice(0, p.limit || rows.length)
    }
    if (op === 'getMeta') return store[p] ?? null
    return null
  }
}

test('d10: listAnnounces re-discovers announces after an oplog seq-space reset (rebuilt DB)', () => {
  ta.__reset()
  // Phase 1 — old oplog: seq space runs high, watermark advances to 100.
  const oldRows = [{ seq: 100, entity: 'meta', entityId: ta.keyFor('dev-old'), ts: 900 }]
  const oldStore = { [ta.keyFor('dev-old')]: JSON.stringify({ deviceId: 'dev-old', deviceName: 'Old', status: 'idle', startedAt: 0, plannedSec: 0, at: 1 }) }
  ta.init({ dbCall: oplogDb(oldRows, oldStore) })
  assert.equal(ta.listAnnounces().length, 1)

  // Phase 2 — in-place DB rebuild: brand-new oplog whose seqs restart at 1. The stale watermark
  // (100) sat above every new seq: without the reset branch the scan reads 0 rows forever and the
  // NEW running announce on dev-new is invisible.
  const newRows = [
    { seq: 1, entity: 'meta', entityId: 'todosVersion', ts: 1 },
    { seq: 2, entity: 'meta', entityId: ta.keyFor('dev-new'), ts: 2 },
  ]
  const newStore = { [ta.keyFor('dev-new')]: JSON.stringify({ deviceId: 'dev-new', deviceName: 'New', status: 'running', startedAt: Date.now(), plannedSec: 1500, at: Date.now() }) }
  ta.init({ dbCall: oplogDb(newRows, newStore) })
  // The reset probe deliberately waits for TWO consecutive zero-row scans so the healthy idle
  // path keeps its single-0-row-scan-per-poll cost (d5-4 watermark-cache guarantee): the first
  // post-rebuild poll is still blind, the second detects the shrink and rescans.
  assert.equal(ta.listAnnounces().length, 0, 'first poll after the rebuild: still blind (probe deferred)')
  const list = ta.listAnnounces()
  assert.equal(list.length, 1, 'announce visible again after the reset+rescan (red before the fix: [] forever)')
  assert.equal(list[0].deviceId, 'dev-new')
  // and the rebuilt cache tracks the new space: the next idle poll neither loses it nor loops
  const again = ta.listAnnounces()
  assert.equal(again.length, 1)
  assert.equal(again[0].deviceId, 'dev-new')
  ta.__reset()
})

test('d10: a normal idle poll (no new rows, watermark row still retained) does NOT reset the cache', () => {
  ta.__reset()
  const rows = [{ seq: 50, entity: 'meta', entityId: ta.keyFor('dev-a'), ts: 5 }]
  const store = { [ta.keyFor('dev-a')]: JSON.stringify({ deviceId: 'dev-a', deviceName: 'A', status: 'idle', startedAt: 0, plannedSec: 0, at: 1 }) }
  const dbCall = oplogDb(rows, store)
  let probeFoundRow = false
  ta.init({ dbCall: (op, p) => {
    const r = dbCall(op, p)
    if (op === 'syncOplogSince' && p.sinceSeq === 49) probeFoundRow = (r || []).length > 0
    return r
  } })
  assert.equal(ta.listAnnounces().length, 1)
  assert.equal(ta.listAnnounces().length, 1, 'second poll still lists (cache intact, no reset)')
  assert.equal(ta.listAnnounces().length, 1, 'third poll (probe deferred to the 2nd consecutive zero-row scan) still lists')
  assert.ok(probeFoundRow, 'when the reset probe fires on idle polls it finds the watermark row — no reset')
  ta.__reset()
})
