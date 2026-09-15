/* bumpSnow structured result (src/main/db.js) — changes=0 must name the reason
   ('missing' vs 'deleted') instead of a bare false that callers silently drop. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bumpsnow-structured-'))
db.init(dir)

const seed = over => Object.assign({
  taskId: 'bump_' + Math.random().toString(36).slice(2),
  taskContent: 'x', categoryId: null, complete: false, deleted: false
}, over)

test('bumpSnow: live task → { ok: true, minutes }', () => {
  const t = seed({})
  db.call('upsert', t)
  const r = db.call('bumpSnow', { taskId: t.taskId, minutes: 25 })
  assert.deepEqual(r, { ok: true, minutes: 25 })
})

test('bumpSnow: unknown task → { ok: false, reason: "missing" }', () => {
  const r = db.call('bumpSnow', { taskId: 'bump_none', minutes: 25 })
  assert.deepEqual(r, { ok: false, reason: 'missing' })
})

test('bumpSnow: soft-deleted task → { ok: false, reason: "deleted" }', () => {
  const t = seed({ delete: true })
  db.call('upsert', t)
  const r = db.call('bumpSnow', { taskId: t.taskId, minutes: 25 })
  assert.deepEqual(r, { ok: false, reason: 'deleted' })
})
