/**
 * Behavior tests for src/main/tomato-session.js (TQ-1 durable running-tomato-session row).
 *
 * The module's contract: the main process keeps a durable 'tomatoRunningSession' meta row that
 * survives any renderer death mode. A running focus phase is always either recorded (booked as an
 * abandoned ledger record at startup reconcile) or explicitly given up (terminal transition /
 * quit teardown clear) — never silently dropped.
 *
 * All tests run against an in-memory dbm double through the injected `call` accessor, so no real
 * userData/db path is ever touched. No Electron imports are exercised (the module requires none).
 *
 * Run: node --test tests/unit/main/tomato-session-behavior.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createTomatoSession, sessionRowFromTransition, reconcileDecision, SESSION_KEY } =
  require('../../../src/main/tomato-session.js')

/** In-memory dbm double: meta map + ledger list + a call trail, mirroring dbm.call ops. */
function makeDb () {
  const meta = new Map()
  const tomatoes = []
  const calls = []
  const call = (op, p) => {
    calls.push([op, p])
    if (op === 'getMeta') return meta.has(p) ? meta.get(p) : null
    if (op === 'setMeta') { meta.set(p[0], p[1]); return true }
    if (op === 'deleteMeta') return meta.delete(p)
    if (op === 'getById') { const r = tomatoes.find(t => t.taskId === p); return r ? { ...r } : null }
    if (op === 'tomatoAppendMany') { tomatoes.push(...(Array.isArray(p) ? p : [p]).map(r => ({ ...r }))); return { accepted: 1, rejected: [] } }
    throw new Error('unexpected op ' + op)
  }
  return { call, calls, meta, tomatoes }
}

// Tracker tests anchor to the real clock (the module's default now() is Date.now()).
const NOW = Date.now()
// Fixed epoch for the pure reconcileDecision decision-table tests (now is passed explicitly).
const T0 = 1_700_000_000_000
const startPayload = over => ({
  transition: 'start',
  status: 'startTomatoTime',
  startedAt: over ?? NOW,
  attachTaskId: 42,
  tomatoTime: 25,
  restTime: 5
})

test('SESSION_KEY is the documented meta row key', () => {
  assert.equal(SESSION_KEY, 'tomatoRunningSession')
})

test('createTomatoSession requires a db call accessor', () => {
  assert.throws(() => createTomatoSession(), /requires a db call accessor/)
  assert.throws(() => createTomatoSession({ call: 'nope' }), /requires a db call accessor/)
})

test('set/get roundtrip: a start transition stores the row and hasRunningSession sees it', () => {
  const db = makeDb()
  const s = createTomatoSession({ call: db.call })
  assert.equal(s.applyTransition(startPayload()), true)
  const raw = db.meta.get(SESSION_KEY)
  assert.ok(typeof raw === 'string', 'row is stored as a JSON string in the meta table')
  const row = JSON.parse(raw)
  assert.equal(row.status, 'startTomatoTime')
  assert.equal(row.startedAt, NOW)
  assert.equal(row.attachTaskId, 42)
  assert.equal(row.tomatoTime, 25)
  assert.equal(row.restTime, 5)
  assert.equal(s.hasRunningSession(), true)
  // durability: a fresh tracker over the SAME db (simulating a restart) still sees the session
  const s2 = createTomatoSession({ call: db.call })
  assert.equal(s2.hasRunningSession(), true, 'running state survives process recreation')
})

test('rest-phase start is also a durable running session', () => {
  const db = makeDb()
  const s = createTomatoSession({ call: db.call })
  assert.equal(s.applyTransition({ transition: 'start', status: 'startRestTime', startedAt: NOW, restTime: 5 }), true)
  assert.equal(s.hasRunningSession(), true)
})

test('clear() removes the row so nothing survives into the next boot', () => {
  const db = makeDb()
  const s = createTomatoSession({ call: db.call })
  s.applyTransition(startPayload())
  assert.equal(s.hasRunningSession(), true)
  s.clear()
  assert.equal(db.meta.has(SESSION_KEY), false, 'quit teardown deleted the meta row')
  assert.equal(s.hasRunningSession(), false)
})

test('every terminal transition (complete | giveUp | finishRest | clear) clears a previously running row', () => {
  for (const transition of ['complete', 'giveUp', 'finishRest', 'clear']) {
    const db = makeDb()
    const s = createTomatoSession({ call: db.call })
    s.applyTransition(startPayload())
    assert.equal(s.applyTransition({ transition, status: 'default', startedAt: 0 }), true, transition + ' accepted')
    assert.equal(db.meta.has(SESSION_KEY), false, transition + ' removed the durable row')
    assert.equal(s.hasRunningSession(), false)
  }
})

test('forged or malformed payloads are refused without writing any row', () => {
  const db = makeDb()
  const s = createTomatoSession({ call: db.call })
  const bad = [
    null, undefined, 'start', 7,
    {}, { transition: 'unknown' },
    { transition: 'start', startedAt: 0 },                       // zero startedAt
    { transition: 'start', status: 'startTomatoTime', startedAt: NOW + 120_000 }, // >60s in the future
    { transition: 'start', status: 'idleFake', startedAt: NOW }  // non-running status
  ]
  for (const payload of bad) assert.equal(s.applyTransition(payload), false, JSON.stringify(payload))
  assert.equal(db.meta.size, 0, 'no durable row was written by any rejected payload')
  assert.equal(s.hasRunningSession(), false)
})

