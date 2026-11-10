import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  taskToDto, taskFromDto, categoryToDto, categoryFromDto,
  episodeToDto, episodeFromDto, sourceRefToDto, sourceRefFromDto,
  sourceLinkToDto, sourceLinkFromDto, DTO_VERSION
} from '../../../shared/cross-platform/dto.mjs'

test('task row maps to DTO with contract aliases (id->taskId, content->title)', () => {
  const row = {
    id: 't-1', content: 'Buy milk', description: '2L', categoryId: 3, complete: 0,
    scheduledAt: 1000, scheduledDay: 20261107, remindAt: 2000, deadlineTs: 3000,
    createdAt: 10, updatedAt: 20, deleted: 0, deletedAt: 0, syncAuthor: 'devA', version: 2
  }
  const dto = taskToDto(row)
  assert.equal(dto.taskId, 't-1')
  assert.equal(dto.title, 'Buy milk')
  assert.equal(dto.id, undefined)
  assert.equal(dto.content, undefined)
  assert.equal(dto.dtoVersion, DTO_VERSION)
  // every persisted field is present, tombstone metadata included
  for (const f of ['description', 'categoryId', 'complete', 'scheduledAt', 'scheduledDay', 'remindAt', 'deadlineTs', 'createdAt', 'updatedAt', 'deleted', 'deletedAt', 'syncAuthor', 'version']) {
    assert.ok(f in dto, `missing field ${f}`)
  }
})

test('task DTO decodes back to canonical columns (aliases restored, values unchanged)', () => {
  const dto = {
    taskId: 't-9', title: 'Report', description: '', categoryId: 0, complete: 1,
    scheduledAt: 0, scheduledDay: 20261108, remindAt: null, deadlineTs: 0,
    createdAt: 5, updatedAt: 6, deleted: 0, deletedAt: 0, syncAuthor: null, version: 1,
    dtoVersion: DTO_VERSION
  }
  const row = taskFromDto(dto)
  assert.equal(row.id, 't-9')
  assert.equal(row.content, 'Report')
  assert.equal(row.complete, 1)
  assert.equal(row.scheduledDay, 20261108)
  assert.equal(row.updatedAt, 6)
})

test('unknown client-private fields survive decode (no silent drop on the inbound apply path)', () => {
  const dto = { taskId: 't-x', title: 'T', updatedAt: 1, deleted: 0, deletedAt: 0, widgetColor: 'teal', localOrder: 42 }
  const row = taskFromDto(dto)
  assert.equal(row.widgetColor, 'teal')
  assert.equal(row.localOrder, 42)
})

test('tombstone metadata is mandatory: missing deleted/deletedAt/updatedAt are defaulted, never dropped', () => {
  const row = taskFromDto({ taskId: 't-t', title: 'gone', deleted: 1, deletedAt: 777, updatedAt: 888 })
  assert.equal(row.deleted, 1)
  assert.equal(row.deletedAt, 777)
  assert.equal(row.updatedAt, 888)
  const defaulted = taskFromDto({ taskId: 't-t2' })
  assert.deepEqual([defaulted.deleted, defaulted.deletedAt, defaulted.updatedAt], [0, 0, 0])
})

test('taskFromDto fails closed without an identity key', () => {
  assert.throws(() => taskFromDto({ title: 'no id' }), /taskId\/id required/)
  assert.throws(() => taskFromDto(null), TypeError)
})

test('project = category DTO with isProject view flag stripped on decode (no second projects table)', () => {
  const catRow = { id: 7, name: 'Work', color: '#0f9d8f', isFolder: 0, parentId: 0, deleted: 0, deletedAt: 0, updatedAt: 99 }
  const dto = categoryToDto(catRow)
  assert.equal(dto.isProject, 1)
  assert.equal(dto.name, 'Work')
  assert.equal(dto.updatedAt, 99)
  const back = categoryFromDto(dto)
  assert.equal(back.id, 7)
  assert.equal(back.isProject, undefined, 'view flag must not leak into persisted shape')
  assert.equal(back.name, 'Work')
  assert.throws(() => categoryFromDto({ id: 'not-a-number', name: 'x' }), /integer key/)
})

