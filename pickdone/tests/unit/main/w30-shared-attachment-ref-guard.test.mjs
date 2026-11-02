/* W30 (P2) shared-reference guard for batch/cascade attachment deletes — handlers/shared.js
   filterSharedAttachmentFiles + purgeAttachmentFiles opts.rows.
   The single delete-file channel refuses to unlink a local:// key another row still references
   (F2 2026-10-15), but delete-todo-files / delete-todo-files-many / hardDelete's file cascade /
   purgeAttachmentFiles unlinked purely by filename ownership — a copy-pasted or repeat-template-
   shared attachment died silently with the first purged owner while other rows still pointed at
   it (data loss). Regression: the batch twin guard keeps every referenced file. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const shared = require_('../../../src/main/handlers/shared.js')
const { filterSharedAttachmentFiles, purgeAttachmentFiles } = shared

const row = (taskId, urls, field = 'files') => ({ taskId, [field]: JSON.stringify(urls.map(u => ({ url: u }))) })
const KEY = 'a_1730000000000_shot.png'

test('filterSharedAttachmentFiles: a key referenced by a SURVIVING row is dropped from the candidates', () => {
  const files = [KEY, 'a_1730000000001_solo.png']
  const rows = [row('b', ['local://' + KEY])]
  const out = filterSharedAttachmentFiles(files, { rows, excludeIds: ['a'] })
  assert.deepEqual(out, ['a_1730000000001_solo.png'], 'shared key survives, private file still deleted')
})

test('filterSharedAttachmentFiles: the dying rows\' own references do NOT protect their files', () => {
  const files = [KEY]
  const rows = [row('a', ['local://' + KEY])]
  const out = filterSharedAttachmentFiles(files, { rows, excludeIds: ['a'] })
  assert.deepEqual(out, [KEY], 'only the dying task references it -> deletable')
})

test('filterSharedAttachmentFiles: tombstone rows count (recycle-bin restore is one click away)', () => {
  const files = [KEY]
  const rows = [{ taskId: 'b', deleted: true, files: JSON.stringify([{ url: 'local://' + KEY }]) }]
  const out = filterSharedAttachmentFiles(files, { rows, excludeIds: ['a'] })
  assert.deepEqual(out, [], 'a binned sharer still keeps the file')
})

test('filterSharedAttachmentFiles: rows=null fails open (candidates unchanged, legacy behavior)', () => {
  const files = [KEY]
  assert.deepEqual(filterSharedAttachmentFiles(files, { rows: null, excludeIds: ['a'] }), files)
  assert.deepEqual(filterSharedAttachmentFiles(files, {}), files)
})

test('filterSharedAttachmentFiles: image field and path-form/encoded local:// urls resolve like the serve boundary', () => {
  const files = ['a_1730000000002_img.png']
  const rows = [{ taskId: 'b', image: JSON.stringify([{ url: 'local:///a_1730000000002_img.png' }]), files: '[]' }]
  assert.deepEqual(filterSharedAttachmentFiles(files, { rows, excludeIds: ['a'] }), [])
})

test('purgeAttachmentFiles: shared file kept, private file removed, aliases prune failure tolerated', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w30-purge-guard-'))
  const sharedFile = path.join(dir, KEY)
  const privateFile = path.join(dir, 'a_1730000000009_private.png')
  fs.writeFileSync(sharedFile, 'x')
  fs.writeFileSync(privateFile, 'x')
  const attachDir = () => dir
  const rows = [row('b', ['local://' + KEY])]
  purgeAttachmentFiles(attachDir, ['a'], { rows })
  assert.equal(fs.existsSync(sharedFile), true, 'file still referenced by task b must survive task a purge')
  assert.equal(fs.existsSync(privateFile), false, 'task a private file must be removed')
})

test('purgeAttachmentFiles: without opts.rows the legacy unconditional unlink is preserved (fail-open)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w30-purge-legacy-'))
  const f = path.join(dir, KEY)
  fs.writeFileSync(f, 'x')
  purgeAttachmentFiles(() => dir, ['a'])
  assert.equal(fs.existsSync(f), false, 'legacy callers (no rows) keep the old behavior')
})