test('start transition clamps and normalizes its numeric fields', () => {
  const row = sessionRowFromTransition({ transition: 'start', status: 'startTomatoTime', startedAt: NOW, tomatoTime: 99_999, restTime: 0, attachTaskId: '' })
  assert.equal(row.tomatoTime, 600, 'tomatoTime clamped to the 600-minute ledger cap')
  assert.equal(row.restTime, 5, 'restTime falls back to 5 minutes')
  assert.equal(row.attachTaskId, null, 'empty attachTaskId normalized to null')
  const minRow = sessionRowFromTransition({ transition: 'start', status: 'startTomatoTime', startedAt: NOW, tomatoTime: 0 })
  assert.equal(minRow.tomatoTime, 25, 'tomatoTime 0 is treated as unset and falls back to 25 minutes')
  const nanRow = sessionRowFromTransition({ transition: 'start', status: 'startTomatoTime', startedAt: NOW, tomatoTime: 'garbage', restTime: 'nope' })
  assert.equal(nanRow.tomatoTime, 25, 'non-numeric tomatoTime falls back to 25 minutes')
  assert.equal(nanRow.restTime, 5, 'non-numeric restTime falls back to 5 minutes')
  const restRow = sessionRowFromTransition({ transition: 'start', status: 'startRestTime', startedAt: NOW })
  assert.equal(restRow.status, 'startRestTime', 'rest phase writes the same durable shape')
})

test('terminal transition produces an idle clear-row, not a running one', () => {
  const row = sessionRowFromTransition({ transition: 'giveUp', status: 'default', startedAt: 0 })
  assert.deepEqual(row, { status: 'default', startedAt: 0, at: row.at })
  assert.notEqual(sessionRowFromTransition({ transition: 'start', status: 'startTomatoTime', startedAt: NOW }).startedAt, 0)
})

test('reconcileDecision: no row or idle row → none', () => {
  assert.deepEqual(reconcileDecision(null, NOW), { action: 'none' })
  assert.deepEqual(reconcileDecision({ status: 'default', startedAt: 0 }, NOW), { action: 'none' })
  assert.deepEqual(reconcileDecision({ status: 'startTomatoTime', startedAt: 0 }, NOW), { action: 'none' }, 'running status with zero startedAt is not a live session')
})

test('reconcileDecision: fresh focus → pending, expired focus → book, any rest → void', () => {
  const focus = { status: 'startTomatoTime', startedAt: T0, tomatoTime: 25 }
  assert.deepEqual(reconcileDecision(focus, T0 + 24 * 60_000), { action: 'pending', startedAt: T0 }, 'inside the configured focus window the phase is pending (quick restart keeps it alive)')
  assert.equal(reconcileDecision(focus, T0 + 25 * 60_000).action, 'book', 'exactly at the limit the focus is expired')
  assert.deepEqual(reconcileDecision({ status: 'startRestTime', startedAt: T0 }, T0 + 60_000), { action: 'void', startedAt: T0 }, 'rest is voided regardless of elapsed time')
})

test('reconcileDecision: booked focus measures elapsed minutes, clamped to the ledger cap', () => {
  const focus = { status: 'startTomatoTime', startedAt: T0, tomatoTime: 25 }
  assert.equal(reconcileDecision(focus, T0 + 30 * 60_000).focusDuration, 30, 'measured elapsed time, not the configured 25')
  assert.equal(reconcileDecision(focus, T0 + 8_000 * 60_000).focusDuration, 600, 'booked duration clamped to 600 minutes')
  assert.equal(reconcileDecision({ status: 'startTomatoTime', startedAt: T0, tomatoTime: 0 }, T0 + 30 * 60_000).focusDuration, 30, 'bogus tomatoTime falls back to the 25-minute expiry window; duration stays measured')
  assert.equal(reconcileDecision({ status: 'startTomatoTime', startedAt: T0, tomatoTime: 0 }, T0 + 60_000).action, 'pending', 'bogus tomatoTime uses the 25-minute default expiry window')
})

test('reconcile: no durable row on boot → no-op with no ledger writes', () => {
  const db = makeDb()
  const s = createTomatoSession({ call: db.call })
  const d = s.reconcile()
  assert.equal(d.action, 'none')
  assert.equal(db.tomatoes.length, 0, 'nothing appended to the ledger')
  assert.equal(db.meta.size, 0, 'nothing written back')
})