test('work episode maps note->summary and id->episodeId, preserving tombstones', () => {
  const epRow = { id: 'e-1', taskId: 't-1', startedAt: 100, endedAt: 200, note: 'focus block', deleted: 0, deletedAt: 0, updatedAt: 300 }
  const dto = episodeToDto(epRow)
  assert.equal(dto.episodeId, 'e-1')
  assert.equal(dto.summary, 'focus block')
  const back = episodeFromDto(dto)
  assert.equal(back.id, 'e-1')
  assert.equal(back.note, 'focus block')
  assert.equal(back.taskId, 't-1')
  const tomb = episodeToDto({ id: 'e-2', taskId: 't-1', startedAt: 0, endedAt: 0, note: null, deleted: 1, deletedAt: 5, updatedAt: 6 })
  assert.deepEqual([tomb.deleted, tomb.deletedAt, tomb.updatedAt], [1, 5, 6])
  assert.equal(episodeFromDto(tomb).deletedAt, 5)
})

test('source refs and links map 1:1 keeping the (providerId, externalId) uniqueness inputs', () => {
  const refRow = { id: 'r-1', providerId: 'jira', externalId: 'ISSUE-9', title: 'Bug', deleted: 0, deletedAt: 0, updatedAt: 4 }
  const dto = sourceRefToDto(refRow)
  const back = sourceRefFromDto(dto)
  assert.equal(back.providerId, 'jira')
  assert.equal(back.externalId, 'ISSUE-9')
  assert.throws(() => sourceRefFromDto({ id: 'r-2', providerId: 'jira' }), /externalId required/)
  const link = sourceLinkFromDto(sourceLinkToDto({ id: 'l-1', taskId: 't-1', sourceRefId: 'r-1', deleted: 0, deletedAt: 0, updatedAt: 4 }))
  assert.deepEqual([link.taskId, link.sourceRefId], ['t-1', 'r-1'])
})

test('no device-private filesystem path field is ever emitted by the mappers', () => {
  const row = { id: 't-p', content: 'P', fileAttach: 'C:\\Users\\x\\secret.png', updatedAt: 1, deleted: 0, deletedAt: 0 }
  const json = JSON.stringify(taskToDto(row))
  assert.ok(!json.includes('secret.png'), 'local paths must not cross the wire')
})

// ---- G2 zone-2/zone-3 contract (v13, 2026-11-10): handoff targeting + actor provenance ----
test('task DTO carries handoff targeting fields and round-trips them', () => {
  const row = { id: 't-h', content: 'Handed off', updatedAt: 9, deleted: 0, deletedAt: 0, handoffTo: 'android-1', handoffFrom: 'win-b', handoffNote: 'context here', handoffAckedAt: 0 }
  const dto = taskToDto(row)
  assert.equal(dto.taskId, 't-h')
  assert.equal(dto.handoffTo, 'android-1')
  assert.equal(dto.handoffFrom, 'win-b')
  assert.equal(dto.handoffNote, 'context here')
  assert.equal(dto.handoffAckedAt, 0)
  const back = taskFromDto(dto)
  assert.equal(back.handoffTo, 'android-1')
  assert.equal(back.handoffAckedAt, 0)
})

test('task DTO omits handoff keys entirely when the row has none (old payloads stay byte-compatible)', () => {
  const dto = taskToDto({ id: 't-old', content: 'Plain', updatedAt: 1, deleted: 0, deletedAt: 0 })
  for (const k of ['handoffTo', 'handoffFrom', 'handoffNote', 'handoffAckedAt']) {
    assert.equal(Object.hasOwn(dto, k), false, `no fabricated ${k} key`)
  }
})

test('episode DTO carries actor provenance (actorType/role) and round-trips it', () => {
  const dto = episodeToDto({ id: 'e-ag', taskId: 't-h', startedAt: 1, endedAt: 0, note: 'working', actorType: 'agent', role: 'agent', deleted: 0, deletedAt: 0, updatedAt: 2 })
  assert.equal(dto.actorType, 'agent')
  assert.equal(dto.role, 'agent')
  const back = episodeFromDto(dto)
  assert.equal(back.actorType, 'agent')
  assert.equal(back.role, 'agent')
  const legacy = episodeToDto({ id: 'e-h', taskId: 't-h', startedAt: 1, endedAt: 2, note: '', deleted: 0, deletedAt: 0, updatedAt: 3 })
  assert.equal(Object.hasOwn(legacy, 'actorType'), false, 'human episodes carry no fabricated actor key')
})
