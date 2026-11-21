/** Data-loss class fixes (2026-11-21 audit) — four "same name, different behaviour" pairs.
 *
 *  1. Tombstone stamps: plan chips / tomato ledger / episode family each hand-copied the rule
 *     "the peer's deletion time wins, else local now". Two copies disagreed on `deletedAt: "0"`
 *     (truthy string vs "not > 0"), so the same tombstone landed with a different LWW age
 *     depending on which table it hit. One rule lives in src/main/tombstone.js now.
 *  2. Corrupt reminders column: JSON.parse failure read as "this task has no reminders", and the
 *     next ordinary edit re-packed that empty set as NULL — an unreadable column became a real
 *     deletion, then synced to every peer. rowToTodo now keeps the raw value, todoToRow writes it
 *     back until the caller supplies reminders of their own.
 *  3. Attachment unlink on an unread row set: fail-open meant a transient dbm error skipped the
 *     shared-reference check and deleted a file another task still pointed at. Now fail-closed.
 *
 *  Run: node --test tests/unit/main/dataloss-guards-20261121.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)
const { tombstoneStamps, tombstoneId } = require_('../../../src/main/tombstone.js')
const { rowToTodo, todoToRow, parseReminders } = require_('../../../src/main/db-rows.js')

/* ---------- 1. one tombstone rule ---------- */

test('tombstone: a peer stamp wins, but only when it is a positive epoch-ms', () => {
  const fallback = { deletedAt: 1000, updatedAt: null }
  assert.equal(tombstoneStamps({ deletedAt: 5000 }, fallback).deletedAt, 5000, 'peer deletedAt wins')
  assert.equal(tombstoneStamps({ deletedAt: 5000 }, fallback).updatedAt, 5000, 'age follows the deletion when no updatedAt')
  assert.equal(tombstoneStamps({ deletedAt: 5000, updatedAt: 7000 }, fallback).updatedAt, 7000, 'peer updatedAt wins over that')
  // The edge the three copies disagreed on:
  for (const junk of ['0', 0, -5, '-5', '', null, undefined, NaN, 'not-a-date']) {
    const st = tombstoneStamps({ deletedAt: junk, updatedAt: junk }, fallback)
    assert.equal(st.deletedAt, 1000, 'junk deletedAt ' + JSON.stringify(junk) + ' falls back to the local stamp')
    assert.equal(st.updatedAt, 1000, 'and so does junk updatedAt')
  }
  assert.equal(tombstoneStamps({ deletedAt: '5000' }, fallback).deletedAt, 5000, 'a numeric string is still a stamp')
  assert.equal(tombstoneStamps('id-only', fallback).deletedAt, 1000, 'a plain id carries no stamp')
})

test('tombstone: ids come from the item, and an object without one is skipped instead of writing "undefined"', () => {
  assert.equal(tombstoneId('abc'), 'abc', 'plain id')
  assert.equal(tombstoneId({ id: 'x1' }), 'x1', 'default key')
  assert.equal(tombstoneId({ tomatoId: 't9', id: 'x1' }, 'tomatoId'), 't9', 'primary key wins')
  assert.equal(tombstoneId({ tomatoId: 't9', id: 'x1' }), 'x1', 'falls back to id')
  assert.equal(tombstoneId({ deletedAt: 5 }), null, 'no id at all -> caller skips it')
  assert.equal(tombstoneId(null), null)
})

/* ---------- 2. an unreadable reminders column is preserved, not deleted ---------- */

const CORRUPT = '{"offsets":[15],"legacy":true}' // a shape only some other version understands
const TODO_ROW = {
  id: 'task-1', content: 'standup', reminders: CORRUPT, remindAt: 0,
  imageUrls: null, fileAttach: null
}

