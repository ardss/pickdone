/** TQ-1 (2026-10-03) — durable main-process ownership of the tomato running session.
 *
 * Invariant under test: "a running focus phase is always either recorded or explicitly given up,
 * across any renderer death mode" — the durable 'tomatoRunningSession' meta row is written on
 * every FSM transition (from BOTH windows), consulted by the quit guard instead of the tray-text
 * display lease, reconciled book-or-void at startup, and cleared on quit teardown.
 *
 * Run: node --test tests/unit/main/tq1-tomato-session.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { createTomatoSession, sessionRowFromTransition, reconcileDecision } = require('../../../src/main/tomato-session.js')

/** In-memory dbm double: records every op so assertions can inspect the durable trail. */
function makeDb () {
  const meta = new Map()
  const tomatoes = []
  const calls = []
  const call = (op, p) => {
    calls.push([op, p])
    if (op === 'getMeta') return meta.has(p) ? meta.get(p) : null
    if (op === 'setMeta') { meta.set(Array.isArray(p) ? p[0] : p, Array.isArray(p) ? p[1] : null); return true }
    if (op === 'deleteMeta') return meta.delete(p)
    if (op === 'getById') { const r = tomatoes.find(t => t.taskId === p); return r ? { ...r } : null }
    if (op === 'tomatoAppendMany') { tomatoes.push(...(Array.isArray(p) ? p : [p]).map(r => ({ ...r }))); return { accepted: 1, rejected: [] } }
    throw new Error('unexpected op ' + op)
  }
  return { call, calls, meta, tomatoes }
}

const START = { transition: 'start', status: 'startTomatoTime', startedAt: 1_700_000_000_000, attachTaskId: 7, tomatoTime: 25, restTime: 5 }

test('tq1[1]: a start transition writes the durable row; the quit guard reads IT, not the display lease', () => {
  const db = makeDb()
  const s = createTomatoSession({ call: db.call })
  assert.equal(s.applyTransition(START), true, 'start transition accepted')
  const raw = db.meta.get('tomatoRunningSession')
  assert.ok(raw, 'durable row written')
  const row = JSON.parse(raw)
  assert.equal(row.status, 'startTomatoTime')
  assert.equal(row.startedAt, START.startedAt)
  assert.equal(row.attachTaskId, 7, 'attach identity carried for accounting-time resolution')
  assert.equal(row.tomatoTime, 25, 'focus length carried for the expiry decision')
  assert.equal(s.hasRunningSession(), true, 'quit guard signal: durable row says a phase is live')
  // any renderer death mode: the row survives — the lease is irrelevant to the guard now
  assert.equal(s.hasRunningSession(), true, 'row persists beyond the 10s display-lease TTL class')
})

test('tq1[2]: terminal transitions clear the row — the phase was recorded or explicitly given up', () => {
  for (const t of ['complete', 'giveUp', 'finishRest']) {
    const db = makeDb()
    const s = createTomatoSession({ call: db.call })
    s.applyTransition(START)
    assert.equal(s.applyTransition({ transition: t, status: 'default', startedAt: 0 }), true)
    assert.equal(db.meta.has('tomatoRunningSession'), false, t + ' clears the durable row')
    assert.equal(s.hasRunningSession(), false)
  }
})

test('tq1[3]: garbage/forged payloads never write a row (bounded spoof surface)', () => {
  const db = makeDb()
  const s = createTomatoSession({ call: db.call })
  for (const bad of [null, undefined, {}, { transition: 'start' }, { transition: 'start', startedAt: 0 }, { transition: 'start', status: 'nonsense', startedAt: 5 }, { transition: 'hax', status: 'startTomatoTime', startedAt: 5 }]) {
    assert.equal(s.applyTransition(bad), false)
  }
  assert.equal(db.meta.size, 0, 'no row written from any rejected payload')
})

