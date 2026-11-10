import 'fake-indexeddb/auto'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { openRepository } from '../src/repository.js'

async function storeRow(name, row) {
  const request = indexedDB.open('pickdone-mobile-v1', 1)
  const db = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(name, 'readwrite')
      transaction.objectStore(name).put(row)
      transaction.oncomplete = resolve
      transaction.onerror = () => reject(transaction.error)
    })
  } finally { db.close() }
}

async function readRow(name, id) {
  const request = indexedDB.open('pickdone-mobile-v1', 1)
  const db = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
  try {
    return await new Promise((resolve, reject) => {
      const transaction = db.transaction(name, 'readonly')
      const lookup = transaction.objectStore(name).get(id)
      lookup.onsuccess = () => resolve(lookup.result)
      lookup.onerror = () => reject(lookup.error)
    })
  } finally { db.close() }
}

test('editing imported task seed never resets its LWW age or version', async () => {
  const repo = await openRepository()
  const id = crypto.randomUUID()
  const stamp = Date.now() + 30_000
  await storeRow('todos', { id, content: 'Seed task', categoryId: 0, complete: 0, createdAt: stamp - 1000, updatedAt: stamp, version: 47, deleted: 0, deletedAt: 0 })
  const saved = await repo.saveTask({ id, content: 'Edited seed task' })
  assert.ok(saved.updatedAt > stamp)
  assert.equal(saved.version, 48)
  const reopened = await openRepository()
  assert.equal((await reopened.tasks()).find(task => task.id === id)?.version, 48)
})

test('desktop tombstones cannot be silently resurrected by local saves', async () => {
  const repo = await openRepository()
  const stamp = Date.now() + 30_000
  const taskId = crypto.randomUUID()
  const episodeId = crypto.randomUUID()
  const projectId = Math.floor(Math.random() * 1_000_000_000) + 100_000
  await storeRow('todos', { id: taskId, content: 'Deleted on desktop', updatedAt: stamp, version: 5, deleted: 1, deletedAt: stamp })
  await storeRow('categories', { id: projectId, name: 'Deleted project', updatedAt: stamp, deleted: 1, deletedAt: stamp })
  await storeRow('work_episodes', { id: episodeId, taskId, startedAt: 1000, endedAt: 2000, updatedAt: stamp, deleted: 1, deletedAt: stamp })
  await assert.rejects(repo.saveTask({ id: taskId, content: 'Stale edit' }), /deleted/i)
  await assert.rejects(repo.saveProject({ id: projectId, name: 'Stale project' }), /deleted/i)
  await assert.rejects(repo.saveEpisode({ id: episodeId, taskId, startedAt: 1000, endedAt: 2000 }), /deleted/i)
  assert.equal((await readRow('todos', taskId)).deleted, 1)
  assert.equal((await readRow('categories', projectId)).deleted, 1)
  assert.equal((await readRow('work_episodes', episodeId)).deleted, 1)
  const reopened = await openRepository()
  assert.equal((await reopened.tasks()).some(task => task.id === taskId), false)
  assert.equal((await reopened.projects()).some(project => project.id === projectId), false)
  assert.equal((await reopened.episodes()).some(episode => episode.id === episodeId), false)
})

test('legacy desktop todo delete flag is not rendered or edited as a live task', async () => {
  const repo = await openRepository()
  const id = crypto.randomUUID()
  await storeRow('todos', { id, content: 'Desktop tombstone', delete: 1, updateTime: Date.now(), deletedAt: Date.now(), version: 7 })
  assert.equal((await repo.tasks()).some(task => task.id === id), false)
  await assert.rejects(repo.saveTask({ id, content: 'Stale mobile copy' }), /deleted/i)
  assert.equal((await readRow('todos', id)).delete, 1)
})