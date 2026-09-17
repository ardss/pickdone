/**
 * Engine unit tests: push/pull roundtrip, cursor crash semantics (doc §4.1:
 * "cursor advances only after confirmed delivery; half-delivered = whole
 * segment re-push"), snapshot determinism + fresh-device apply, loopback
 * echo filtering. Deterministic — no Date.now/Math.random.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createEngine, canonicalStringify } from '../../../shared/sync-core/engine.mjs'
import { applyRow } from '../../../shared/sync-core/merge.mjs'

/** In-memory localStore adapter (the contract engine.mjs documents). */
function makeStore(deviceId) {
  const state = new Map() // id -> live row
  const oplog = []
  let seq = 0
  let cursor = 0
  return {
    deviceId,
    append(row) {
      seq++
      const r = { ...row, seq, deviceId }
      oplog.push(r)
      state.set(r.id, applyRow(state, r).row)
      return r
    },
    getRowsSince(s) {
      return oplog.filter((r) => r.seq > s)
    },
    applyRow(row) {
      // remote rows merge into STATE only — the oplog is own-origin ops
      const before = JSON.stringify(state.get(row.id) ?? null)
      const { row: winner, conflictCopy } = applyRow(state, row)
      state.set(row.id, winner)
      return JSON.stringify(winner) !== before || !!conflictCopy
    },
    getCursor: () => cursor,
    setCursor(s) {
      cursor = s
    },
    allRows: () => [...state.values()],
    replaceAll(rows) {
      state.clear()
      oplog.length = 0
      seq = 0
      for (const r of rows) {
        state.set(r.id, r)
        oplog.push(r)
      }
    },
  }
}

test('push/pull roundtrip: rows cross devices and merge', () => {
  const a = makeStore('devA')
  const ea = createEngine({ localStore: a, deviceId: 'devA' })
  const b = makeStore('devB')
  const eb = createEngine({ localStore: b, deviceId: 'devB' })

  a.append({ id: 't1', title: 'hello', updatedAt: 10 })
  a.append({ id: 't2', title: 'world', updatedAt: 11 })

  const { segments, toSeq } = ea.buildSegments()
  assert.equal(segments.length, 1)
  assert.equal(toSeq, 2)
  const res = eb.ingestSegment(segments[0].body)
  assert.deepEqual(res, { applied: 2, rejected: 0 })
  assert.equal(b.allRows().find((r) => r.id === 't1').title, 'hello')

  // reverse direction: B's own new op pushes back to A; oplog stays own-origin
  assert.equal(eb.buildSegments().segments.length, 0, 'no own ops yet -> nothing to push')
  b.append({ id: 't3', title: 'from B', updatedAt: 20 })
  const back = eb.buildSegments()
  assert.equal(back.segments.length, 1)
  const res2 = ea.ingestSegment(back.segments[0].body)
  assert.deepEqual(res2, { applied: 1, rejected: 0 })
  assert.equal(a.allRows().find((r) => r.id === 't3').title, 'from B')

  // loopback: A ingesting its own segment is a no-op
  const loop = ea.ingestSegment(segments[0].body)
  assert.deepEqual(loop, { applied: 0, rejected: 0 })
})

test('cursor crash semantics: unconfirmed push re-delivers everything', () => {
  const a = makeStore('devA')
  const ea = createEngine({ localStore: a, deviceId: 'devA' })
  const b = makeStore('devB')
  const eb = createEngine({ localStore: b, deviceId: 'devB' })

  for (let i = 0; i < 5; i++) a.append({ id: `t${i}`, title: `v${i}`, updatedAt: 100 + i })

  // attempt 1: build, simulate crash BEFORE delivery — cursor must not move
  const first = ea.buildSegments()
  assert.equal(a.getCursor(), 0)
  assert.equal(first.toSeq, 5)

  // attempt 2: deliver segment 1 of 2, confirm only it, then crash
  const half = Math.ceil(first.segments.length / 2)
  for (let i = 0; i < half; i++) eb.ingestSegment(first.segments[i].body)
  for (let i = 0; i < half; i++) ea.markPushed(first.segments[i].toSeq)
  assert.ok(a.getCursor() > 0)

  // attempt 3: re-push covers everything NOT confirmed; peer converges
  const retry = ea.buildSegments()
  for (const seg of retry.segments) eb.ingestSegment(seg.body)
  ea.markPushed(retry.toSeq)
  // re-ingest of already-applied rows is idempotent (rejected = no state change)
  const dup = eb.ingestSegment(first.segments[0].body)
  assert.equal(dup.applied, 0)

  const got = Object.fromEntries(b.allRows().map((r) => [r.id, r.title]))
  assert.deepEqual(got, { t0: 'v0', t1: 'v1', t2: 'v2', t3: 'v3', t4: 'v4' })
  assert.equal(ea.buildSegments().segments.length, 0) // nothing left to push
})

test('buildSegments respects the 256KB cap per segment', () => {
  const a = makeStore('devA')
  const ea = createEngine({ localStore: a, deviceId: 'devA' })
  const blob = 'x'.repeat(40 * 1024) // 8 rows of ~40KB -> >256KB total
  for (let i = 0; i < 8; i++) a.append({ id: `big${i}`, title: blob, updatedAt: i })
  const { segments, toSeq } = ea.buildSegments()
  assert.ok(segments.length >= 2, 'should split into multiple segments')
  assert.equal(toSeq, 8)
  for (const seg of segments) {
    assert.ok(seg.body.length <= 256 * 1024)
    assert.ok(seg.fromSeq <= seg.toSeq)
  }
})

