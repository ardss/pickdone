/** F1-round CLI fixes regression tests (pickdone/cli/lib.js / import.js), isolated temp DB via
 *  TODO_DB_DIR — never touches real data (f6-cli-round6-fixes pattern).
 *  Run: node --test tests/unit/cli/f1-round-cli-fixes.test.mjs */
import { test } from 'node:test'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { createRequire } from 'module'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-cli-f1-')
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const core = require_('../../../src/main/core/todo-core.js')
const imp = require_('../../../cli/import.js')

db.init(process.env.TODO_DB_DIR)

let _seq = 0
function seed (over = {}) {
  const now = Date.now() + (_seq++)
  const t = {
    complete: false, createTime: now, delete: false,
    reminderTime: 0, reminderOffsets: [], reminderExtra: [], estimate: 0, difficulty: 0,
    repeatId: null, subtasks: null, image: null, files: null,
    categoryId: 0, updateTime: now, syncTime: 0,
    taskContent: '任务', taskDescribe: '',
    taskSort: 0, todoTime: 0, userId: 1, status: 'add', version: 0, ...over
  }
  if (!t.taskId) t.taskId = core.genTaskId(1, now)
  db.call('upsert', t)
  return db.call('getById', t.taskId)
}

/* ---------- Fix 1: restore spends the one-shot chips snapshot only after the row write succeeds ---------- */
test('fix1: restoreTodo writes the row BEFORE consuming the snapshot (upsert failure keeps the snapshot spendable)', () => {
  const t = seed({ taskContent: 'f1快照任务', delete: true, deletedAt: Date.now(), status: 'delete' })
  const chips = [{ taskId: t.taskId, day: '2026-09-15', mm: '10:00' }]
  db.call('setMeta', ['planChipsSnapshot:' + t.taskId, JSON.stringify(chips)])
  // Force the upsert to throw (mid-way failure): the old first-line snapshot consumption permanently
  // destroyed the snapshot before the failure surfaced
  const origCall = db.call
  db.call = function (op, ...args) {
    if (op === 'upsert') throw new Error('simulated upsert failure')
    return origCall.call(db, op, ...args)
  }
  try {
    assert.throws(() => lib.restoreTodo('f1快照任务'), /simulated upsert failure/)
  } finally {
    db.call = origCall
  }
  const raw = db.call('getMeta', 'planChipsSnapshot:' + t.taskId)
  assert.ok(raw && raw.length, 'snapshot meta must survive a failed restore (old code consumed it first)')
  // Now a retry succeeds and backfills the chips
  const after = lib.restoreTodo('f1快照任务')
  assert.equal(after.delete, false)
  // Round-3 P1 (2026-09-21): the one-shot snapshot is now consumed with deleteMeta (a real
  // tombstone) instead of setMeta '' — a stale '' row could be misread as an (empty) snapshot
  // by a later task-id collision and never propagated the removal to peers.
  assert.equal(db.call('getMeta', 'planChipsSnapshot:' + t.taskId), null, 'successful restore consumes the one-shot snapshot')
  const backfilled = db.call('planAll', []).filter(r => r.taskId === t.taskId)
  assert.equal(backfilled.length, chips.length, 'chips are backfilled on the successful path')
})

/* ---------- Fix 4: deleteTodo resets version to 0 so a re-delete re-enters the sync snapshot ---------- */
test('fix4: deleteTodo writes version:0 (syncTodos excludes acked delete rows with version > 0)', () => {
  const t = seed({ taskContent: 'f1删除任务', version: 7 })
  const after = lib.deleteTodo(String(t.taskId))
  assert.equal(after.delete, true)
  assert.equal(after.version, 0, 'deleted row must carry version:0, matching renderer deleteTodo (store/todo.js)')
  assert.equal(after.status, 'delete')
})

/* ---------- Fix 5: removeAttachment collapses the key to a basename (path traversal) ---------- */
test('fix5: removeAttachment with a local://..%2F.. traversal key cannot delete files outside userData/files', () => {
  const t = seed({ taskContent: 'f1穿越任务' })
  const victimDir = isolatedTmpDir('f1-victim-')
  const victim = path.join(victimDir, 'db.key')
  fs.writeFileSync(victim, 'secret')
  // Row carries an encoded traversal key; removeAttachment must refuse to resolve it outside files/
  lib.patchTodo(t.taskId, { files: JSON.stringify([{ url: 'local://' + encodeURIComponent('../../' + path.basename(victimDir) + '/db.key'), name: 'db.key', size: 6 }]) }, { action: 'edit' })
  const res = lib.removeAttachment(String(t.taskId), 'file', 1)
  assert.equal(res.removed, 'db.key', 'the list entry itself is removed')
  assert.ok(fs.existsSync(victim), 'the file outside userData/files must survive')
  // Empty/unresolvable key is rejected instead of silently guessed
  lib.patchTodo(t.taskId, { files: JSON.stringify([{ url: '', name: 'ghost', size: 0 }]) }, { action: 'edit' })
  assert.throws(() => lib.removeAttachment(String(t.taskId), 'file', 1), e => e.code === 'ATTACH_KEY_INVALID')
  // A normal key still unlinks as before
  const dir = path.join(process.env.TODO_DB_DIR, 'files')
  fs.mkdirSync(dir, { recursive: true })
  const inside = path.join(dir, 'normal.txt')
  fs.writeFileSync(inside, 'x')
  lib.patchTodo(t.taskId, { files: JSON.stringify([{ url: 'local://' + encodeURIComponent('normal.txt'), name: 'normal.txt', size: 1 }]) }, { action: 'edit' })
  lib.removeAttachment(String(t.taskId), 'file', 1)
  assert.ok(!fs.existsSync(inside), 'a well-formed attachment key still unlinks the physical file')
})

