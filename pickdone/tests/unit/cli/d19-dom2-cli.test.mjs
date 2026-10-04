/* D19-DOM2 fixer round (domain 2: CLI ↔ App alignment) — regression tests.
 * Isolated temp DB via TODO_DB_DIR (never touches real data).
 * Covered findings:
 *   #1  HIGH  category soft-delete backs up + clears projectDocs:<id> (App parity
 *             renderer category.js backupThenClearProjectMeta — blob.docs + key delete)
 *   #2  SKIP  false positive: the App's EditPanel.applyDate(0) ALSO empties reminderExtra
 *             (offsetsCleared → next = []), so the CLI's clear shape is already App-exact.
 *             Pinned here so a future divergence is caught either way.
 *   #3  MED   reminder set on a dateless task backfills todoTime = startOf(reminder day)
 *             (EditPanel.onRemindersCommit parity) — helper + real `edit` subprocess
 *   #4  MED   CLI listing is App display order: taskSort DESC within a day (sort-core contract)
 *   #5  MED   settings set todoBoxCategoryId -1 accepted (App shipped default = all-categories)
 *   #6  MED   settings get/list report effective defaults (unset tomatoTime → 25)
 *   #7  LOW   --force bypasses the operator allowlist (schemaV) but NOT machine-local keys
 *   #8  LOW   db-rows rowToCategory maps deletedAt (round-trip with categoryToRow's stamp)
 *   #10 LOW   attachment row `name` keeps the RAW basename (App saveAttachment parity)
 *   #11 MED   view/project fetch ceiling raised 500/100 → 5000 (listTodos clamp follows)
 * Run: node --test tests/unit/cli/d19-dom2-cli.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'module'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-cli-d19dom2-')
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const { rowToCategory } = require_('../../../src/main/db-rows.js')
const core = require_('../../../src/main/core/todo-core.js')
const dayjs = require_('dayjs')

db.init(process.env.TODO_DB_DIR)
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..')

let _seq = 0
function seed (over = {}) {
  const now = Date.now() + (_seq++)
  const t = {
    complete: false, createTime: now, delete: false,
    reminderTime: 0, reminderOffsets: [], reminderExtra: [], estimate: 0, difficulty: 0,
    repeatId: null, subtasks: null, image: null, files: null,
    categoryId: 0, updateTime: now, syncTime: 0,
    taskContent: 'd19任务', taskDescribe: '',
    taskSort: 0, todoTime: 0, userId: 1, status: 'add', version: 0, ...over
  }
  if (!t.taskId) t.taskId = core.genTaskId(1, now)
  db.call('upsert', t)
  return db.call('getById', t.taskId)
}

/* ---------- #1: category delete backs up + clears projectDocs ---------- */
test('#1 deleteCategory backs projectDocs into catProjectMetaBak and clears the live key', () => {
  const cat = lib.addCategory('DocsProjD19')
  const id = String(cat.categoryId)
  db.call('setMeta', ['projectDocs:' + id, JSON.stringify([{ id: 'd1', title: 'PRD' }])])
  db.call('setMeta', ['projectCategoryFlag:' + id, '1'])
  lib.deleteCategory('DocsProjD19')
  const bak = JSON.parse(db.call('getMeta', 'catProjectMetaBak.' + id))
  assert.equal(bak.docs, JSON.stringify([{ id: 'd1', title: 'PRD' }]), 'docs ride the backup blob (App parity blob.docs)')
  assert.equal(bak.flag, true)
  assert.ok(db.call('getMeta', 'projectDocs:' + id) == null, 'live projectDocs key is cleared on soft-delete (purge would otherwise hard-delete it irreversibly)')
})

/* ---------- #2 pinned as skipped (false positive): applyDate(0) clears extras on BOTH ends ---------- */
test('#2 SKIP note: clearTodoDate keeps the App-exact shape (extras die with offsetsCleared)', () => {
  const t = seed({ taskContent: 'd19清日期', todoTime: +dayjs().add(1, 'day').startOf('day'),
    reminderTime: +dayjs().add(1, 'day').hour(9), reminderExtra: [+dayjs().add(2, 'day').hour(10)] })
  const after = lib.clearTodoDate(t.taskId).task
  assert.equal(after.todoTime, 0)
  assert.equal(after.reminderTime, 0)
  assert.deepEqual(after.reminderOffsets, [])
  assert.deepEqual(after.reminderExtra, [], 'matches EditPanel.applyDate(0): offsetsCleared empties extras (finding #2 premise was stale)')
})

