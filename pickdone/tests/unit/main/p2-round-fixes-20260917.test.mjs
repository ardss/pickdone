/* Regression tests for the 2026-09-17 main-process DB / resource-domain fix round.
   Covers: bumpSnow dirty-flag + ghost-delta suppression, v6 corrupted-blob retry,
   filterUpsert no-op suppression, statsByDay null-bound sentinels, countAll deleted filter,
   _recToRow focusDuration lower bound, backup tmp cleanup, attachment prefix-ownership,
   protocol 200 Content-Length invariant.
   Run: node --test tests/unit/main/p2-round-fixes-20260917.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const { purgeAttachmentFiles, ownsAttachmentFile } = require_('../../../src/main/handlers/shared.js')
const { atomicWriteJson } = require_('../../../src/main/handlers/backup.js')
const { fileResponse } = require_('../../../src/main/protocol.js')

// ---------- db-backed fixes (shared fresh DB per group via unique ids) ----------
db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'p2round-0917-')))

const seed = over => Object.assign({
  taskId: 'r17_' + Math.random().toString(36).slice(2),
  taskContent: 'x', categoryId: null, complete: false, deleted: false
}, over)

test('bumpSnow marks the row dirty (status=update) so the cloud sync path sees focus deltas', () => {
  const t = seed({})
  db.call('upsert', t)
  db.call('commitSyncBatch', { rows: [{ ...t, status: 'sync' }], version: 1 })
  assert.equal(db.call('getById', t.taskId).status, 'sync')
  const r = db.call('bumpSnow', { taskId: t.taskId, minutes: 5 })
  assert.deepEqual(r, { ok: true, minutes: 5 })
  assert.equal(db.call('getById', t.taskId).status, 'update', 'bump must flag the row for the next sync snapshot')
  assert.equal(db.call('getById', t.taskId).estimate, 5)
})

test('bumpSnow on a missing task produces no oplog delta (ghost pointer suppression)', () => {
  const lastSeq = db.call('syncOplogSince', { sinceSeq: 0 }).pop()?.seq || 0
  const r = db.call('bumpSnow', { taskId: 'r17_ghost', minutes: 5 })
  assert.equal(r.ok, false)
  const rows = db.call('syncOplogSince', { sinceSeq: lastSeq })
  assert.equal(rows.filter(x => x.entity === 'todo').length, 0, 'failed bump must not append an oplog row')
})

test('v6 migration: corrupted settings blob keeps schemaVersion back so the migration retries', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r17-v6-'))
  db.close()
  db.init(dir)
  db.call('setMeta', ['db.settingsState', '{not-json'])
  db.call('setMeta', ['schemaVersion', '5'])
  db.close()
  // re-open: v6 must fail (return false) and NOT stamp schemaVersion=6
  db.init(dir)
  assert.equal(db.call('getMeta', 'schemaVersion'), '5', 'corrupted blob must block the version stamp (retry next boot)')
  // repair the blob and re-open: migration now succeeds and advances to v6
  db.call('setMeta', ['db.settingsState', JSON.stringify({ theme: 'dark' })])
  db.init(dir)
  assert.equal(db.call('getMeta', 'schemaVersion'), '6', 'repaired blob migrates on retry')
  const rows = db.call('settingsRowsAll').filter(r => r.key === 'theme')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].value, 'dark')
})

test('filterUpsert: identical re-save is a no-op (returns false, no oplog delta, updatedAt untouched)', () => {
  const id = db.call('filterUpsert', { name: 'Foo', conds: { catId: 3, priority: 1, dateMode: 'today' }, sort: 4 })
  const before = db.call('syncOplogSince', { sinceSeq: 0 }).pop()?.seq || 0
  const v1 = db.call('filterList').find(f => f.id === id)
  const r = db.call('filterUpsert', { id, name: 'Foo', conds: { catId: 3, priority: 1, dateMode: 'today' }, sort: 4 })
  assert.equal(r, false, 'identical re-save is a no-op')
  const rows = db.call('syncOplogSince', { sinceSeq: before })
  assert.equal(rows.length, 0, 'no-change filter save must not emit a delta')
  const v2 = db.call('filterList').find(f => f.id === id)
  assert.deepEqual(v2, v1)
  // a real change still writes and logs
  const id2 = db.call('filterUpsert', { id, name: 'Bar', conds: { catId: 3, priority: 1, dateMode: 'today' }, sort: 4 })
  assert.equal(id2, id)
  const last = db.call('syncOplogSince', { sinceSeq: before }).pop()
  assert.equal(last.entity, 'filter')
  assert.equal(String(last.entityId), String(id))
})

test('statsByDay: null bounds use open-ended sentinels instead of silent BETWEEN NULL', () => {
  const t = seed({ todoTime: Date.now(), complete: true, completedAt: Date.now() })
  db.call('upsert', t)
  const all = db.call('statsByDay', { from: null, to: null })
  const wide = db.call('statsByDay', { from: 20000101, to: 29991231 })
  assert.ok(all.rows.length > 0, 'null bounds must not silently return an empty set')
  assert.deepEqual(
    all.rows.map(r => [r.ds, Number(r.done), Number(r.total)]),
    wide.rows.map(r => [r.ds, Number(r.done), Number(r.total)]),
    'null bounds must be equivalent to an explicit full range')
  assert.deepEqual(all.doneByCompletionDay, wide.doneByCompletionDay)
})

test('countAll excludes recycle-bin rows (fresh-library check not polluted by tombstones)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r17-count-'))
  db.close(); db.init(dir)
  const t = seed({})
  db.call('upsert', t)
  db.call('upsert', seed({ taskId: t.taskId, delete: true }))
  assert.equal(db.call('countAll'), 0, 'a library holding only deleted rows counts as empty')
})

test('_recToRow focusDuration lower bound is 0 (no phantom minute for bad values)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r17-rec-'))
  db.close(); db.init(dir)
  db.call('tomatoAppendMany', [
    { tomatoId: 'r17a', endTime: 1700000000000, focusDuration: 0 },
    { tomatoId: 'r17b', endTime: 1700000001000, focusDuration: NaN },
    { tomatoId: 'r17c', endTime: 1700000002000, focusDuration: 'abc' }
  ])
  const recs = db.call('tomatoAll')
  for (const id of ['r17a', 'r17b', 'r17c']) {
    assert.equal(recs.find(r => r.tomatoId === id).focusDuration, 0, id + ' must store 0, not 1')
  }
})

// ---------- backup atomicWriteJson tmp cleanup ----------
test('atomicWriteJson cleans up the tmp file when write/rename fails', () => {
  const removed = []
  const failing = {
    writeFileSync () { throw new Error('disk full') },
    renameSync () { throw new Error('should not run') },
    existsSync: () => true,
    unlinkSync: p => removed.push(p)
  }
  const r = atomicWriteJson(failing, 'D:\\dir', 'auto-x.json', '{}')
  assert.equal(r.ok, false)
  assert.match(r.error, /disk full/)
  assert.equal(removed.length, 1)
  assert.match(String(removed[0]), /\.tmp-auto-x\.json$/)
  const ok = atomicWriteJson(fs, fs.mkdtempSync(path.join(os.tmpdir(), 'r17-bk-')), 'auto-y.json', '{}')
  assert.deepEqual(ok, { ok: true, file: 'auto-y.json' })
})

// ---------- attachment ownership (prefix ids) ----------
test('ownsAttachmentFile / purgeAttachmentFiles: prefix task id no longer eats the longer task files', () => {
  assert.equal(ownsAttachmentFile('a_b_1737000000000_note.png', 'a'), false, "'a' must not own 'a_b''s file")
  assert.equal(ownsAttachmentFile('a_1737000000000_note.png', 'a'), true)
  assert.equal(ownsAttachmentFile('seed_1_1737000000000_n.png', 'seed_1'), true, 'ids containing underscores still match')
  assert.equal(ownsAttachmentFile('noise-custom.mp3', 'a'), false)
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r17-att-'))
  for (const f of ['a_1737000000000_x.png', 'a_b_1737000000000_y.png']) fs.writeFileSync(path.join(dir, f), 'x')
  purgeAttachmentFiles(() => dir, ['a'])
  assert.ok(fs.existsSync(path.join(dir, 'a_b_1737000000000_y.png')), "purging 'a' must keep task 'a_b''s attachment")
  assert.ok(!fs.existsSync(path.join(dir, 'a_1737000000000_x.png')))
  purgeAttachmentFiles(() => dir, ['a_b'])
  assert.ok(!fs.existsSync(path.join(dir, 'a_b_1737000000000_y.png')))
})

// ---------- protocol 200 Content-Length invariant ----------
test('fileResponse 200: Content-Length equals the bytes actually read, not a stale stat', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r17-proto-'))
  const file = path.join(dir, 'f.bin')
  fs.writeFileSync(file, Buffer.alloc(1000, 7))
  const res = await fileResponse(file, 'application/octet-stream', { headers: {} })
  const body = Buffer.from(await res.arrayBuffer())
  assert.equal(res.status, 200)
  assert.equal(Number(res.headers.get('Content-Length')), body.length, 'header must match the delivered body')
  assert.equal(body.length, 1000)
  // 206 path still consistent
  const res2 = await fileResponse(file, 'application/octet-stream', { headers: { Range: 'bytes=0-9' } })
  const body2 = Buffer.from(await res2.arrayBuffer())
  assert.equal(res2.status, 206)
  assert.equal(Number(res2.headers.get('Content-Length')), body2.length)
})
