import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

/**
 * W31 F3 regression: the S1 causal-current override in src/main/sync-apply.js used to probe
 * `revisionsList({entityId, limit:1})` per envelope row (synchronous sqlite on the main thread —
 * thousands-row relay pulls stalled IPC). The head-existence probe is now memoized per ingest
 * pass on the per-pass cache (state.applyCache.__revHeads). Pinned here:
 *   1. equivalence: a mixed batch (ids WITH a revision head vs v1-era ids WITHOUT one) decides
 *      exactly like per-row probing — causal override only for headed ids.
 *   2. cost: at most ONE probe per DISTINCT id per pass (counting stub) — RED under the old
 *      per-row implementation (one query per row), GREEN under the per-pass memo.
 *
 * Run: node --test tests/unit/main/w31-sync-apply-revhead-cache.test.mjs
 */
process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-w31-f5-revhead-'))
process.env.TODO_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-w31-f5-revhead-ud-'))
const require = createRequire(import.meta.url)
const db = require('../../../src/main/db')
const syncApply = require('../../../src/main/sync-apply')

db.init(process.env.TODO_DB_DIR)

const NOW = 1700000000000
const addTodo = (id, content, updatedAt) => db.call('upsert', { taskId: id, taskContent: content, updateTime: updatedAt, status: 'update' })

// Stale remote causal-current edit (older updatedAt than local, so ONLY the causal override
// can land it — plain LWW keeps the newer local line).
const envelope = (id, content, updatedAt) => ({
  entity: 'todo', id, updatedAt, deleted: false, deletedAt: 0, causalCurrent: true, author: 'peer',
  data: { taskId: id, taskContent: content, updatedAt },
})

function countingState () {
  const counts = { revisionsList: 0 }
  const base = db.call.bind(db)
  const state = {
    db: { call: (op, p) => { if (op === 'revisionsList') counts.revisionsList++; return base(op, p) } },
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
  }
  // Ingest pass boundary: callers install one hydration cache per pass; the head memo rides on it.
  state.applyCache = syncApply.createHydrationCache(state)
  return { state, counts }
}

test('W31 F3: mixed batch — causal override only for ids with a revision head (per-row-probing semantics)', () => {
  db.call('revisionsFlag', { on: true })
  try {
    addTodo('f5-head', 'head local', NOW) // written with revisions ON -> a revision head exists
    db.call('revisionsFlag', { on: false })
    addTodo('f5-nohead', 'nohead local', NOW) // v1-era row -> no head ever recorded
    db.call('revisionsFlag', { on: true })
    assert.equal((db.call('revisionsList', { entityId: 'f5-head', limit: 1 }) || []).length > 0, true, 'precondition: f5-head has a head')
    assert.equal((db.call('revisionsList', { entityId: 'f5-nohead', limit: 1 }) || []).length > 0, false, 'precondition: f5-nohead has no head')

    const { state } = countingState()
    // One pass, interleaved: headed ids take the causal override (stale remote WINS); headless
    // ids fall through to LWW (newer local stands) — identical to per-row querying.
    assert.equal(syncApply.applyRowSafe(state, envelope('f5-head', 'head remote', NOW - 1000)), true)
    assert.equal(syncApply.applyRowSafe(state, envelope('f5-nohead', 'nohead remote', NOW - 1000)), false)
    assert.equal(syncApply.applyRowSafe(state, envelope('f5-head', 'head remote 2', NOW - 2000)), true)
    assert.equal(syncApply.applyRowSafe(state, envelope('f5-nohead', 'nohead remote 2', NOW - 2000)), false)

    syncApply.flushPendingWrites(state)
    const rows = Object.fromEntries(db.call('getAll', { deleted: null }).map(r => [r.taskId, r]))
    assert.equal(rows['f5-head'].taskContent, 'head remote 2', 'headed id converged to the remote causal current')
    assert.equal(rows['f5-nohead'].taskContent, 'nohead local', 'headless id kept the newer local line')
  } finally { db.call('revisionsFlag', { on: false }) }
})

test('W31 F3: the head probe costs at most ONE query per distinct id per pass (RED on per-row probing)', () => {
  db.call('revisionsFlag', { on: true })
  try {
    addTodo('f5-head2', 'head local', NOW)
    const { state, counts } = countingState()
    // 6 causal rows over 2 distinct ids: per-row probing = 6 queries; memoized = at most 2.
    for (let i = 0; i < 3; i++) syncApply.applyRowSafe(state, envelope('f5-head2', 'remote ' + i, NOW - 1000 - i))
    for (let i = 0; i < 3; i++) syncApply.applyRowSafe(state, envelope('f5-ghost', 'remote ' + i, NOW - 1000 - i))
    assert.ok(counts.revisionsList <= 2, `probes memoized per pass (got ${counts.revisionsList}, want <= 2)`)
    // A NEW pass (fresh applyCache) re-probes: per-pass cache, never process-wide.
    const { state: s2, counts: c2 } = countingState()
    syncApply.applyRowSafe(s2, envelope('f5-head2', 'remote next-pass', NOW - 5000))
    assert.equal(c2.revisionsList, 1, 'a fresh ingest pass starts with a cold head-existence set')
  } finally { db.call('revisionsFlag', { on: false }) }
})
