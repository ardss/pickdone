/**
 * maint/d7 round — main-process fixes:
 *  - scheduler.js: notification title/body truncation by code points (astral characters must
 *    not be split into lone surrogates by a UTF-16 unit slice);
 *  - tomato-announce.js: listAnnounces evicts ids whose meta row disappeared (device unpaired)
 *    from the pointer cache — a dead id must not be polled forever.
 * Run: node --test tests/unit/main/d7-scheduler-announce-fixes.test.mjs
 */
import { createRequire } from 'module'
const require = createRequire(import.meta.url)
import { test } from 'node:test'
import assert from 'node:assert/strict'

const scheduler = require('../../../src/main/scheduler.js')
const ta = require('../../../src/main/tomato-announce.js')

test('scheduler: clipText truncates by code points — no lone surrogate at the cut', () => {
  const emoji = '😀' // U+1F600, 2 UTF-16 code units
  const s = emoji.repeat(70) // 70 code points, 140 UTF-16 units
  // A UTF-16 slice(0, 60) would cut mid-pair leaving a lone surrogate at index 59;
  // the code-point clip keeps 60 WHOLE emoji instead.
  const clipped = scheduler.clipText(s, 60)
  assert.equal(clipped, emoji.repeat(60), '60 whole code points survive')
  assert.equal(clipped.length, 120, 'every kept code point is intact (2 units each)')
  // Short strings pass through untouched
  assert.equal(scheduler.clipText('hello', 60), 'hello')
  assert.equal(scheduler.clipText(null, 60), '')
})

test('tomato-announce: listAnnounces drops cache ids whose meta row disappeared (unpaired device)', () => {
  ta.__reset()
  let metaCalls = 0
  const meta = new Map()
  const devA = 'tomatoRunAnnounce.dev-a'
  meta.set(devA, JSON.stringify({ deviceId: 'dev-a', deviceName: 'A', status: 'running', startedAt: Date.now() - 1000, plannedSec: 1500, at: Date.now() }))
  const dbCall = (op, p) => {
    if (op === 'syncOplogSince') {
      return p.sinceSeq === 0
        ? [{ entity: 'meta', entityId: devA, ts: 100, seq: 1 }]
        : []
    }
    if (op === 'getMeta') { metaCalls++; return meta.get(p) ?? null }
    throw new Error('unexpected op ' + op)
  }
  ta.init({ dbCall, getIdentity: () => ({ deviceId: 'local', deviceName: 'L' }) })

  const first = ta.listAnnounces()
  assert.equal(first.length, 1, 'the running announce is listed')
  assert.equal(metaCalls, 1)

  // Device unpaired: its announce row is deleted from meta. The next poll must return nothing
  // AND evict the dead id — a third poll must stop issuing getMeta for it entirely.
  meta.delete(devA)
  assert.equal(ta.listAnnounces().length, 0, 'dead entry is no longer listed')
  const callsAfterEviction = metaCalls
  assert.equal(ta.listAnnounces().length, 0)
  assert.equal(metaCalls, callsAfterEviction, 'no further getMeta for the dead id')
})
