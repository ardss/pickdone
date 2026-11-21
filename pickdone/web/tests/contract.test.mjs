import test from 'node:test'
import assert from 'node:assert/strict'
import { backupData, validateBackup, todayKey, dateInput, dayKey, newTask, newProject, newEpisode, episodeView } from '../src/storage.js'

test('task and project rows match desktop contract fields', () => {
  const task = newTask('  Write plan  ', 3, 20261107)
  assert.equal(task.content, 'Write plan')
  assert.equal(task.categoryId, 3)
  assert.equal(task.scheduledDay, 20261107)
  assert.equal(task.deleted, 0)
  assert.equal(task.version, 0)
  assert.equal(typeof task.id, 'string')
  const project = newProject('  Research ', [{ id: 3 }])
  assert.equal(project.id, 4)
  assert.equal(project.name, 'Research')
  assert.equal(project.isFolder, 0)
  assert.equal(project.deletedAt, 0)
})
test('episode storage aliases do not replace contract fields', () => {
  const row = newEpisode('task-1', ' Notes ', 10, 20)
  const view = episodeView(row)
  assert.equal(row.note, 'Notes')
  assert.equal(view.summary, row.note)
  assert.equal(view.episodeId, row.id)
  assert.equal(view.deletedAt, 0)
})
test('backup includes tombstones and validates collections', () => {
  const rows = { tasks: [{ ...newTask('Done'), deleted: 1, deletedAt: 12, unknownOptional: 'keep' }], projects: [], episodes: [] }
  const backup = backupData(rows)
  assert.equal(validateBackup(backup).tasks[0].unknownOptional, 'keep')
  assert.equal(backup.tasks[0].deletedAt, 12)
  assert.throws(() => validateBackup({ ...backup, episodes: null }))
})
test('local date key round trips', () => {
  assert.equal(dayKey(dateInput(20261107)), 20261107)
  assert.equal(todayKey(new Date(2026, 10, 7)), 20261107)
})

test('desktop boundary maps project categories and metadata flags', async () => {
  const { desktopSnapshot } = await import('../src/storage.js')
  const task = newTask('A', 5)
  const project = { ...newProject('P', [{ id: 4 }]), id: 5 }
  const episode = newEpisode(task.id, 'N', 1, 2)
  const dto = desktopSnapshot({ tasks: [task], projects: [project], episodes: [episode] })
  assert.equal(dto.todos[0].id, task.id)
  assert.equal(dto.todos[0].content, 'A')
  assert.equal(dto.categories[0].id, 5)
  assert.deepEqual(dto.meta, [{ key: 'projectCategoryFlag:5', value: '1' }])
  assert.equal(dto.work_episodes[0].note, 'N')
  assert.equal(dto.work_episodes[0].id, episode.id)
})