test('reconcile: expired focus is booked as an abandoned record and the row is cleared', () => {
  const db = makeDb()
  db.tomatoes.push({ taskId: 42, taskContent: 'Deep work', delete: false })
  const startedAt = NOW - 30 * 60_000
  const s = createTomatoSession({ call: db.call })
  s.applyTransition(startPayload(startedAt))
  const d = s.reconcile()
  assert.equal(d.action, 'book')
  assert.equal(d.startedAt, startedAt)
  assert.equal(d.focusDuration, 30)
  const rec = db.tomatoes.find(r => r.tomatoId === 'tmt_a_' + startedAt)
  assert.ok(rec, 'ledger row appended with the deterministic idempotent tomatoId')
  assert.equal(rec.succeed, false, 'abandoned focus is not a succeeded tomato')
  assert.equal(rec.status, 'local')
  assert.equal(rec.abandonReason, 'startup-reconcile (renderer died mid-focus)')
  assert.equal(rec.focus, 'Deep work', 'live attached task resolved at accounting time')
  assert.equal(rec.focusTaskId, 42)
  assert.equal(rec.restDuration, 0)
  assert.match(rec.dateKey, /^\d{4}-\d{2}-\d{2}$/)
  assert.equal(db.meta.has(SESSION_KEY), false, 'row cleared after successful booking')
})

test('reconcile: a deleted attached task books as free focus (no crash, no stale identity)', () => {
  const db = makeDb()
  db.tomatoes.push({ taskId: 42, taskContent: 'Gone', delete: true })
  const startedAt = NOW - 60 * 60_000
  const s = createTomatoSession({ call: db.call })
  s.applyTransition(startPayload(startedAt))
  const d = s.reconcile()
  assert.equal(d.action, 'book')
  const rec = db.tomatoes.find(r => r.tomatoId === 'tmt_a_' + startedAt)
  assert.equal(rec.focusTaskId, null, 'deleted task resolves to free focus')
  assert.equal(rec.focus, '')
})

test('reconcile: failed booking KEEPS the row so the next boot retries the idempotent upsert', () => {
  const db = makeDb()
  let fail = true
  const call = (op, p) => {
    if (op === 'tomatoAppendMany' && fail) throw new Error('db closed')
    return db.call(op, p)
  }
  const startedAt = NOW - 30 * 60_000
  const s = createTomatoSession({ call })
  s.applyTransition(startPayload(startedAt))
  assert.equal(s.reconcile().action, 'book')
  assert.equal(db.meta.has(SESSION_KEY), true, 'the durable row survives a failed booking — clearing it would be the silent drop')
  // next boot: booking succeeds, row is then cleared
  fail = false
  const s2 = createTomatoSession({ call })
  assert.equal(s2.reconcile().action, 'book')
  assert.equal(db.meta.has(SESSION_KEY), false)
  assert.equal(db.tomatoes.filter(r => r.tomatoId === 'tmt_a_' + startedAt).length >= 1, true)
})

test('reconcile: pending focus is left untouched (hydration resumes it); rest is voided and cleared', () => {
  const db1 = makeDb()
  const s1 = createTomatoSession({ call: db1.call })
  s1.applyTransition(startPayload(NOW - 5 * 60_000))
  assert.equal(s1.reconcile().action, 'pending')
  assert.equal(db1.tomatoes.length, 0, 'a live focus is not booked')
  assert.equal(db1.meta.has(SESSION_KEY), true, 'pending row kept for renderer hydration')

  const db2 = makeDb()
  const s2 = createTomatoSession({ call: db2.call })
  s2.applyTransition({ transition: 'start', status: 'startRestTime', startedAt: NOW - 90 * 60_000, restTime: 5 })
  assert.equal(s2.reconcile().action, 'void')
  assert.equal(db2.meta.has(SESSION_KEY), false, 'voided rest clears the durable row')
  assert.equal(db2.tomatoes.length, 0, 'rest is never a ledger asset')
})

test('a corrupt meta row reads as no session and is self-healed away', () => {
  const db = makeDb()
  db.meta.set(SESSION_KEY, '{not json')
  const s = createTomatoSession({ call: db.call })
  assert.equal(s.hasRunningSession(), false, 'corrupt row cannot wedge the quit guard')
  assert.equal(db.meta.has(SESSION_KEY), false, 'corrupt row deleted so it cannot wedge the next boot either')
  // and a start transition afterwards works normally again
  assert.equal(s.applyTransition(startPayload()), true)
  assert.equal(s.hasRunningSession(), true)
})

test('hasRunningSession is false for an idle-shaped row even if some stale JSON exists', () => {
  const db = makeDb()
  db.meta.set(SESSION_KEY, JSON.stringify({ status: 'default', startedAt: 0 }))
  const s = createTomatoSession({ call: db.call })
  assert.equal(s.hasRunningSession(), false)
})

test('read failures on getMeta degrade to "no running session" instead of throwing', () => {
  const call = (op) => { if (op === 'getMeta') throw new Error('db gone'); return true }
  const s = createTomatoSession({ call })
  assert.equal(s.hasRunningSession(), false)
})

test('a setMeta write failure makes applyTransition return false without throwing', () => {
  const db = makeDb()
  const call = (op, p) => {
    if (op === 'setMeta') throw new Error('disk full')
    return db.call(op, p)
  }
  const s = createTomatoSession({ call })
  assert.equal(s.applyTransition(startPayload()), false)
  assert.equal(db.meta.has(SESSION_KEY), false)
})
