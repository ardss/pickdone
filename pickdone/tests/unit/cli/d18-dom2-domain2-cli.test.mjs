/* D18-DOM2 fixer round (domain 2: CLI ↔ App alignment) — regression tests.
 * Isolated temp DB via TODO_DB_DIR (never touches real data).
 * Covered findings:
 *   #1  HIGH  subtask-driven parent completion renews the repeat chain (lib-subs checkSubtask →
 *             lib-repeat renewRepeatAfterComplete, App parity store/todo.js toggleComplete)
 *   #2  HIGH  `repeat off` single scope soft-deletes the instance (RepeatDeleteModal [A2 fix])
 *   #3  MED   `repeat off --all` also deletes completed instances (App deletes every live instance)
 *   #4  MED   fresh-DB newTodoDefaultSort fallback = 'top' (absent setting → top-insert)
 *   #5  MED   `add` honors settings.newTodoCategoryId when no --category (App addTodo parity)
 *   #6  MED   renewalCarryFields converged superset: attachments AND quadrant/extra
 *   #7  MED   `add` mints NO schedule chip (App addTodo creates none)
 *   #8  MED   category tombstones carry deletedAt; filter backup key is the stamped
 *             catFiltersBak.<deletedAt>.<id> shape (D15-B6 parity)
 *   #9  MED   CLI purge writes a best-effort pre-purge evt-purge-*.json snapshot
 *   #11 LOW   chip-cascade failure warns to stderr (source anchor)
 *   #12 LOW   undo-renewal removal row shape: delete:true + version 0 (renderer parity)
 * Run: node --test tests/unit/cli/d18-dom2-domain2-cli.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'module'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-cli-d18dom2-')
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const core = require_('../../../src/main/core/todo-core.js')
const dayjs = require_('dayjs')

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

/* ---------- #1: sub-check on the last instance of a repeating parent renews the chain ---------- */
test('#1 checkSubtask completing a repeating parent mints the next repeat instance', () => {
  const base = +dayjs().add(1, 'day').startOf('day')
  const tpl = seed({ taskContent: 'dom2子勾续链模板', todoTime: base })
  const r = lib.repeatOn(tpl.taskId, lib.buildRepeatRule({ type: 'daily', interval: 1 }), 3)
  const group = db.call('queryTodos', { deleted: 0, repeatId: r.rid }).sort((a, b) => a.dayStart - b.dayStart)
  const last = group[group.length - 1]
  db.call('upsert', { ...last, subtasks: JSON.stringify([{ text: '唯一子任务', checked: false }]) })
  const after = lib.checkSubtask(last.taskId, 1, true)
  assert.equal(after.complete, true, 'checking the last subtask completes the parent')
  assert.ok(after.renewed, 'sub-check parent completion must renew the repeat chain (App parity)')
  assert.equal(after.renewed.repeatId, r.rid)
  assert.equal(after.renewed.dayStart, last.dayStart + 86400000, 'next instance is one day after the completed last')
  // the renewed instance is live in the group
  const regroup = db.call('queryTodos', { deleted: 0, repeatId: r.rid })
  assert.ok(regroup.some(t => t.taskId === after.renewed.taskId), 'renewed instance persisted live')
})

/* ---------- #2: repeat off single scope = soft-delete + rule GC ---------- */
test('#2 repeatOff single soft-deletes the instance and GCs the rule when the group drains', () => {
  const base = +dayjs().add(2, 'day').startOf('day')
  const tpl = seed({ taskContent: 'dom2单删实例模板', todoTime: base })
  const r = lib.repeatOn(tpl.taskId, lib.buildRepeatRule({ type: 'daily', interval: 1 }), 2)
  const group = db.call('queryTodos', { deleted: 0, repeatId: r.rid }).sort((a, b) => a.dayStart - b.dayStart)
  const first = group.find(t => t.taskId !== tpl.taskId)
  // chip on the instance must follow the snapshot→clear cascade
  lib.planSet(first.taskId, '09:30')
  const out = lib.repeatOff(first.taskId, false)
  assert.equal(out.removed, 1)
  const row = db.call('getById', first.taskId)
  assert.equal(row.delete, true, 'single scope is a DELETE, not a detach (RepeatDeleteModal A2 fix)')
  assert.equal(row.version, 0, 'delete row resets version so sync re-sends it')
  assert.ok(row.deletedAt > 0, 'tombstone carries deletedAt')
  assert.equal(db.call('planAll', []).some(x => x.taskId === first.taskId), false, 'no orphan chips')
  // rule SURVIVES while live instances remain, and dies when the group drains
  assert.ok(db.call('getMeta', 'repeatRule:' + r.rid), 'rule kept while live instances remain')
  const rest = db.call('queryTodos', { deleted: 0, repeatId: r.rid })
  for (const x of rest) lib.repeatOff(x.taskId, false)
  assert.ok(db.call('getMeta', 'repeatRule:' + r.rid) == null, 'rule GCed once no live instances remain')
})

