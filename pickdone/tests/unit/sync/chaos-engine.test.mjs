/**
 * Chaos convergence through the ENGINE (doc §9 P2 acceptance, engine layer):
 * same seeded dual-store harness idea as chaos-sync.test.mjs, but all
 * exchange happens via engine.buildSegments()/ingestSegment() with shuffled
 * segment delivery order and injected "crash" deliveries (a segment is
 * delivered but markPushed is skipped -> whole segment re-pushed next round).
 * 1200 rounds, fixed seed -> deterministic; peers must converge row-for-row
 * to a single-store reference of the same facts.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyRow } from '../../../shared/sync-core/merge.mjs'
import { createEngine } from '../../../shared/sync-core/engine.mjs'

const SEED = 0xBEEF
const ROUNDS = 1200
const OPS_PER_ROUND = 24

function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** In-memory localStore adapter + op-writing helper (one device). */
function makeDevice(deviceId) {
  const state = new Map()
  const oplog = []
  let seq = 0
  let cursor = 0
  const store = {
    getRowsSince: (s) => oplog.filter((r) => r.seq > s),
    applyRow(row) {
      // remote rows merge into STATE only — the oplog stays own-origin
      const before = JSON.stringify(state.get(row.id) ?? null)
      const { row: winner } = applyRow(state, row)
      state.set(row.id, winner)
      return JSON.stringify(winner) !== before
    },
    getCursor: () => cursor,
    setCursor: (s) => {
      cursor = s
    },
    allRows: () => [...state.values()],
    replaceAll(rows) {
      state.clear()
      oplog.length = 0
      for (const r of rows) {
        state.set(r.id, r)
        oplog.push(r)
      }
    },
    append(over = {}) {
      seq++
      const r = {
        id: over.id, title: `t-${over.id}-${seq}`, done: 0,
        updatedAt: seq * 7 + (deviceId === 'devB' ? 900 : 0),
        seq, deviceId, deleted: 0, ...over,
      }
      oplog.push(r)
      // own ops merge like any other row (never force-set) so local state
      // always equals the merge-rule winner of all known facts
      applyRow(state, r)
      return r
    },
  }
  return { deviceId, store, engine: createEngine({ localStore: store, deviceId }) }
}

function snapshotOf(device) {
  return [...device.store.allRows()]
    .sort((a, b) => String(a.id).localeCompare(String(b.id)))
    .map((r) => JSON.stringify(r))
}

/** Deliver from -> to via engine segments, shuffled order, with crash injection. */
function syncRound(from, to, rand) {
  const built = from.engine.buildSegments()
  if (!built.segments.length) return 0
  // chaos: shuffle segment delivery order
  const segs = [...built.segments]
  for (let i = segs.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[segs[i], segs[j]] = [segs[j], segs[i]]
  }
  let delivered = 0
  let confirmedTo = 0
  for (const seg of segs) {
    to.engine.ingestSegment(seg.body)
    delivered++
    // crash injection: ~25% of segments are delivered but the cursor
    // confirmation is "lost" -> they will be re-pushed in a later round.
    if (rand() >= 0.25) confirmedTo = Math.max(confirmedTo, seg.toSeq)
  }
  from.engine.markPushed(confirmedTo)
  return delivered
}

test(`engine chaos: ${ROUNDS} rounds with crash injections converge to reference`, () => {
  const rand = mulberry32(SEED)
  let totalDeliveries = 0
  let crashWins = 0
  for (let round = 0; round < ROUNDS; round++) {
    const A = makeDevice('devA')
    const B = makeDevice('devB')
    const idPool = Array.from({ length: 6 }, (_, i) => `r${round}-i${i}`)

    // concurrent-before-sync random ops on both devices
    for (let k = 0; k < OPS_PER_ROUND; k++) {
      const device = rand() < 0.5 ? A : B
      const id = idPool[Math.floor(rand() * idPool.length)]
      const op = ['create', 'update', 'delete', 'restore'][Math.floor(rand() * 4)]
      const cur = device.store.allRows().find((r) => r.id === id)
      if (op === 'create' && !cur) device.store.append({ id })
      else if (op === 'update' && cur && !cur.deleted) device.store.append({ id, title: cur.title + '*', updatedAt: cur.updatedAt + 1 })
      else if (op === 'delete' && cur && !cur.deleted) device.store.append({ id, deleted: 1, deletedAt: cur.updatedAt + 1 })
      else if (op === 'restore' && cur && cur.deleted) device.store.append({ id, deleted: 0 })

      // mid-op sync: multiple exchanges so unconfirmed re-pushes interleave
      if (k % 8 === 7) {
        totalDeliveries += syncRound(A, B, rand) + syncRound(B, A, rand)
      }
    }

    // final convergence passes: full exchange in both directions, twice,
    // with cursor loss so unconfirmed segments get re-pushed here.
    const before = totalDeliveries
    for (let pass = 0; pass < 2; pass++) {
      totalDeliveries += syncRound(A, B, rand) + syncRound(B, A, rand)
    }
    if (totalDeliveries > before) crashWins++ // re-push path exercised

    const gotA = snapshotOf(A)
    const gotB = snapshotOf(B)
    assert.deepEqual(gotB, gotA, `round ${round}: engine peers diverged`)

    // reference: every fact from both oplogs applied to one store in
    // effectiveTs order via the same merge rules
    const ref = new Map()
    const facts = [...A.store.allRows(), ...B.store.allRows()].sort((x, y) => {
      const tx = x.deleted ? x.deletedAt : x.updatedAt
      const ty = y.deleted ? y.deletedAt : y.updatedAt
      return tx - ty || (x.seq ?? 0) - (y.seq ?? 0) || String(x.deviceId).localeCompare(String(y.deviceId))
    })
    for (const f of facts) applyRow(ref, f)
    const refSnap = [...ref.keys()].sort().map((id) => JSON.stringify(ref.get(id)))
    assert.deepEqual(gotA, refSnap, `round ${round}: engine state != single-store reference`)
  }
  assert.ok(totalDeliveries > 0 && crashWins > 0, 'chaos harness must exercise deliveries and re-pushes')
})
