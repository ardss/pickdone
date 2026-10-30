import test from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')

// W7-R coordination: the renderer's succeed->false compensation queues bumpSnow with dedupKey
// 'undo:<startedAt>' and a NEGATIVE delta; the server clamp used to Math.max(0,...) it into a
// silent no-op. db.js now grants the undo: prefix a negative-only clamp.
test('bumpSnow undo: prefix applies a negative-only compensation; plain keys stay positive-only', async () => {
  const os = (await import('node:os')).default
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w7-bumpundo-'))
  process.env.TODO_DB_DIR = dir
  try {
    const { pathToFileURL: p2u } = await import('node:url')
    const dbm = (await import(p2u(path.join(root, 'src/main/db.js')).href)).default ?? (await import(p2u(path.join(root, 'src/main/db.js')).href))

    dbm.init(dir)
    const tid = 'w7undo-' + Date.now().toString(36)
    dbm.call('upsert', { taskId: tid, taskContent: 'undo-bump seed', createTime: new Date().toISOString(), updateTime: new Date().toISOString(), estimate: 0 })
    const id = tid
    // credit +25 with a plain dedup key
    const c = dbm.call('bumpSnow', { taskId: id, minutes: 25, dedupKey: 'sess-1' })
    assert.equal(c.ok, true)
    // plain POSITIVE-only clamp: a negative delta with a non-undo key is still refused
    const refuse = dbm.call('bumpSnow', { taskId: id, minutes: -10, dedupKey: 'tamper' })
    assert.equal(refuse.ok, true)
    assert.equal(refuse.minutes, 0, 'non-undo negative delta clamps to a no-op')
    assert.equal(Number(dbm.call('getById', id).estimate), 25, 'tamper path changed nothing')
    // undo: compensation goes through
    const u = dbm.call('bumpSnow', { taskId: id, minutes: -25, dedupKey: 'undo:123' })
    assert.equal(u.ok, true)
    assert.equal(u.minutes, -25)
    assert.equal(Number(dbm.call('getById', id).estimate), 0, 'compensation reversed the credit')
    // undo: replay is deduped like any bump
    const u2 = dbm.call('bumpSnow', { taskId: id, minutes: -25, dedupKey: 'undo:123' })
    assert.equal(u2.deduped, true)
    assert.equal(Number(dbm.call('getById', id).estimate), 0, 'replay is a no-op')
    // undo: can never credit
    const up = dbm.call('bumpSnow', { taskId: id, minutes: 30, dedupKey: 'undo:456' })
    assert.equal(up.minutes, 0, 'undo: positive delta clamps to zero')
    assert.equal(Number(dbm.call('getById', id).estimate), 0)
  } finally {
    delete process.env.TODO_DB_DIR
  }
})