/* ---------- #3: reminder on a dateless task backfills the date ---------- */
test('#3 reminderDateBackfill backfills todoTime = startOf(reminder day) for dateless tasks', () => {
  const rem = +dayjs().add(3, 'day').hour(14).minute(30)
  // helper contract: dateless → backfill; explicit date wins; already-dated row untouched
  assert.equal(lib.reminderDateBackfill({ todoTime: 0 }, { reminderTime: rem }).todoTime, +dayjs(rem).startOf('day'))
  assert.equal(lib.reminderDateBackfill({ todoTime: 123 }, { reminderTime: rem }).todoTime, undefined, 'dated task is untouched')
  assert.equal(lib.reminderDateBackfill({ todoTime: 0 }, { reminderTime: rem, todoTime: 456 }).todoTime, 456, 'explicit --date on the same command wins')
  assert.equal(lib.reminderDateBackfill({ todoTime: 0 }, {}).todoTime, undefined, 'no reminder → no backfill')
})

test('#3 edit --reminder on a dateless task persists the backfilled todoTime (subprocess)', () => {
  const t = seed({ taskContent: 'd19无日期提醒' })
  const rem = dayjs().add(4, 'day').hour(9).minute(15).format('YYYY-MM-DD HH:mm')
  const out = JSON.parse(execFileSync(process.execPath,
    [path.join(ROOT, 'cli', 'pickdone.js'), 'edit', t.taskId, '--reminder', rem, '--json'],
    { encoding: 'utf8', env: { ...process.env }, timeout: 120000 }))
  assert.equal(out.ok, true)
  const row = db.call('getById', t.taskId)
  assert.equal(row.todoTime, +dayjs(lib.parseDate(rem)).startOf('day'), 'date backfilled to the reminder day (EditPanel.onRemindersCommit)')
  assert.equal(row.dayStart, +dayjs(lib.parseDate(rem)).startOf('day'))
})

/* ---------- #4: listing is App display order (taskSort DESC within a day) ---------- */
test('#4 liveTasks/listTodos order taskSort DESC within a day (sort-core display contract)', () => {
  const day = +dayjs().add(9, 'day').startOf('day')
  const lo = seed({ taskContent: 'd19底', taskSort: 100, todoTime: day, dayStart: day })
  const hi = seed({ taskContent: 'd19顶', taskSort: 900, todoTime: day, dayStart: day })
  const ordered = lib.liveTasks().filter(x => x.dayStart === day)
  assert.deepEqual(ordered.map(x => x.taskId), [hi.taskId, lo.taskId], 'higher taskSort renders first (App sortMode custom: b.taskSort - a.taskSort)')
  const listed = lib.listTodos({}).filter(x => x.dayStart === day)
  assert.deepEqual(listed.map(x => x.taskId), [hi.taskId, lo.taskId])
})

/* ---------- #5: todoBoxCategoryId accepts the shipped default -1 ---------- */
test('#5 settings set todoBoxCategoryId -1 is accepted (allowNegative manifest domain)', () => {
  const r = lib.settingsSet('todoBoxCategoryId', '-1')
  assert.equal(r.value, -1)
  // a genuinely out-of-domain negative stays rejected
  assert.throws(() => lib.settingsSet('tomatoTime', '-25'), e => e.code === 'USAGE')
  assert.throws(() => lib.settingsSet('newTodoCategoryId', '-1'), e => e.code === 'USAGE', 'only manifest allowNegative keys are exempt')
})