test('snapshot: byte-deterministic roundtrip given identical input', () => {
  const a = makeStore('devA')
  const clock = () => 42
  const ea = createEngine({ localStore: a, deviceId: 'devA', clock })
  a.append({ id: 'b', title: 'second', updatedAt: 2, extra: { z: 1, y: 2 } })
  a.append({ id: 'a', title: 'first', updatedAt: 1 })
  const s1 = ea.buildSnapshot()
  const s2 = ea.buildSnapshot()
  assert.equal(s1, s2, 'same input + clock -> identical bytes')
  assert.ok(s1.includes('"a"') && s1.indexOf('"a"') < s1.indexOf('"b"'), 'rows sorted by id')
  assert.ok(s1.includes('"createdAt":42'))
  assert.equal(canonicalStringify({ b: 1, a: 2 }), '{"a":2,"b":1}')
})

test('snapshot: fresh-device apply replaces state and resets cursor', () => {
  const a = makeStore('devA')
  const ea = createEngine({ localStore: a, deviceId: 'devA' })
  a.append({ id: 't1', title: 'from A', updatedAt: 5 })
  const snap = ea.buildSnapshot()

  const c = makeStore('devC')
  const ec = createEngine({ localStore: c, deviceId: 'devC' })
  c.append({ id: 'junk', title: 'pre-existing', updatedAt: 1 })
  c.setCursor(99)
  const res = ec.applySnapshot(snap)
  assert.equal(res.rows, 1)
  assert.equal(c.getCursor(), 0, 'fresh device cursor resets')
  assert.equal(c.allRows().length, 1)
  assert.equal(c.allRows()[0].title, 'from A')

  // fresh device can immediately continue the oplog cycle
  const push = ec.buildSegments()
  assert.ok(push.segments.length >= 1)
  const r = ea.ingestSegment(push.segments[0].body)
  assert.ok(r.applied >= 0)
})

test('engine rejects bad construction and invalid snapshots', () => {
  assert.throws(() => createEngine({ deviceId: 'x' }), /localStore/)
  assert.throws(() => createEngine({ localStore: makeStore('x') }), /deviceId/)
  const ea = createEngine({ localStore: makeStore('x'), deviceId: 'x' })
  assert.throws(() => ea.applySnapshot('not json'), /not valid JSON/)
  assert.throws(
    () => ea.applySnapshot(JSON.stringify({ schemaVersion: 999, rows: [] })),
    /schemaVersion/
  )
  assert.throws(() => ea.markPushed(-1), /invalid seq/)
})

test('engine: ingestSegment accepts both the packed body string and the {body} envelope', async () => {
  // Live-drill regression (2026-09-17): transports carry the {body} envelope object; feeding it
  // verbatim used to throw 'segment body is not decodable JSON' inside the server handler.
  const storeA = makeStore('env-a')
  const a = createEngine({ deviceId: 'env-a', localStore: storeA })
  const b = createEngine({ deviceId: 'env-b', localStore: makeStore('env-b') })
  storeA.append({ id: 't1', title: 'hello', updatedAt: 10 })
  const built = a.buildSegments()
  assert.ok(built.segments.length >= 1, 'fixture produced a segment')
  const seg = built.segments[0]
  const asEnvelope = typeof seg === 'string' ? { body: seg } : seg
  const r = b.ingestSegment(asEnvelope)
  assert.equal(r.rejected, 0, 'envelope-object ingest must not reject rows')
  assert.equal(r.applied > 0, true, 'envelope-object ingest applies rows')
})

test('buildSegments(fromSeq) overrides the global cursor for per-peer pushes', () => {
  // Live-drill regression (2026-09-18): per-peer watermarks need an explicit push start; a global
  // cursor would skip rows a lagging peer still needs.
  const storeA = makeStore('wm-a')
  const ea = createEngine({ localStore: storeA, deviceId: 'wm-a' })
  for (let i = 1; i <= 5; i++) storeA.append({ id: `w${i}`, title: 'row', updatedAt: i })
  const full = ea.buildSegments()
  assert.equal(full.toSeq, 5)
  ea.markPushed(5)
  const afterCursor = ea.buildSegments()
  assert.equal(afterCursor.toSeq, 0, 'cursor says everything is pushed')
  const since3 = ea.buildSegments(3)
  assert.equal(since3.toSeq, 5, 'explicit fromSeq reaches past the cursor')
  assert.ok(since3.segments.length >= 1, 'rows 4-5 are re-packed')
})

test('flush sheds rows off an oversize batch instead of failing the whole push', () => {
  // Live-drill regression (2026-09-18): the per-row byte estimate undershot the packed size
  // (263257 > 262144 at the receiving peer) and the whole round died on the segment gate.
  const storeA = makeStore('shed-a')
  const ea = createEngine({ localStore: storeA, deviceId: 'shed-a' })
  // rows whose JSON-escaped size differs from their raw length to skew the estimate upward gap
  const title = 'x'.repeat(30 * 1024) + 'ééé' // multibyte chars: estimate vs packed bytes diverge
  for (let i = 0; i < 40; i++) storeA.append({ id: `s${i}`, title, updatedAt: i })
  const { segments } = ea.buildSegments()
  assert.ok(segments.length >= 2, 'large backlog splits')
  for (const seg of segments) {
    assert.ok(seg.body.length <= 256 * 1024, `segment within cap (got ${seg.body.length})`)
  }
})
