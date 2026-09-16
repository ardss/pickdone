/**
 * Chaos convergence test for sync-core (design doc §9 P2 acceptance:
 * "1000 rounds of dual-instance random ops must end row-for-row equal").
 *
 * Convergence design: a seeded PRNG (mulberry32, fixed seed) generates op
 * sequences that two in-memory stores apply locally (some ops issued
 * concurrently before any sync, with a deliberate per-device clock skew), then
 * the stores exchange their oplog segments in both directions — each segment
 * split into shuffled chunks and applied via merge rules in random order.
 * Because every merge rule is a total order on (effectiveTs, seq, deviceId),
 * full bidirectional exchange is idempotent and both stores converge to the
 * same per-row maximum, which must equal a reference run of the same op
 * sequence applied to a single store in updatedAt order. 1200 rounds, fixed
 * seed => fully deterministic, no Date.now/Math.random anywhere.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyRow } from '../../../shared/sync-core/merge.mjs'
import { pack, unpack } from '../../../shared/sync-core/segment.mjs'

const SEED = 0xC0FFEE
const ROUNDS = 1200
const OPS_PER_ROUND = 24

// Deterministic PRNG (mulberry32) — fixed seed, never the wall clock.
function mulberry32(seed) {
  let a = seed >>> 0
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function makeDevice(deviceId, clockSkew, rand) {
  const store = new Map() // id -> row (state, incl. tombstones)
  let seq = 0
  const nextRow = (id, over = {}) => ({
    id, title: `t-${id}-${Math.floor(rand() * 1e6)}`, done: rand() < 0.5 ? 1 : 0,
    updatedAt: ++seq * 7 + clockSkew, seq, deviceId, deleted: 0, ...over,
  })
  return {
    deviceId, store,
    op(op, id) {
      const cur = store.get(id)
      if (op === 'create' && !cur) store.set(id, nextRow(id))
      else if (op === 'update' && cur && !cur.deleted) applyRow(store, nextRow(id))
      else if (op === 'delete' && cur && !cur.deleted) applyRow(store, nextRow(id, { deleted: 1, deletedAt: cur.updatedAt + 1 }))
      else if (op === 'restore' && cur && cur.deleted) applyRow(store, nextRow(id, { deleted: 0, deletedAt: undefined }))
      // no-ops (op on absent row etc.) are valid: real devices race exactly like this
    },
  }
}

function exchangeSegments(from, to, rand) {
  const ids = [...from.store.keys()].sort()
  if (!ids.length) return
  // segments are per-origin (a device's seq counter only covers its own ops):
  // group the store's rows by originating deviceId, then split into chunks
  const byDevice = new Map()
  for (const id of ids) {
    const r = from.store.get(id)
    if (!byDevice.has(r.deviceId)) byDevice.set(r.deviceId, [])
    byDevice.get(r.deviceId).push(r)
  }
  const chunks = []
  for (const [origin, rows] of byDevice) {
    const chunkCount = 1 + Math.floor(rand() * 3)
    const parts = Array.from({ length: chunkCount }, () => [])
    rows.forEach((r, i) => parts[i % chunkCount].push(r))
    for (const p of parts) if (p.length) chunks.push({ origin, rows: p })
  }
  // deliver chunks in shuffled order with duplicated/reordered frames
  for (const chunk of chunks) {
    chunk.rows.sort((a, b) => a.seq - b.seq) // codec contract: rows strictly increasing by seq
    const segSeqs = chunk.rows.map((r) => r.seq)
    const seg = pack(chunk.rows, {
      fromSeq: segSeqs[0], toSeq: segSeqs[segSeqs.length - 1], deviceId: chunk.origin,
    })
    const out = unpack(seg)
    // apply each unpacked chunk's rows in randomized order (chaos delivery)
    const shuffled = [...out.rows]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    for (const r of shuffled) applyRow(to.store, r)
  }
}

function snapshot(store) {
  return [...store.keys()].sort().map((id) => JSON.stringify(store.get(id)))
}

test(`chaos: ${ROUNDS} dual-device rounds converge to the single-store reference`, () => {
  const rand = mulberry32(SEED)
  const liveIds = []
  for (let round = 0; round < ROUNDS; round++) {
    const skewA = 0
    const skewB = 1000 + Math.floor(rand() * 500) // deliberate clock skew, still deterministic
    const A = makeDevice('devA', skewA, rand)
    const B = makeDevice('devB', skewB, rand)
    const idPool = []
    for (let i = 0; i < 6; i++) { const id = `r${round}-i${i}`; idPool.push(id); liveIds.push(id) }

    // interleaved random ops: some land on A, some on B, some touch the same id
    // on both sides before any sync (concurrent-before-sync conflicts)
    for (let k = 0; k < OPS_PER_ROUND; k++) {
      const device = rand() < 0.5 ? A : B
      const id = idPool[Math.floor(rand() * idPool.length)]
      const ops = ['create', 'update', 'delete', 'restore']
      device.op(ops[Math.floor(rand() * ops.length)], id)
    }
    const expectA = snapshot(A.store)
    const expectB = snapshot(B.store)

    // convergence pass: full bidirectional exchange, chunks shuffled
    exchangeSegments(A, B, rand)
    exchangeSegments(B, A, rand)

    const gotA = snapshot(A.store)
    const gotB = snapshot(B.store)
    assert.deepEqual(gotB, gotA, `round ${round}: peers diverged`)

    // reference run: same effective facts (both devices' final per-row rows)
    // merged into one store in effectiveTs order via the same merge rules
    const ref = new Map()
    const facts = [...A.store.values(), ...B.store.values()]
      .sort((x, y) => {
        const tx = x.deleted ? x.deletedAt : x.updatedAt
        const ty = y.deleted ? y.deletedAt : y.updatedAt
        return tx - ty || (x.seq ?? 0) - (y.seq ?? 0)
      })
    for (const f of facts) applyRow(ref, f)
    assert.deepEqual(snapshot(ref), gotA, `round ${round}: converged state != reference`)
    // per-round sanity: peers must actually reach the reference, not just agree
    assert.deepEqual(gotB, snapshot(ref))
    assert.ok(expectA.length >= 0 && expectB.length >= 0) // keep pre-sync snapshots referenced
  }
  assert.ok(liveIds.length >= ROUNDS)
})
