/** maint/d4 daily-maintenance regression tests (cli/lib.js behaviors).
 *  Covers:
 *   - settingsSet merge-on-fresh (old CAS guard compared two synchronous reads — pure theater);
 *     a concurrent App-side write in the race window must survive the CLI's single-key write
 *   - buildRepeatRule weekly honors --interval (was hardcoded 1)
 *   - repeatOn yearly anchors to the task's own date (was engine-default Jan 1)
 *   - repeatOff --all removes the rule via deleteMeta (was setMeta '')
 *   - importEvents hasRecord re-reads records (was a frozen pre-import snapshot)
 *   - addTodo places a timeline chip for natural-language timed dates like 明天9点 (and NOT for bare 明天)
 *  Run: node --test tests/unit/cli/d4-maint-cli-data.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { createRequire } from 'module'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-d4-cli-'))
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
    reminderTime: 0, reminderOffsets: [], estimate: 0, difficulty: 0,
    repeatId: null, subtasks: null, image: null, files: null,
    categoryId: 0, updateTime: now, syncTime: 0,
    taskContent: '任务', taskDescribe: '',
    taskSort: 0, todoTime: 0, userId: 1, status: 'add', version: 0, ...over
  }
  if (!t.taskId) t.taskId = core.genTaskId(1, now)
  db.call('upsert', t)
  return db.call('getById', t.taskId)
}

function readSettingsDoc () {
  try { return JSON.parse(db.call('getMeta', 'db.settingsState') || 'null') || {} } catch { return {} }
}

test('settingsSet merges the single key onto a FRESH doc (concurrent App write survives)', () => {
  // Seed a settings doc as if the App had written it
  const seedDoc = { themeExisting: 'app', _savedAt: 1700000000000, schemaV: 1 }
  db.call('setMeta', ['db.settingsState', JSON.stringify(seedDoc)])

  // Simulate the App writing settings INSIDE the race window (between settingsSet's first read and
  // its fresh re-read just before setMeta)
  lib.setSettingsRaceHookForTests(() => {
    const concurrent = readSettingsDoc()
    // B15 (2026-09-24): the write-back is a manifest whitelist rebuild — a concurrent App write can
    // only survive through a legit settings key (the old ad-hoc appConcurrencyKey was exactly the
    // dirty-key class B15 strips, so the fixture moved to a manifest key).
    concurrent.searchComplete = 'written-by-app'
    concurrent._savedAt = 1700000000001
    db.call('setMeta', ['db.settingsState', JSON.stringify(concurrent)])
  })

  const r = lib.settingsSet('maxRepeat', '7')
  assert.equal(r.value, '7')
  const final = readSettingsDoc()
  assert.equal(final.maxRepeat, '7', 'CLI key must land')
  assert.equal(final.searchComplete, 'written-by-app', 'concurrent App change must NOT be clobbered by the stale first read')
  lib.setSettingsRaceHookForTests(null)
})

test('buildRepeatRule weekly honors --interval', () => {
  const rule = lib.buildRepeatRule({ type: 'weekly', interval: '3', weekdays: '1,3' })
  assert.equal(rule.repeatType, 'week')
  assert.equal(rule.repeatInterval, 3, 'weekly --interval was hardcoded to 1 before the fix')
  assert.deepEqual(rule.repeatWeekDays, [1, 3])
  // daily/monthly still honor it (regression guard)
  assert.equal(lib.buildRepeatRule({ type: 'daily', interval: '2' }).repeatInterval, 2)
  assert.equal(lib.buildRepeatRule({ type: 'monthly', interval: '4' }).repeatInterval, 4)
})

test('repeatOn yearly anchors to the task date (May-20 task → May-20 instances)', () => {
  const base = +dayjs('2026-05-20 09:00:00')
  const t = seed({ taskContent: '年复五二零', todoTime: base })
  const r = lib.repeatOn(t.taskId, lib.buildRepeatRule({ type: 'yearly' }), 2)
  assert.ok(r.made >= 1, 'at least one future instance generated')
  const rule = JSON.parse(db.call('getMeta', 'repeatRule:' + r.rid))
  assert.equal(rule.repeatYearMonth, 5, 'rule anchored to the task month, not Jan')
  assert.equal(rule.repeatYearMonthDay, 20, 'rule anchored to the task day, not the 1st')
  const instances = db.call('queryTodos', { deleted: 0, repeatId: r.rid })
  assert.ok(instances.length >= 1)
  for (const inst of instances) {
    assert.equal(dayjs(inst.todoTime).format('MM-DD'), '05-20', 'instance lands on May-20, got ' + dayjs(inst.todoTime).format('MM-DD'))
  }
})

test('repeatOff --all removes the repeat rule via deleteMeta (no empty-string meta left)', () => {
  const base = +dayjs('2026-10-01 08:00:00')
  const t = seed({ taskContent: '年复解散', todoTime: base })
  const r = lib.repeatOn(t.taskId, lib.buildRepeatRule({ type: 'yearly' }), 1)
  lib.repeatOff(t.taskId, true)
  const stored = db.call('getMeta', 'repeatRule:' + r.rid)
  assert.ok(stored == null || stored === undefined, 'rule row must be deleted, got ' + JSON.stringify(stored))
})

test('importEvents hasRecord sees records created BY the import itself', async () => {
  const yesterday = dayjs().subtract(3, 'day').format('YYYY-MM-DD')
  const res = await lib.importEvents([
    { date: yesterday, start: '10:00', end: '11:00', title: 'D4导入唯一事件甲', estimate: 1 }
  ])
  assert.equal(res.created, 1)
  assert.equal(res.failed.length, 0)
  const created = db.call('queryTodos', { deleted: 0 }).find(x => x.taskContent === 'D4导入唯一事件甲')
  assert.ok(created, 'task created')
  assert.equal(res.hasRecord(created.taskId), true, 'hasRecord must re-read records — the import backfilled a manual row for this very task')
  assert.equal(res.hasRecord('no-such-task'), false)
})

test('addTodo derives a chip from natural-language timed dates; bare dates stay chip-less', () => {
  const timed = lib.addTodo({ content: 'D4自然语言时间任务', date: '明天9点' })
  const timedDay = dayjs(timed.todoTime).format('YYYY-MM-DD')
  const timedRow = lib.planList(timedDay).tasks.find(x => x.taskId === timed.taskId)
  assert.ok(timedRow, 'timed NL date must get a timeline chip')
  assert.ok(timedRow.chips.includes('09:00'), 'chip at 09:00, got ' + JSON.stringify(timedRow && timedRow.chips))

  const bare = lib.addTodo({ content: 'D4无时间任务', date: '明天' })
  const bareDay = dayjs(bare.todoTime).format('YYYY-MM-DD')
  const bareRow = lib.planList(bareDay).tasks.find(x => x.taskId === bare.taskId)
  assert.ok(!bareRow, 'bare date must NOT fabricate a chip')
})
