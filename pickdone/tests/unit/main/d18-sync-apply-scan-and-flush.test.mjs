/**
 * D18 (2026-10-02) — sync-apply conflict-copy dedup + flush buffer retention.
 * [F5] hasEquivalentConflictCopy returned false on scan failure, so a persistent getAll
 *      failure minted a NEW -conflict- recycle-bin row EVERY round (unbounded growth). It now
 *      returns null (indeterminate) on failure and the caller skips minting that round.
 * [F11] flushPendingWrites cleared the buffer even when BOTH the bulk write AND quarantine
 *      parking failed → silent row loss behind a flushFailed ack. The segment is now RETAINED
 *      for retry when parking fails.
 * Run: node --test tests/unit/main/d18-sync-apply-scan-and-flush.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
process.env.TODO_DB_DIR = require('node:os').tmpdir() // log-isolation: keep electron-log file transport out of the repo
const sa = require('../../../src/main/sync-apply.js')

const BASE = 'task-1'
const loser = { taskId: 'ignored', taskContent: 'lost edit', updatedAt: 123 }

test('F5: no equivalent copy → false (mint path unchanged)', () => {
  const state = { db: { call: (op) => op === 'getAll' ? [] : undefined }, pendingWrites: { todos: [] } }
  assert.equal(sa.hasEquivalentConflictCopy(state, BASE, loser), false)
})

test('F5: equivalent copy in the recycle bin or the pending buffer → true (dedup unchanged)', () => {
  const copy = { taskId: BASE + '-conflict-abc-1', taskContent: 'lost edit', updatedAt: 123 }
  const stateA = { db: { call: () => [copy] }, pendingWrites: { todos: [] } }
  assert.equal(sa.hasEquivalentConflictCopy(stateA, BASE, loser), true)
  const stateB = { db: { call: () => [] }, pendingWrites: { todos: [copy] } }
  assert.equal(sa.hasEquivalentConflictCopy(stateB, BASE, loser), true)
})

test('F5: scan failure → null (indeterminate), NOT false — the caller must skip minting', () => {
  const state = { db: { call: () => { throw new Error('getAll dead (persistent)') } }, pendingWrites: { todos: [] } }
  assert.equal(sa.hasEquivalentConflictCopy(state, BASE, loser), null,
    'red before the fix: scan failure returned false and every round minted a duplicate copy')
})

test('F11: bulk write AND quarantine parking both fail → the buffer segment is RETAINED', () => {
  const calls = []
  const state = {
    db: { call: (op, p) => { calls.push(op); throw new Error('db dead') } },
    pendingWrites: { todos: [{ taskId: 't1', taskContent: 'x', updatedAt: 1 }] },
    pendingAnnounces: null
  }
  const r = sa.flushPendingWrites(state)
  assert.equal(r.ok, false, 'parking failed → the segment must not be acked (fail closed)')
  assert.equal(state.pendingWrites.todos.length, 1,
    'red before the fix: the buffer was cleared even though BOTH the write and the quarantine failed (silent row loss)')
  assert.ok(!r.quarantined.length, 'nothing was parked either — retaining is the only loss-free option')
})

test('F11: a successful flush still clears the buffer (happy path unchanged)', () => {
  const state = {
    db: { call: () => undefined },
    pendingWrites: { todos: [{ taskId: 't1', taskContent: 'x', updatedAt: 1 }], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    pendingAnnounces: null
  }
  const r = sa.flushPendingWrites(state)
  assert.equal(r.ok, true)
  assert.equal(state.pendingWrites.todos.length, 0, 'red if the retain path also retained successful flushes')
})
