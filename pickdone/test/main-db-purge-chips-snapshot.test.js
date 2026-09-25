/* db-purge-planChipsSnapshot-meta (2026-09-26): purgeRecycleBin / purgeSeedTodos (and the
 * hardDelete family) deleted the todos + plan_chips rows but never the per-task
 * `planChipsSnapshot:<taskId>` meta keys the renderer mints for chip-restore — the keys leaked
 * in the meta table forever (asymmetric with the CLI purge, which deletes them for the same
 * taskId-collision reason). The DB layer now deletes the snapshot key inside the SAME delete
 * transaction. The main process is the only correct owner of this lifecycle: seed ids never go
 * through the renderer's bulk empty-bin path, and the DB-layer purged ids include rows the
 * renderer's recycleList may not contain.
 * Fresh temp DB via TODO_DB_DIR — the real %APPDATA% is never touched.
 * NOTE: pickdone/test/ is NOT auto-discovered by tests/run-all.mjs (tests/** + *.test.mjs only);
 * run this file directly: node --test test/main-db-purge-chips-snapshot.test.js */
'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chips-snap-purge-'))
process.env.TODO_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'chips-snap-purge-ud-'))

const db = require('../src/main/db.js')
db.init(fs.mkdtempSync(path.join(os.tmpdir(), 'chips-snap-purge-db-')))

const snap = (id, v) => db.call('setMeta', [`planChipsSnapshot:${id}`, v || JSON.stringify({ day: '2026-09-26', chips: [1] })])
const snapOf = id => db.call('getMeta', `planChipsSnapshot:${id}`)

function newTodo (id) {
  db.call('upsert', { taskId: id, taskContent: 'x-' + id, createTime: 1, updateTime: 1 })
}

test('purgeRecycleBin deletes the purged tasks planChipsSnapshot meta keys in the same transaction', () => {
  newTodo('snap_p1'); newTodo('snap_keep')
  snap('snap_p1'); snap('snap_keep')
  assert.ok(snapOf('snap_p1'), 'precondition: snapshot key exists')
  db.call('upsert', { taskId: 'snap_p1', delete: 1, deletedAt: 5 })
  db.call('purgeRecycleBin')
  assert.equal(snapOf('snap_p1'), null, 'THE FIX: the purged task\'s snapshot key is gone (leaked forever pre-fix)')
  assert.ok(snapOf('snap_keep'), 'live tasks keep their snapshot keys')
})

test('purgeSeedTodos deletes the seed tasks planChipsSnapshot meta keys (seed ids never cross the renderer clear path)', () => {
  newTodo('seed_snap1')
  snap('seed_snap1')
  db.call('purgeSeedTodos')
  assert.equal(snapOf('seed_snap1'), null, 'THE FIX: seed purge removes the snapshot key')
})

test('hardDelete / hardDeleteMany cascade the snapshot key too (chips already cascaded here)', () => {
  newTodo('snap_h1'); newTodo('snap_h2'); newTodo('snap_h3')
  snap('snap_h1'); snap('snap_h2'); snap('snap_h3')
  db.call('hardDelete', 'snap_h1')
  assert.equal(snapOf('snap_h1'), null, 'single hardDelete removes the snapshot key')
  db.call('hardDeleteMany', ['snap_h2', 'snap_h3'])
  assert.equal(snapOf('snap_h2'), null)
  assert.equal(snapOf('snap_h3'), null)
})