test('reminders: a column we cannot parse is flagged, not silently reported as empty', () => {
  assert.equal(parseReminders(CORRUPT).corrupt, true, 'unknown object shape is flagged')
  assert.equal(parseReminders('not json at all').corrupt, true, 'unparseable JSON is flagged')
  assert.equal(parseReminders('[15,-30]').corrupt, undefined, 'the array shape is fine')
  assert.equal(parseReminders('{"o":[15],"x":[]}').corrupt, undefined, 'the object shape is fine')
  assert.equal(parseReminders(null).corrupt, undefined, 'NULL really does mean no reminders')
})

test('reminders: read -> edit -> write keeps the unreadable value instead of NULLing it', () => {
  const todo = rowToTodo(TODO_ROW)
  assert.deepEqual(todo.reminderOffsets, [], 'the UI sees no reminders (nothing readable)')
  assert.equal(todo.remindersRaw, CORRUPT, 'the raw column rides along so the write can restore it')
  const back = todoToRow({ ...todo, taskContent: 'standup (renamed)' }) // an unrelated edit
  assert.equal(back.reminders, CORRUPT, 'the column is NOT overwritten with NULL by an unrelated edit')
})

test('reminders: once the caller supplies reminders, their value is what gets stored', () => {
  const todo = rowToTodo(TODO_ROW)
  const back = todoToRow({ ...todo, reminderOffsets: [-10] })
  assert.equal(back.reminders, '[-10]', 'a real user edit replaces the unreadable value')
  const clearedThenUpdated = todoToRow({ ...rowToTodo({ ...TODO_ROW, remindAt: 123 }), reminderTime: 456 })
  assert.equal(clearedThenUpdated.reminders, CORRUPT, 'touching only the main reminder time is not an edit of the offsets')
})

/* ---------- 3. attachment unlink fails closed on an unreadable row set ---------- */

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-guard-'))
const Module = require_('module')
const origLoad = Module._load
Module._load = function (request, parent, isMain) {
  if (request === 'electron') return { app: { getPath: () => TMP, getVersion: () => '0.0.0-test' }, shell: { openPath: async () => '' } }
  return origLoad.call(this, request, parent, isMain)
}
process.on('exit', () => { Module._load = origLoad })
const attachmentHandlers = require_('../../../src/main/handlers/attachments.js')
const attachments = require_('../../../src/main/attachments.js')

const MAIN_WC = { id: 'main-wc' }
const eMain = { sender: MAIN_WC }
const makeApi = dbm => attachmentHandlers({
  isLocked: () => false,
  isSafeExternal: () => false,
  getMainWindow: () => ({ webContents: MAIN_WC, isDestroyed: () => false }),
  dbm
})

test('delete-file: an unreadable row set refuses the delete instead of unlinking unchecked', () => {
  const dir = attachments.attachDir()
  fs.mkdirSync(dir, { recursive: true })
  const name = 'a_1700000000000_shared.png'
  fs.writeFileSync(path.join(dir, name), 'bytes')
  const api = makeApi({ call: () => { throw new Error('database is locked') } })
  assert.throws(
    () => api['delete-file'](eMain, 'local://' + name),
    /could not verify other references/,
    'a transient db error must not become an unlink'
  )
  assert.equal(fs.existsSync(path.join(dir, name)), true, 'the file is still there')
})

test('delete-file: a reference from another row still refuses, and --force is the documented way out', () => {
  const dir = attachments.attachDir()
  fs.mkdirSync(dir, { recursive: true })
  const name = 'a_1700000000001_shared.png'
  fs.writeFileSync(path.join(dir, name), 'bytes')
  const rows = [{ taskId: 'b', files: JSON.stringify([{ url: 'local://' + name }]), image: null }]
  const api = makeApi({ call: () => rows })
  assert.throws(() => api['delete-file'](eMain, 'local://' + name), /still referenced by 1 other task row/, 'shared reference refuses')
  assert.equal(api['delete-file'](eMain, 'local://' + name, { force: true }), true, 'force bypasses on purpose')
  assert.equal(fs.existsSync(path.join(dir, name)), false, 'and then it really deletes')
})