/* ---------- Fix 6: addAttachment uses nextFreePath (no same-millisecond overwrite) ---------- */
test('fix6: addAttachment does not overwrite an existing same-name file (nextFreePath suffixing)', () => {
  const t = seed({ taskContent: 'f1附件任务' })
  const srcDir = isolatedTmpDir('f1-src-')
  const src = path.join(srcDir, 'note.txt')
  fs.writeFileSync(src, 'first')
  const first = lib.addAttachment(String(t.taskId), src)
  // Freeze the clock and pre-create the exact filename the second upload would produce (same-millisecond
  // same-name collision; the old `${Date.now()}_${name}` writeFileSync silently overwrote it)
  const filesDir = path.join(process.env.TODO_DB_DIR, 'files')
  const fixed = Date.now()
  const collision = path.join(filesDir, `${t.taskId}_${fixed}_note.txt`)
  fs.writeFileSync(collision, 'do-not-clobber')
  const origNow = Date.now
  Date.now = () => fixed
  let second
  try { second = lib.addAttachment(String(t.taskId), src) } finally { Date.now = origNow }
  assert.equal(second.name, 'note.txt')
  const listed = lib.listAttachments(String(t.taskId)).files
  const keys = listed.map(x => decodeURIComponent(x.url.replace(/^local:\/\//, '')))
  assert.ok(!keys.includes(path.basename(collision)), 'the pre-existing collision file is never silently reused/clobbered')
  assert.equal(fs.readFileSync(collision, 'utf8'), 'do-not-clobber', 'pre-existing file content untouched')
  assert.equal(listed.length, 2, 'both attachments land in the list with distinct files')
  assert.equal(new Set(keys).size, 2, 'stored keys are distinct')
  assert.equal(first.size, second.size)
})

/* ---------- Fix 3: dida/TickTick status -1 imports as completed ---------- */
test('fix3: dida365 completed rows (status -1) map to done, not open', () => {
  const csv = '任务清单\r\nTitle,List Name,Content,Tags,Status,Priority,Due Date,Start Date,Reminder,Completed Time,TaskId,ParentId\r\n' +
    '已完成甲,收件箱,,,-1,,,,,,\r\n' +
    '进行中乙,收件箱,,,0,,,,,,\r\n'
  const items = imp.rowsToItems(csv, 'dida365')
  assert.equal(items.length, 2)
  assert.equal(items[0].done, true, 'status -1 = completed (dida365 export dialect)')
  assert.equal(items[1].done, false, 'status 0 stays open')
})

/* ---------- Fix 2: CSV import tags column lands as #tag in taskContent ---------- */
test('fix2: imported rows carry the tags column as #tag suffixes in taskContent', () => {
  const csv = '任务清单\r\nTitle,List Name,Content,Tags,Status,Priority,Due Date,Start Date,Reminder,Completed Time,TaskId,ParentId\r\n' +
    '带标签任务,收件箱,,"工作,紧急",0,,,,,,,\r\n' +
    '无标签任务,收件箱,,,0,,,,,,,\r\n'
  const items = imp.rowsToItems(csv, 'dida365')
  const report = imp.importItems(items, { format: 'dida365', useLists: true })
  assert.equal(report.imported, 2)
  const all = lib.listTodos({ range: null, done: null, limit: 500 })
  const tagged = all.find(t => t.taskContent.startsWith('带标签任务'))
  assert.ok(tagged, 'tagged task imported')
  assert.ok(/带标签任务 #工作 #紧急/.test(tagged.taskContent), 'tags appended as #tag suffix (got: ' + tagged.taskContent + ')')
  const plain = all.find(t => t.taskContent === '无标签任务')
  assert.ok(plain, 'untagged task imports with a clean title (no trailing whitespace)')
  // tags are then discoverable via the app's own tag index (semantics: #tag in content)
  const tagNames = lib.listTags().map(x => x.name)
  assert.ok(tagNames.includes('工作') && tagNames.includes('紧急'), 'imported tags appear in listTags')
})