/* ---------- #3: repeat off --all deletes completed instances too + rule GC ---------- */
test('#3 repeatOff --all soft-deletes completed instances too, then removes the rule', () => {
  const base = +dayjs().add(3, 'day').startOf('day')
  const tpl = seed({ taskContent: 'dom2全解散模板', todoTime: base })
  const r = lib.repeatOn(tpl.taskId, lib.buildRepeatRule({ type: 'daily', interval: 1 }), 2)
  const group = db.call('queryTodos', { deleted: 0, repeatId: r.rid })
  // one future instance is already completed — the old predicate skipped it
  const doneOne = group.find(t => t.taskId !== tpl.taskId)
  db.call('upsert', { ...doneOne, complete: true, completedAt: Date.now() })
  const out = lib.repeatOff(tpl.taskId, true)
  const allRows = db.call('queryTodos', { deleted: 0, repeatId: r.rid })
  assert.equal(allRows.length, 0, 'no live instances remain (completed included)')
  for (const id of [tpl.taskId, doneOne.taskId, ...group.filter(t => t !== doneOne && t.taskId !== tpl.taskId).map(t => t.taskId)]) {
    const row = db.call('getById', id)
    assert.equal(row.delete, true, `instance ${id} soft-deleted`)
    assert.equal(row.version, 0, `instance ${id} version reset for sync`)
  }
  assert.equal(out.removed, group.length, 'all live instances counted (template + future, completed included)')
  assert.ok(db.call('getMeta', 'repeatRule:' + r.rid) == null, 'rule meta GCed')
})

/* ---------- #4: absent newTodoDefaultSort falls back to 'top' ---------- */
test('#4 fresh-DB default insert side is TOP (absent newTodoDefaultSort)', () => {
  db.call('setMeta', ['db.settingsState', JSON.stringify({ _savedAt: 1 })]) // doc without the key
  const day = +dayjs().add(5, 'day').startOf('day')
  const a = lib.addTodo({ content: 'dom2缺省排序甲', date: new Date(day).toISOString() })
  const b = lib.addTodo({ content: 'dom2缺省排序乙', date: new Date(day).toISOString() })
  assert.ok(b.taskSort > a.taskSort, 'absent setting → addToTop=true → later insert lands ABOVE (max+512)')
  // and an explicit 'bottom' setting still lands below (min-512)
  lib.settingsSet('newTodoDefaultSort', 'bottom')
  const c = lib.addTodo({ content: 'dom2缺省排序丙', date: new Date(day).toISOString() })
  assert.ok(c.taskSort < a.taskSort, 'explicit bottom → min-512 insert')
  lib.settingsSet('newTodoDefaultSort', 'top')
})

