/* upsertMany non-array guard (src/main/db.js) — list=null used to run the guard's
   fallback empty-array forEach (passing vacuously) and then TypeError on list.map,
   instead of failing with a clear USAGE-style error like assertHasTaskId does. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upsertmany-guard-'))
db.init(dir)

test('upsertMany: null list throws a clear usage error (not a TypeError)', () => {
  assert.throws(() => db.call('upsertMany', null), e => /list must be an array/.test(e.message))
})

test('upsertMany: undefined/non-array list throws a clear usage error', () => {
  assert.throws(() => db.call('upsertMany', undefined), e => /list must be an array/.test(e.message))
  assert.throws(() => db.call('upsertMany', {}), e => /list must be an array/.test(e.message))
})

test('upsertMany: valid array still works; missing taskId still fail-fast', () => {
  const t = { taskId: 'upm_ok', taskContent: 'x', categoryId: null, complete: false, delete: false }
  assert.equal(db.call('upsertMany', [t]), true)
  assert.throws(() => db.call('upsertMany', [{ taskContent: 'no id' }]), e => /taskId is required/.test(e.message))
})
