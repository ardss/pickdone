/**
 * G1 [8] regression for store/helpers/undo.js persistSnapshotDiffCore: the undo-of-create re-delete used to
 * spread the row WITHOUT resetting version to 0 — syncTodos excludes delete rows already acked with
 * version > 0, so the soft delete never propagated (same bug family as deleteTodo's P3 2026-09-12 fix).
 * Run: node --test tests/unit/store/g1-undo-reduplicate-version.test.mjs
 */
import '../../setup.mjs'
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { persistSnapshotDiffCore } from '../../../renderer/js/store/helpers/undo.js'

function makeCtx () {
  const upserted = []
  const persisted = []
  const ctx = {
    commit (m, row) { if (m === 'upsertLocal') upserted.push(row) },
    state: {}
  }
  const safeUpsert = row => persisted.push(row)
  return { ctx, safeUpsert, upserted, persisted }
}

test('G1 [8]: undo-of-create re-delete resets version to 0 so the delete propagates through syncTodos', async () => {
  const { ctx, safeUpsert, upserted, persisted } = makeCtx()
  // The task was created on the server (version acked > 0), then the undo snapshot drops it
  const from = { todoList: [{ taskId: 'T1', taskContent: 'x', delete: false, version: 5, updateTime: 1 }], recycleList: [] }
  const to = { todoList: [], recycleList: [] }
  await persistSnapshotDiffCore.call(ctx, ctx, { from, to }, safeUpsert)
  assert.equal(persisted.length, 1, 'the dropped row is soft-deleted exactly once')
  assert.equal(persisted[0].delete, true)
  assert.equal(persisted[0].status, 'delete')
  assert.equal(persisted[0].version, 0, 'version reset to 0 (was: kept 5 → syncTodos filter excluded the delete forever)')
  assert.equal(upserted[0].version, 0, 'the local merge carries the same reset')
})