/* ---------- #5: add defaults to settings.newTodoCategoryId ---------- */
test('#5 add without --category uses settings.newTodoCategoryId; explicit --category wins; 0 setting stays unset', () => {
  const cat = db.call('getAllCategories').find(c => c.categoryName === 'dom2默认分类')
  const catId = cat ? cat.categoryId : null
  if (!catId) {
    const created = lib.addCategory('dom2默认分类')
    lib.settingsSet('newTodoCategoryId', String(created.categoryId))
  }
  const t1 = lib.addTodo({ content: 'dom2默认分类任务' })
  const settingId = Number(lib.settingsDoc().newTodoCategoryId)
  assert.ok(settingId > 0)
  assert.equal(t1.categoryId, settingId, 'no --category → settings.newTodoCategoryId')
  const t2 = lib.addTodo({ content: 'dom2显式分类任务', category: String(settingId) === String(settingId) ? 'dom2默认分类' : 'dom2默认分类' })
  assert.equal(t2.categoryId, settingId, 'explicit --category still resolves')
  lib.settingsSet('newTodoCategoryId', '0')
  const t3 = lib.addTodo({ content: 'dom2零设置任务' })
  assert.equal(t3.categoryId, 0, '0/absent setting behaves as unset (no NO_CATEGORIES throw)')
})

/* ---------- #6: renewalCarryFields converged superset ---------- */
test('#6 renewalCarryFields carries attachments AND quadrant/extra attributes (converged superset)', async () => {
  const { renewalCarryFields } = await import('../../../shared/repeat-core.mjs')
  const tpl = {
    reminderOffsets: [-300], reminderExtra: [{ at: 1000 }], difficulty: 2,
    priority: 3, deadlineTs: 12345, important: 1, urgent: 1,
    image: 'img://a.png', files: JSON.stringify([{ name: 'a.txt' }]), repeatId: 'repeat_x'
  }
  const carry = renewalCarryFields(tpl, { todoTime: 1, reminderTime: 2 })
  // quadrant/extra (the CLI half)
  assert.equal(carry.priority, 3)
  assert.equal(carry.deadlineTs, 12345)
  assert.equal(carry.important, 1)
  assert.equal(carry.urgent, 1)
  assert.deepEqual(carry.reminderExtra, [{ at: 1000 }])
  // attachments (the RepeatModal half) — files persist as the row's JSON string
  assert.equal(carry.image, 'img://a.png')
  assert.deepEqual(JSON.parse(carry.files), [{ name: 'a.txt' }])
  // defaults are stable (`t.x || 0` semantics) for a bare template
  const bare = renewalCarryFields({}, { todoTime: 0, reminderTime: 0 })
  assert.deepEqual([bare.priority, bare.deadlineTs, bare.important, bare.urgent, bare.image, bare.files], [0, 0, 0, 0, null, null])
  // the CLI renewal instance constructor passes them through (no hard null literals anymore)
  const base = +dayjs().add(4, 'day').startOf('day')
  const t = seed({
    taskContent: 'dom2携带集模板', todoTime: base, priority: 2, deadlineTs: 999, important: 1, urgent: 1,
    image: 'x.png', files: JSON.stringify([{ name: 'f.bin' }])
  })
  const nt = lib.buildRenewalInstance(t, { todoTime: base + 864e5, reminderTime: 0 }, {})
  assert.equal(nt.priority, 2); assert.equal(nt.deadlineTs, 999)
  assert.equal(nt.important, 1); assert.equal(nt.urgent, 1)
  assert.equal(nt.image, 'x.png', 'renewed instance keeps the template image')
  assert.equal(nt.files, JSON.stringify([{ name: 'f.bin' }]), 'renewed instance keeps the template files')
})

/* ---------- #7: add mints NO schedule chip ---------- */
test('#7 addTodo (timed date included) creates no plan chip', () => {
  const t = lib.addTodo({ content: 'dom2无芯片新增', date: '2026-10-20 09:00' })
  assert.ok(t.todoTime > 0)
  assert.equal(db.call('planAll', []).some(r => r.taskId === t.taskId), false, 'App addTodo parity: no add-time chip')
})

