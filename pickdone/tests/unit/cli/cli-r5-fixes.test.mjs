/** CLI round-5 daily maintenance (2026-09-11) — fixes verified in this file:
 *  1. `batch date` now re-anchors reminders exactly like `edit --date` (shared lib.dateChangeReminderPatch,
 *     EditPanel.applyDate parity) — batch used to patch todoTime bare and leave the main reminder on the old day.
 *  2. settings manifest: newTodoCategoryId / todoBoxCategoryId declared (and coerced on write) as numbers —
 *     the App stores them as numbers and filters with strict equality; the CLI's string declaration made every
 *     `settings set` write a "5" string that silently failed all render-side equality filters.
 *  3. purge removes planChipsSnapshot:<id> meta for every purged row (parity with the App's purge path).
 *  4. CLI open() runs the tomatoMigrateFromMeta sentinel before any read/write — a CLI-only session after the
 *     ledger upgrade used to read an empty ledger, and a CLI backfill landing rows first made the migration guard
 *     discard the old meta-blob ledger forever.
 *  5. resolveTask default pool is live-only; a unique recycle-bin hit still resolves (keeps existing keyword
 *     workflows alive) but emits an explicit stderr warning.
 *  6. deleteCategory clears projectStatus:<id> meta along with the project flag/deadline cleanup.
 *  Isolated temp DB via TODO_DB_DIR, never touches real data (unit-cli-v03/v04 pattern).
 *  Run: node --test tests/cli-r5-fixes.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-r5-'))
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const core = require_('../../../src/main/core/todo-core.js')
const dayjs = require_('dayjs')

db.init(process.env.TODO_DB_DIR)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(ROOT, 'cli', 'pickdone.js')
const runCli = args => JSON.parse(execFileSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' }))

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

const at = (dayOffset, h, m) => +dayjs().add(dayOffset, 'day').hour(h).minute(m).second(0).millisecond(0)
const day0Of = ts => +dayjs(ts).startOf('day')

test('r5-1: batch date re-anchors the main reminder and shifts extras like edit --date', () => {
  const t = seed({
    taskContent: 'r5批量改期甲',
    todoTime: at(3, 9, 0),
    reminderTime: at(3, 8, 0),
    reminderExtra: [at(4, 10, 0), at(5, 14, 30)]
  })
  const r = lib.batchRun('date', [t.taskId], { to: '+5d' })
  assert.equal(r.failures.length, 0)
  const row = db.call('getById', t.taskId)
  const newDay0 = day0Of(row.todoTime)
  const shift = dayjs(newDay0).diff(day0Of(t.todoTime), 'day')
  assert.equal(shift, 2, 'sanity: +5d on a +3d task is a 2-day shift')
  assert.equal(row.reminderTime, +dayjs(newDay0).hour(8).minute(0).second(0).millisecond(0),
    'main reminder re-anchors to the new date at its original 08:00 (stayed on the old day before the fix)')
  assert.deepEqual(row.reminderExtra, [at(6, 10, 0), at(7, 14, 30)],
    'extra reminders shift by the same day-diff keeping their time-of-day')
})

test('r5-1b: batch date keeps a no-reminder task reminderless (shared helper emits nothing)', () => {
  const t = seed({ taskContent: 'r5批量改期乙', todoTime: at(2, 9, 0) })
  lib.batchRun('date', [t.taskId], { to: '+2d' })
  const row = db.call('getById', t.taskId)
  assert.equal(row.reminderTime, 0, 'no reminder before → no reminder after')
  assert.deepEqual(row.reminderExtra, [])
})

test('r5-2: category-id settings are numbers — manifest type and set() coercion', () => {
  const list = lib.settingsList()
  for (const key of ['newTodoCategoryId', 'todoBoxCategoryId']) {
    const row = list.find(r => r.key === key)
    assert.ok(row, key + ' still listed')
    assert.equal(row.type, 'number', key + ' declared number (was string — strict-equality filters broke)')
  }
  const r = lib.settingsSet('newTodoCategoryId', '42')
  assert.equal(r.value, 42, 'set() coerces to a real number, not "42"')
  assert.equal(typeof r.value, 'number')
  const doc = JSON.parse(db.call('getMeta', 'db.settingsState'))
  assert.equal(doc.newTodoCategoryId, 42)
  assert.equal(typeof doc.newTodoCategoryId, 'number', 'persisted doc holds a number')
})

test('r5-3: purge removes planChipsSnapshot meta for every purged row', () => {
  const t = seed({ taskContent: 'r5清空回收站' })
  db.call('planAddMany', [{ taskId: t.taskId, day: dayjs().format('YYYY-MM-DD'), mm: '09:00' }])
  lib.deleteTodo(t.taskId)
  const snapKey = 'planChipsSnapshot:' + t.taskId
  assert.ok(db.call('getMeta', snapKey), 'snapshot exists after delete (precondition)')
  lib.purgeRecycleBin()
  assert.equal(db.call('getMeta', snapKey), null, 'snapshot meta dies with the purged row')
})

test('r5-4: a fresh CLI session runs the tomato meta→ledger migration at open() before any write', () => {
  // Seed the OLD storage layout: ledger table empty, ledger living in the db.tomatoState meta blob
  const rec = {
    tomatoId: 'tmt_r5_migrate_1', endTime: +dayjs().startOf('day').hour(10),
    focus: 'r5迁移记录', focusTaskId: null, focusDuration: 25,
    rest: 0, restDuration: 0, succeed: true, status: 'local', manual: false
  }
  db.call('setMeta', ['db.tomatoState', JSON.stringify({ tomatoRecordList: [rec] })])
  // Child CLI process opens the same DB: its open() sentinel must migrate the blob BEFORE the read
  const out = runCli(['tomato', 'list', '--json'])
  assert.equal(out.ok, true)
  assert.ok(out.data.some(r => r && r.tomatoId === rec.tomatoId),
    'CLI read sees the migrated ledger row (used to read an empty ledger)')
  assert.equal(db.call('getMeta', 'db.tomatoState'), null,
    'blob deleted by the migration sentinel (absence = migrated marker; backfills can no longer orphan the old ledger)')
  assert.ok(db.call('tomatoAll').some(r => r.tomatoId === rec.tomatoId), 'row landed in the ledger table')
})

test('r5-5: resolveTask default pool is live-only; unique recycle-bin hit resolves with a warning', () => {
  const live = seed({ taskContent: 'r5在册任务' })
  const dead = seed({ taskContent: 'r5回收站任务' })
  lib.deleteTodo(dead.taskId)
  // live keyword still resolves normally
  assert.equal(lib.resolveTask('r5在册').taskId, live.taskId)
  // unique recycle-bin hit still resolves (existing keyword workflows kept) — warning goes to stderr (checked via CLI below)
  assert.equal(lib.resolveTask('r5回收站').taskId, dead.taskId)
  // restore (explicit recycle pool) keeps working untouched
  const restored = lib.restoreTodo(dead.taskId)
  assert.equal(restored.delete, false)
  // no match anywhere still throws
  assert.throws(() => lib.resolveTask('r5根本不存在'), /task not found/)
})

test('r5-5b: CLI get on a unique recycled hit emits the stderr warning', () => {
  const dead = seed({ taskContent: 'r5回收站警告任务' })
  lib.deleteTodo(dead.taskId)
  const res = require_('node:child_process').spawnSync(
    process.execPath, [cliPath, 'get', 'r5回收站警告', '--json'],
    { encoding: 'utf8', env: { ...process.env } })
  assert.equal(res.status, 0)
  JSON.parse(res.stdout) // stdout stays pure JSON (warning must be on stderr)
  assert.match(res.stderr, /recycle bin/, 'warning carried on stderr, not stdout')
})

test('r5-6: deleteCategory clears projectStatus meta with the other project keys', () => {
  const c = lib.addCategory('r5状态分类')
  db.call('setMeta', ['projectStatus:' + c.categoryId, 'paused'])
  db.call('setMeta', ['projectDeadline:' + c.categoryId, String(+dayjs().startOf('day'))])
  lib.deleteCategory(c.categoryId)
  assert.equal(db.call('getMeta', 'projectStatus:' + c.categoryId), null, 'stale status meta removed')
  assert.equal(db.call('getMeta', 'projectDeadline:' + c.categoryId), null)
})
