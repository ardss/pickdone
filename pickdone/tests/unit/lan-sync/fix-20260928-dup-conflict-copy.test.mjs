/* 2026-09-28 3-machine live drill regression: two conflicts on the SAME base row inside ONE
 * ingest pass minted TWO identical recycle-bin copies (observed live on the lubancat/local
 * pair). Root cause chain: the hydration cache is created once per pass, so the second apply
 * of the same pointer reads the STALE local row; and hasEquivalentConflictCopy scanned only
 * committed rows (getAll) while the first copy was still sitting in pendingWrites
 * (commitSyncBatch defers the flush). Fix: dedupe also scans the pending buffer.
 * Run: node --test tests/unit/lan-sync/fix-20260928-dup-conflict-copy.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const syncApply = require('../../../src/main/sync-apply.js')

function mockState () {
  const committed = []
  const state = {
    deviceId: 'local-device',
    localUserId: null,
    pendingWrites: { todos: [], settings: [], tomatoes: [], categories: [], plans: [], filters: [] },
    db: {
      call (op) {
        if (op === 'getAll') return committed
        return null
      },
    },
  }
  // One hydration cache per pass: the second apply of the same pointer must see the SAME
  // (stale) local row — that is the production mechanism this regression pins.
  const local = { taskId: 'tid_base_1', taskContent: 'A-version older', updateTime: 1000, delete: 0, deletedAt: 0 }
  const todoMap = new Map([['tid_base_1', local]])
  state.applyCache = { todo: id => todoMap.get(String(id)) }
  return state
}

const incoming = {
  entity: 'todo',
  id: 'tid_base_1',
  seq: 9,
  ts: 2000,
  updatedAt: 2000,
  deleted: false,
  deletedAt: 0,
  data: { taskId: 'tid_base_1', taskContent: 'C-version newer', updateTime: 2000, delete: 0 },
}

test('two conflicts on the same base row in one pass mint exactly ONE recycle copy', () => {
  const state = mockState()
  syncApply.applyRowSafe(state, incoming)
  syncApply.applyRowSafe(state, incoming)
  const copies = state.pendingWrites.todos.filter(t => String(t.taskId || '').includes('-conflict-'))
  assert.equal(copies.length, 1, `expected exactly one conflict copy, got ${copies.length}: ${JSON.stringify(state.pendingWrites.todos)}`)
})

test('after flush the committed-row dedupe still holds (no extra copy across batches)', () => {
  const state = mockState()
  syncApply.applyRowSafe(state, incoming)
  const first = state.pendingWrites.todos.splice(0) // simulate commitSyncBatch flush
  state.db.call2 = null
  // push flushed rows into the committed set the mock's getAll returns
  state.committedRows = first
  const origCall = state.db.call.bind(state.db)
  state.db.call = op => (op === 'getAll' ? (state.committedRows || []) : origCall(op))
  syncApply.applyRowSafe(state, incoming)
  const copies = state.pendingWrites.todos.filter(t => String(t.taskId || '').includes('-conflict-'))
  assert.equal(copies.length, 0, 'committed copy must be recognized as equivalent — no second copy across batches')
})