/* ---------- #8: category tombstones stamped + stamped filter backup key ---------- */
test('#8 deleteCategory stamps deletedAt on tombstones and writes the stamped catFiltersBak key', async () => {
  const src = fs.readFileSync(new URL('../../../renderer/js/store/category.js', import.meta.url), 'utf8')
  assert.ok(src.includes("catFiltersBakKeyTs = (deletedAt, id) => 'catFiltersBak.' + deletedAt + '.' + id"), 'App stamped key shape anchor')
  const cat = lib.addCategory('dom2章鱼分类')
  lib.settingsSet('newTodoCategoryId', '0')
  // give the category a saved filter referencing it (db-call door: filterUpsert; conds normalized by shared/filter-core)
  db.call('filterUpsert', { id: 4242, name: 'dom2过滤器', conds: { catId: cat.categoryId }, sort: 1 })
  lib.deleteCategory('dom2章鱼分类')
  // getAllCategories excludes tombstones — read the raw rows for the stamp assertions
  const after = db.call('categoriesAllRows', {}).find(c => c.id === cat.categoryId)
  assert.equal(after.deleted, 1)
  assert.ok(after.deletedAt > 0, 'tombstone carries deletedAt (D15-B6 parity)')
  const stampedKey = 'catFiltersBak.' + after.deletedAt + '.' + cat.categoryId
  const bak = db.call('getMeta', stampedKey)
  assert.ok(bak, 'stamped catFiltersBak.<deletedAt>.<id> backup key written')
  const parsed = JSON.parse(bak)
  assert.ok(Array.isArray(parsed) && parsed.some(f => f.id === 4242), 'doomed filter backed up under the stamped key')
  assert.ok(db.call('getMeta', 'catFiltersBak.' + cat.categoryId) == null, 'legacy unstamped key no longer written')
})

/* ---------- #9: purge writes a best-effort pre-purge event snapshot ---------- */
test('#9 purgeRecycleBin writes evt-purge-*.json into the backup dir before deleting', () => {
  const t = seed({ taskContent: 'dom2快照清除', delete: true, deletedAt: Date.now() - 1 })
  const dir = path.join(process.env.TODO_DB_DIR, 'backups')
  lib.purgeRecycleBin()
  const files = fs.readdirSync(dir).filter(f => /^evt-purge-/.test(f) && f.endsWith('.json'))
  assert.ok(files.length >= 1, 'pre-purge snapshot written')
  const dump = JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'))
  assert.equal(dump.backup.source, 'cli-purge')
  assert.ok(Array.isArray(dump.backup.purgedRows) && dump.backup.purgedRows.some(r => r.taskId === t.taskId), 'doomed rows captured')
  // rolling keep: at most 10 evt-* snapshots retained
  const { EVT_KEEP } = require_('../../../cli/lib-eventbackup.cjs')
  const all = fs.readdirSync(dir).filter(f => /^evt-/.test(f))
  assert.ok(all.length <= EVT_KEEP)
})

/* ---------- #11: chip-cascade failure warns to stderr (source anchor) ---------- */
test('#11 chipsSnapshotForDelete failure path warns with the task id', () => {
  const src = fs.readFileSync(new URL('../../../cli/lib.js', import.meta.url), 'utf8')
  assert.ok(/chip snapshot\/cascade failed for task \$\{taskId\}/.test(src), 'stderr warn names the task id')
  assert.ok(!/catch \{ \/\* snapshot failure must not block deletion \*\/ \}/.test(src), 'silent bare catch retired')
})

/* ---------- #12: undo-renewal removal row shape (delete:true + version 0) ---------- */
test('#12 undo of a renewed completion removes the instance with the renderer row shape', () => {
  const base = +dayjs().add(6, 'day').startOf('day')
  const tpl = seed({ taskContent: 'dom2撤销形状模板', todoTime: base })
  const r = lib.repeatOn(tpl.taskId, lib.buildRepeatRule({ type: 'daily', interval: 1 }), 1)
  lib.toggleComplete(tpl.taskId, true)
  const renewed = db.call('queryTodos', { deleted: 0, repeatId: r.rid }).sort((a, b) => a.dayStart - b.dayStart).pop()
  assert.ok(renewed && renewed.dayStart === base + 864e5)
  lib.toggleComplete(tpl.taskId, false) // undo → auto-renewed instance removed
  const row = db.call('getById', renewed.taskId)
  assert.equal(row.delete, true, 'boolean delete:true (renderer deleteTodo/deleteTodosMany parity)')
  assert.equal(row.version, 0, 'version 0 so the soft delete re-enters the sync snapshot')
  assert.ok(row.deletedAt > 0)
})
