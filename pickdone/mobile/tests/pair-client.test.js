import assert from 'node:assert/strict'
import { test } from 'node:test'
import { categoryToDto, episodeToDto, inboundVerdict, taskToDto, VERDICTS } from '../src/sync/pair-contract.js'
import { createcreatePairClient } from '../src/sync/pair-client.js'

test('mobile DTO aliases and tombstones match desktop Lane A contract', () => {
  const task = taskToDto({ id: 't1', content: 'Title', description: 'Body', version: 9, updatedAt: 123, deleted: 1, deletedAt: 120, fileAttach: 'private/path' })
  assert.deepEqual(task, { description: 'Body', updatedAt: 123, deleted: 1, deletedAt: 120, version: 9, dtoVersion: 1, taskId: 't1', title: 'Title' })
  assert.equal(Object.hasOwn(task, 'fileAttach'), false)
  assert.deepEqual(categoryToDto({ id: 2, name: 'Project', updatedAt: 8, deleted: 0 }), { id: 2, name: 'Project', updatedAt: 8, deleted: 0, dtoVersion: 1, isProject: 1 })
  assert.deepEqual(episodeToDto({ id: 'e1', taskId: 't1', note: 'Work', updatedAt: 9, deleted: 0 }), { taskId: 't1', updatedAt: 9, deleted: 0, dtoVersion: 1, episodeId: 'e1', summary: 'Work' })
})

test('desktop LWW verdicts retain deletion and surface edit/delete conflicts', () => {
  assert.equal(inboundVerdict({ updatedAt: 50, deleted: 1 }, { updatedAt: 49, deleted: 0 }), VERDICTS.STALE_SKIP)
  assert.equal(inboundVerdict({ updatedAt: 50, deleted: 1 }, { updatedAt: 50, deleted: 1 }), VERDICTS.IDEMPOTENT_SKIP)
  assert.equal(inboundVerdict({ updatedAt: 50, deleted: 0 }, { updatedAt: 51, deleted: 1 }), VERDICTS.CONFLICT_TOMBSTONE_WINS)
  assert.equal(inboundVerdict({ updatedAt: 50, deleted: 1 }, { updatedAt: 51, deleted: 0 }), VERDICTS.CONFLICT_EDIT_WINS)
})

test('prepared client requires a live scoped pairing and preserves retry messageId', async () => {
  const sent = []
  const transport = request => { sent.push(request); return Promise.resolve({ ok: true, result: { verdict: VERDICTS.APPLIED } }) }
  const read = createcreatePairClient({ transport, deviceId: 'android-1', credentials: { token: 'test-token', csrfNonce: 'nonce', expiresAt: 101, scope: 'READ' }, now: () => 100 })
  await read.pull('pull-1')
  assert.deepEqual(sent[0], { op: 'sync.pull', bearer: 'test-token', csrfHeader: 'nonce', deviceId: 'android-1', messageId: 'pull-1', payload: undefined, entity: undefined })
  assert.throws(() => read.push('todos', { id: 't1', content: 'Task' }), /WRITE scope/)
  const write = createcreatePairClient({ transport, deviceId: 'android-1', credentials: { token: 'test-token', csrfNonce: 'nonce', expiresAt: 101, scope: 'WRITE' }, now: () => 100 })
  await write.push('todos', { id: 't1', content: 'Task', updatedAt: 90, deleted: 0 }, 'retry-1')
  await write.push('todos', { id: 't1', content: 'Task', updatedAt: 90, deleted: 0 }, 'retry-1')
  assert.equal(sent[1].messageId, sent[2].messageId)
  assert.equal(sent[1].payload.taskId, 't1')
  assert.equal(sent[1].entity, 'todos')
  const expired = createcreatePairClient({ transport, deviceId: 'android-1', credentials: { token: 'test-token', csrfNonce: 'nonce', expiresAt: 100, scope: 'WRITE' }, now: () => 100 })
  assert.throws(() => expired.pull(), /expired/)
  assert.equal(sent.length, 3)
})