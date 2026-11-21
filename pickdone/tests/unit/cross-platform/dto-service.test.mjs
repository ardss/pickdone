import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyInboundRow, applyInboundBatch, VERDICTS, ENTITIES } from '../../../shared/cross-platform/dto-service.mjs'
import { taskFromDto } from '../../../shared/cross-platform/dto.mjs'

/** Minimal in-memory repo shaped exactly like the db abstraction door (entity, op, row). */
function memRepo (seed = {}) {
  const tables = { todos: new Map(), categories: new Map(), work_episodes: new Map(), source_refs: new Map(), task_source_links: new Map(), ...seed }
  return {
    tables,
    get (entity, id) { return tables[entity].get(String(id)) || null },
    put (entity, row) { tables[entity].set(String(row.id), row) }
  }
}

test('entity allowlist is exactly the authoritative desktop tables (no second model)', () => {
  assert.deepEqual([...ENTITIES].sort(), ['categories', 'source_refs', 'task_source_links', 'todos', 'work_episodes'])
})

test('apply a task DTO row end-to-end: DTO in, canonical row persisted', () => {
  const repo = memRepo()
  const row = taskFromDto({ taskId: 't-1', title: 'Ship it', updatedAt: 500, deleted: 0, deletedAt: 0 })
  const r = applyInboundRow(repo, 'todos', row)
  assert.equal(r.verdict, VERDICTS.APPLIED)
  const stored = repo.get('todos', 't-1')
  assert.equal(stored.content, 'Ship it')
  assert.equal(stored.updatedAt, 500, 'inbound stamp is preserved, not fabricated')
})

test('duplicate message: applying the exact same row twice is an idempotent skip', () => {
  const repo = memRepo()
  const row = { id: 't-2', content: 'X', deleted: 0, deletedAt: 0, updatedAt: 100 }
  assert.equal(applyInboundRow(repo, 'todos', row).verdict, VERDICTS.APPLIED)
  assert.equal(applyInboundRow(repo, 'todos', row).verdict, VERDICTS.IDEMPOTENT_SKIP)
  assert.equal(repo.get('todos', 't-2').content, 'X', 'row not mutated by the replay')
})

test('stale inbound never regresses a newer local row', () => {
  const repo = memRepo()
  repo.put('todos', { id: 't-3', content: 'newer local', deleted: 0, deletedAt: 0, updatedAt: 900 })
  const r = applyInboundRow(repo, 'todos', { id: 't-3', content: 'older remote', deleted: 0, deletedAt: 0, updatedAt: 100 })
  assert.equal(r.verdict, VERDICTS.STALE_SKIP)
  assert.equal(repo.get('todos', 't-3').content, 'newer local')
})

test('tombstone-vs-edit: newer inbound delete wins AND the conflict is surfaced, never silent', () => {
  const repo = memRepo()
  repo.put('todos', { id: 't-4', content: 'edited locally', deleted: 0, deletedAt: 0, updatedAt: 100 })
  const r = applyInboundRow(repo, 'todos', { id: 't-4', deleted: 1, deletedAt: 200, updatedAt: 200 })
  assert.equal(r.verdict, VERDICTS.CONFLICT_TOMBSTONE_WINS)
  assert.equal(r.conflict.winner, 'delete')
  assert.equal(r.conflict.entity, 'todos')
  const stored = repo.get('todos', 't-4')
  assert.equal(stored.deleted, 1, 'newer tombstone is applied')
  assert.equal(stored.deletedAt, 200)
})

test('edit-vs-tombstone: newer inbound edit revives over an older local tombstone, conflict surfaced', () => {
  const repo = memRepo()
  repo.put('todos', { id: 't-5', content: 'old', deleted: 1, deletedAt: 100, updatedAt: 100 })
  const r = applyInboundRow(repo, 'todos', { id: 't-5', content: 'edited remotely', deleted: 0, deletedAt: 0, updatedAt: 300 })
  assert.equal(r.verdict, VERDICTS.CONFLICT_EDIT_WINS)
  assert.equal(r.conflict.winner, 'edit')
  const stored = repo.get('todos', 't-5')
  assert.equal(stored.deleted, 0)
  assert.equal(stored.content, 'edited remotely')
})

test('UNKNOWN fields on the row ride into the persisted row untouched', () => {
  const repo = memRepo()
  const r = applyInboundRow(repo, 'todos', { id: 't-6', content: 'k', deleted: 0, deletedAt: 0, updatedAt: 1, clientPrivate: { a: 1 } })
  assert.equal(r.verdict, VERDICTS.APPLIED)
  assert.deepEqual(repo.get('todos', 't-6').clientPrivate, { a: 1 })
})

test('unknown entity and identity-less rows are rejected (fail closed)', () => {
  const repo = memRepo()
  assert.equal(applyInboundRow(repo, 'projects', { id: 1 }).verdict, VERDICTS.REJECTED)
  assert.equal(applyInboundRow(repo, 'todos', { content: 'no id' }).verdict, VERDICTS.REJECTED)
  assert.throws(() => applyInboundRow(null, 'todos', { id: 1 }), TypeError)
})

test('batch apply is per-row independent: a poison row does not block good rows', () => {
  const repo = memRepo()
  const outcomes = applyInboundBatch(repo, 'todos', [
    { id: 'b-1', content: 'ok1', deleted: 0, deletedAt: 0, updatedAt: 1 },
    null,
    { id: 'b-2', content: 'ok2', deleted: 0, deletedAt: 0, updatedAt: 2 }
  ])
  assert.deepEqual(outcomes.map(o => o.verdict), [VERDICTS.APPLIED, VERDICTS.REJECTED, VERDICTS.APPLIED])
  assert.equal(repo.get('todos', 'b-1').content, 'ok1')
  assert.equal(repo.get('todos', 'b-2').content, 'ok2')
})

test('tombstone dedupe: an already-tombstoned row replayed identically is idempotent, not a conflict', () => {
  const repo = memRepo()
  const tomb = { id: 't-7', deleted: 1, deletedAt: 50, updatedAt: 50 }
  assert.equal(applyInboundRow(repo, 'todos', tomb).verdict, VERDICTS.APPLIED)
  assert.equal(applyInboundRow(repo, 'todos', { ...tomb }).verdict, VERDICTS.IDEMPOTENT_SKIP)
})

test('project (category) rows apply through the same single door', () => {
  const repo = memRepo()
  const r = applyInboundRow(repo, 'categories', { id: 7, name: 'Work', deleted: 0, deletedAt: 0, updatedAt: 9 })
  assert.equal(r.verdict, VERDICTS.APPLIED)
  assert.equal(repo.get('categories', 7).name, 'Work')
})