/* ---------- #6: effective defaults in settings list/get ---------- */
test('#6 settingsList reports effective defaults for unset keys (tomatoTime → 25)', () => {
  const rows = lib.settingsList()
  const tomato = rows.find(r => r.key === 'tomatoTime')
  assert.equal(tomato.value, 25, 'unset tomatoTime reports the App default 25, not null')
  const box = rows.find(r => r.key === 'todoBoxCategoryId')
  assert.equal(box.value, -1, 'unset todoBoxCategoryId reports the shipped -1 (all-categories)')
  // an explicitly-set value still wins over the default
  lib.settingsSet('tomatoTime', '30')
  assert.equal(lib.settingsList().find(r => r.key === 'tomatoTime').value, 30)
})

/* ---------- #7: --force bypasses the operator allowlist for manifest-declared machine-local keys ---------- */
test('#7 --force unwedges manifest-known machine-local keys; schemaV + secrets stay denied', () => {
  assert.throws(() => lib.settingsSet('enableSecurityLock', 'false'), e => e.code === 'DENIED_KEY', 'without force the allowlist gate holds')
  const r = lib.settingsSet('enableSecurityLock', 'false', { force: true })
  assert.equal(r.value, false, 'force bypasses the allowlist for a manifest-declared machine-local key (full validation still applied)')
  assert.throws(() => lib.settingsSet('schemaV', '2', { force: true }), e => e.code === 'DENIED_KEY', 'schemaV bookkeeping stays denied even under force')
  assert.throws(() => lib.settingsSet('securityLockPassword', 'x', { force: true }), e => e.code === 'DENIED_KEY', 'secret family is NOT bypassable (no manifest declaration)')
  // force does NOT waive validation: an unknown key is still UNKNOWN_KEY under force
  assert.throws(() => lib.settingsSet('no_such_key', '1', { force: true }), e => e.code === 'UNKNOWN_KEY')
})

/* ---------- #8: rowToCategory maps deletedAt (write-only no more) ---------- */
test('#8 rowToCategory carries deletedAt through the read path', () => {
  const stamped = { id: 990001, userId: 840001, name: 'd19tomb', color: null, createdAt: 1, sort: 1, isFolder: 0, parentId: 0, deleted: 1, deletedAt: 1727856000000 }
  const obj = rowToCategory(stamped)
  assert.equal(obj.deletedAt, 1727856000000, 'tombstone stamp survives the row→app mapping (recover aging / 30-day GC)')
  assert.equal(rowToCategory({ ...stamped, deletedAt: null }).deletedAt, 0, 'absent stamp maps to 0, same as categoryToRow writes')
})

/* ---------- #10: attachment name keeps the raw basename ---------- */
test('#10 addAttachment persists the raw basename in `name` (App saveAttachment parity)', () => {
  const t = seed({ taskContent: 'd19附件' })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd19-att-'))
  // trailing dots/spaces cannot exist in a Windows filename — the observable contract on this
  // platform is that the stored name equals path.basename(file) verbatim (the App persists the
  // raw name; the stripped form is only used for validation + the on-disk key)
  const file = path.join(dir, 'my notes.v2.png')
  fs.writeFileSync(file, 'pngdata')
  const r = lib.addAttachment(t.taskId, file)
  assert.equal(r.name, 'my notes.v2.png', 'raw basename stored, not a re-derived/stripped variant')
  const list = JSON.parse(db.call('getById', t.taskId).image)
  assert.equal(list[list.length - 1].name, 'my notes.v2.png')
  assert.ok(list[list.length - 1].url.startsWith('local://'))
})

/* ---------- #11: view/project fetch ceiling 500 → 5000 ---------- */
test('#11 listTodos honors limits beyond the old 500 clamp (>500 seeded tasks all returned)', () => {
  const day = +dayjs().add(20, 'day').startOf('day')
  const made = []
  for (let i = 0; i < 510; i++) made.push(seed({ taskContent: 'd19cap' + i, todoTime: day, dayStart: day, taskSort: i }))
  const got = lib.listTodos({ limit: 5000 }).filter(x => x.dayStart === day)
  assert.equal(got.length, 510, 'raised clamp: all 510 matching tasks returned (old clamp truncated at 500)')
  assert.equal(lib.viewFetchOpts({}).limit, 5000, 'viewFetchOpts ceiling raised to 5000')
})
