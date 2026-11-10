// G2 close-out: v13 DTO field roundtrip (zone-2/zone-3 real data) + G10 conflict decision planner.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { taskToDto, episodeToDto, taskFromDto, episodeFromDto } from '../src/sync/pair-contract.js'
import { taskToDto as taskToDtoDesktop, episodeToDto as episodeToDtoDesktop } from '../src/sync/desktop-contract.js'
import { resolveConflict, conflictSides, CONFLICT_CHOICES } from '../src/conflict-resolve.js'

const NOW = 1762000000000

test('v13 contract: handoff targeting fields survive the mobile encode roundtrip', () => {
  const dto = taskToDto({ id: 't-h', content: 'Handed off', updatedAt: NOW, handoffTo: 'android-1', handoffFrom: 'win-b', handoffNote: 'ctx', handoffAckedAt: 0 })
  assert.equal(dto.handoffTo, 'android-1')
  const back = taskFromDto(dto)
  assert.equal(back.handoffTo, 'android-1')
  assert.equal(back.handoffFrom, 'win-b')
  assert.equal(back.handoffAckedAt, 0)
})

test('v13 contract: agent episode fields survive the mobile encode roundtrip (both contract copies)', () => {
  for (const toDto of [episodeToDto, episodeToDtoDesktop]) {
    const dto = toDto({ id: 'e1', taskId: 't-h', startedAt: 1, endedAt: 0, note: 'working', actorType: 'agent', role: 'agent', updatedAt: 2 })
    assert.equal(dto.actorType, 'agent')
    assert.equal(dto.role, 'agent')
  }
  const back = episodeFromDto(episodeToDto({ id: 'e1', taskId: 't-h', startedAt: 1, endedAt: 0, note: 'x', actorType: 'agent', updatedAt: 2 }))
  assert.equal(back.actorType, 'agent')
})

test('v13 contract: rows WITHOUT the new fields carry no fabricated keys (old payloads unchanged)', () => {
  const dto = taskToDtoDesktop({ id: 't', content: 'plain', updatedAt: 1 })
  for (const k of ['handoffTo', 'handoffFrom', 'handoffNote', 'handoffAckedAt']) assert.equal(Object.hasOwn(dto, k), false)
  const ep = episodeToDtoDesktop({ id: 'e', taskId: 't', startedAt: 1, endedAt: 2, updatedAt: 3 })
  assert.equal(Object.hasOwn(ep, 'actorType'), false)
})

test('v13 contract: decoded handoff task feeds the zone-2 classifier (real data path)', () => {
  const dto = taskToDto({ id: 't-h', content: 'Review PR', updatedAt: NOW, scheduledDay: 20261110, handoffTo: 'android-1', handoffFrom: 'win-b', handoffAckedAt: 0 })
  const row = taskFromDto(dto)
  // classifier imported lazily to keep this file focused
  return import('../src/firstscreen.js').then(({ classifyFirstScreen }) => {
    const r = classifyFirstScreen({ tasks: [row], episodes: [], conflicts: [], today: 20261110, deviceId: 'android-1' })
    assert.equal(r.waiting.rows.length, 1)
    assert.equal(r.waiting.rows[0].from, 'win-b')
  })
})

test('G10 keep-local: local row restamped to NOW (wins the next desktop adjudication) and pushed', () => {
  const conflict = { entity: 'todos', id: 'k1', verdict: 'conflict_edit_wins', local: { id: 'k1', content: 'mine', updatedAt: 100 }, incoming: { id: 'k1', content: 'theirs', updatedAt: 200 } }
  const r = resolveConflict(conflict, 'keep-local', { now: NOW })
  assert.equal(r.resolution, 'kept-local')
  assert.equal(r.apply[0].row.updatedAt, NOW)
  assert.equal(r.apply[0].row.content, 'mine')
  assert.deepEqual(r.push, r.apply)
})

test('G10 keep-incoming: peer row applied verbatim, nothing pushed', () => {
  const conflict = { entity: 'todos', id: 'k1', verdict: 'conflict_edit_wins', local: { id: 'k1', content: 'mine', updatedAt: 100 }, incoming: { id: 'k1', content: 'theirs', updatedAt: 200, deletedAt: 0 } }
  const r = resolveConflict(conflict, 'keep-incoming', { now: NOW })
  assert.equal(r.resolution, 'kept-incoming')
  assert.equal(r.apply[0].row.content, 'theirs')
  assert.equal(r.apply[0].row.updatedAt, 200, 'peer stamp preserved, never re-minted')
  assert.deepEqual(r.push, [])
})

test('G10 keep-both: incoming saved as a copy under a NEW id and pushed; local untouched', () => {
  const conflict = { entity: 'todos', id: 'k1', verdict: 'conflict_edit_wins', local: { id: 'k1', content: 'mine', updatedAt: 100 }, incoming: { id: 'k1', content: 'theirs', updatedAt: 200 } }
  const r = resolveConflict(conflict, 'keep-both', { now: NOW, mintId: () => 'copy-1' })
  assert.equal(r.resolution, 'kept-both')
  assert.equal(r.apply.length, 1)
  const copy = r.apply[0].row
  assert.equal(copy.id, 'copy-1')
  assert.equal(copy.content, 'theirs（副本）')
  assert.equal(copy.updatedAt, NOW)
  assert.deepEqual(r.push, [{ entity: 'todos', row: copy }])
  assert.equal(conflict.local.id, 'k1', 'the local row itself is never overwritten')
})

test('G10 invalid choices and missing sides are explicit errors', () => {
  const conflict = { entity: 'todos', id: 'k1', local: { id: 'k1', updatedAt: 1 }, incoming: { id: 'k1', updatedAt: 2 } }
  assert.throws(() => resolveConflict(conflict, 'merge'), /choice must be one of/)
  assert.throws(() => resolveConflict({ entity: 'todos', id: 'k1', incoming: null, local: { id: 'k1' } }, 'keep-incoming'), /no incoming side/)
  assert.deepEqual([...CONFLICT_CHOICES], ['keep-local', 'keep-incoming', 'keep-both'])
})

test('G10 conflictSides: both versions side by side with timestamps for the sheet', () => {
  const sides = conflictSides({ entity: 'todos', id: 'k1', local: { id: 'k1', content: 'mine', updatedAt: 100 }, incoming: { id: 'k1', content: 'theirs', updatedAt: 200, deleted: 1 } })
  assert.equal(sides.local.text, 'mine')
  assert.equal(sides.local.updatedAt, 100)
  assert.equal(sides.incoming.text, 'theirs')
  assert.equal(sides.incoming.deleted, true)
})