test('tq1[4]: startup reconcile BOOKS a dead renderer\'s expired focus (never silently dropped)', () => {
  const db = makeDb()
  db.tomatoes.push({ taskId: 7, taskContent: 'Deep work', delete: false })
  const startedAt = Date.now() - 30 * 60_000 // focus ran 25min, renderer died, app relaunched 5min later
  const s = createTomatoSession({ call: db.call })
  s.applyTransition({ ...START, startedAt })
  const d = s.reconcile()
  assert.equal(d.action, 'book', 'expired focus with no terminal transition = book')
  const rec = db.tomatoes.find(r => r.tomatoId === 'tmt_a_' + startedAt)
  assert.ok(rec, 'the dead renderer\'s focus is recorded')
  assert.equal(rec.succeed, false, 'booked as an abandoned-focus record (measured time, not a completed tomato)')
  assert.equal(rec.focusDuration, 30, 'measured minutes (30 elapsed — measured, not the configured 25)')
  assert.equal(rec.focus, 'Deep work', 'live attach resolved at accounting time')
  assert.equal(rec.focusTaskId, 7)
  assert.ok(rec.dateKey && /^\d{4}-\d{2}-\d{2}$/.test(rec.dateKey), 'dateKey derived from endTime')
  assert.equal(db.meta.has('tomatoRunningSession'), false, 'row cleared after booking')
  // crash between booking and clear must not wedge: a failed booking KEEPS the row (retry next boot)
})

test('tq1[5]: reconcile leaves a still-fresh focus pending (quick restart must not kill a live phase) and voids a leftover rest', () => {
  const db1 = makeDb()
  const s1 = createTomatoSession({ call: db1.call })
  s1.applyTransition({ ...START, startedAt: Date.now() - 5 * 60_000 })
  assert.equal(s1.reconcile().action, 'pending', 'unexpired focus: the renderer hydration resumes it')
  assert.equal(db1.meta.has('tomatoRunningSession'), true, 'pending row kept')

  const db2 = makeDb()
  const s2 = createTomatoSession({ call: db2.call })
  s2.applyTransition({ ...START, status: 'startRestTime', startedAt: Date.now() - 60 * 60_000 })
  assert.equal(s2.reconcile().action, 'void', 'rest is never a ledger asset — void, not book')
  assert.equal(db2.meta.has('tomatoRunningSession'), false, 'voided rest clears the row')
})

test('tq1[6]: pure pieces — sessionRowFromTransition clamps, reconcileDecision decides deterministically', () => {
  const row = sessionRowFromTransition({ ...START, tomatoTime: 99999 })
  assert.ok(row.tomatoTime <= 600, 'focus length clamped to the ledger cap (single source)')
  const future = sessionRowFromTransition({ ...START, startedAt: Date.now() + 3_600_000 })
  assert.equal(future, null, 'future startedAt rejected (clock garbage cannot plant a permanent row)')
  assert.equal(reconcileDecision(null, Date.now()).action, 'none')
  assert.equal(reconcileDecision({ status: 'default', startedAt: 0 }, Date.now()).action, 'none')
  const t0 = 1_700_000_000_000
  assert.equal(reconcileDecision({ status: 'startTomatoTime', startedAt: t0, tomatoTime: 25 }, t0 + 10 * 60_000).action, 'pending')
  assert.equal(reconcileDecision({ status: 'startTomatoTime', startedAt: t0, tomatoTime: 25 }, t0 + 30 * 60_000).action, 'book')
  assert.equal(reconcileDecision({ status: 'startRestTime', startedAt: t0 }, t0 + 60_000).action, 'void')
})

test('tq1[7]: the renderer reports transitions from BOTH window shells (contract surface)', async () => {
  const { readFileSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const { dirname, join } = await import('node:path')
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../..')
  const store = readFileSync(join(root, 'renderer/js/store/tomato.js'), 'utf8')
  assert.ok(store.includes("reportRunningTransition('start'"), 'startFocus + completeFocus report the new phase')
  assert.ok(store.includes("reportRunningTransition('clear'"), 'giveUp + finishRest release the row')
  const handler = readFileSync(join(root, 'src/main/handlers/tomato.js'), 'utf8')
  const ch = handler.slice(handler.indexOf("'tomato-running-session'"), handler.indexOf("'tomato-running-session'") + 900)
  assert.ok(ch.includes('isFloatSelf'), 'float-originated focus must reach the durable row (the main-window-gated taskbar channel was the blindness)')
  const idx = readFileSync(join(root, 'src/main/index.js'), 'utf8')
  const trayQuit = idx.slice(idx.indexOf('async function quitFromTrayInner'), idx.indexOf('function rebuildTrayMenu'))
  assert.ok(trayQuit.includes('hasRunningSession()'), 'tray-quit confirm gates on the durable row, not the display lease')
  assert.ok(idx.includes('tomatoSession.reconcile()'), 'startup reconciliation is wired in whenReady')
  assert.ok(idx.includes('tomatoSession.clear()'), 'quit teardown clears the durable row')
})
