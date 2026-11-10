import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openRepository } from '../src/repository.js'

test('task, project, completion and episode survive repository reopen', async () => {
  const first = await openRepository()
  const project = await first.saveProject({ name: 'Release' })
  const task = await first.saveTask({ content: 'Write notes', description: 'Draft', categoryId: project.id, scheduledDay: 20261107 })
  await first.saveTask({ ...task, content: 'Write release notes', complete: 1 })
  const episode = await first.saveEpisode({ taskId: task.id, startedAt: 1000, endedAt: 61000, note: 'Drafted outline' })
  const reopened = await openRepository()
  const projects = await reopened.projects()
  const tasks = await reopened.tasks()
  const episodes = await reopened.episodes()
  assert.equal(projects.find(item => item.id === project.id)?.name, 'Release')
  assert.equal(tasks.find(item => item.id === task.id)?.content, 'Write release notes')
  assert.equal(tasks.find(item => item.id === task.id)?.complete, 1)
  assert.equal(tasks.find(item => item.id === task.id)?.categoryId, project.id)
  assert.equal(episodes.find(item => item.id === episode.id)?.note, 'Drafted outline')
  assert.equal(episodes.find(item => item.id === episode.id)?.endedAt, 61000)
})