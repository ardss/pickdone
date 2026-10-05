/**
 * maint/d22 round — CLI fixes:
 *  - `repeat on` weekly/monthly anchors derive from the task's own date when no explicit flag
 *    is given (only yearly did — App parity: RepeatModal seeds the anchor from the task);
 *  - subtask uncheck on a repeating parent removes the phantom auto-renewed next instance
 *    (App parity: renderer store/todo.js removes it on the un-complete route);
 *  - perf: repeatOn hoists the all-rows read out of the expansion loop; repeatOff --all batches
 *    the chip-snapshot cascade (one planAll scan for the whole group).
 * Run: node --test tests/unit/cli/d22-cli-repeat-subs-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'module'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-cli-d22-')
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
    taskContent: 'd22 task', taskDescribe: '',
    taskSort: 0, todoTime: 0, userId: 1, status: 'add', version: 0, ...over
  }
  if (!t.taskId) t.taskId = core.genTaskId(1, now)
  db.call('upsert', t)
  return db.call('getById', t.taskId)
}

/* ---------- fix 3: weekly/monthly anchors derive from the task date ---------- */
test('d22: repeat on weekly without --weekdays anchors on the task own weekday', () => {
  // 2026-10-14 is a Wednesday (engine convention: Monday=1 → 3)
  const wed = +dayjs('2026-10-14').startOf('day')
  const t = seed({ taskContent: 'd22 weekly anchor', todoTime: wed })
  const r = lib.repeatOn(t.taskId, lib.buildRepeatRule({ type: 'weekly', interval: 1 }), 2)
  const rule = JSON.parse(db.call('getMeta', 'repeatRule:' + r.rid))
  assert.deepEqual(rule.repeatWeekDays, [3], 'red before the fix: the default Mon-Fri [1,2,3,4,5] stayed')
})

test('d22: repeat on monthly without --monthday anchors on the task own day of month', () => {
  const t = seed({ taskContent: 'd22 monthly anchor', todoTime: +dayjs('2026-10-17').startOf('day') })
  const r = lib.repeatOn(t.taskId, lib.buildRepeatRule({ type: 'monthly', interval: 1 }), 2)
  const rule = JSON.parse(db.call('getMeta', 'repeatRule:' + r.rid))
  assert.deepEqual(rule.repeatMonthDays, [17], 'red before the fix: the default [1] stayed')
})

test('d22: explicit weekly/monthly flags stay authoritative over the task date', () => {
  const t = seed({ taskContent: 'd22 explicit anchors', todoTime: +dayjs('2026-10-17').startOf('day') })
  const r = lib.repeatOn(t.taskId, lib.buildRepeatRule({ type: 'monthly', monthday: '5' }), 1)
  const rule = JSON.parse(db.call('getMeta', 'repeatRule:' + r.rid))
  assert.deepEqual(rule.repeatMonthDays, [5], 'an explicit --monthday must win')
})

/* ---------- fix 2: subtask uncheck removes the phantom renewed instance ---------- */
test('d22: subtask uncheck on a completed repeating parent removes the auto-renewed instance', () => {
  const base = +dayjs().add(1, 'day').startOf('day')
  const tpl = seed({ taskContent: 'd22 uncheck phantom', todoTime: base })
  const r = lib.repeatOn(tpl.taskId, lib.buildRepeatRule({ type: 'daily', interval: 1 }), 1)
  // Complete the LAST instance through the sub-check (mints the renewal, same as #1 in D18).
  const group = db.call('queryTodos', { deleted: 0, repeatId: r.rid }).sort((a, b) => a.dayStart - b.dayStart)
  const last = group[group.length - 1]
  db.call('upsert', { ...last, subtasks: JSON.stringify([{ text: 'only sub', checked: false }]) })
  const done = lib.checkSubtask(last.taskId, 1, true)
  assert.equal(done.complete, true)
  assert.ok(done.renewed, 'completion renewed the chain')
  const renewedId = done.renewed.taskId
  assert.equal(db.call('getById', renewedId).delete, false, 'renewed instance is live after completion')
  // Uncheck the sub → the parent un-completes AND the phantom renewal must be soft-deleted.
  const undone = lib.checkSubtask(last.taskId, 1, false)
  assert.equal(undone.complete, false, 'parent un-completed in sync')
  assert.equal(undone.removedRenewal, renewedId, 'the phantom renewal id is reported')
  const renewedRow = db.call('getById', renewedId)
  assert.equal(renewedRow.delete, true, 'red before the fix: the renewed instance stayed behind')
  assert.equal(renewedRow.version, 0, 'delete row resets version so sync re-sends it')
})

/* ---------- fix 8: perf hoists (behavioral + source pin) ---------- */
test('d22: repeatOff --all still snapshots and clears chips for every instance (batched)', () => {
  const base = +dayjs().add(2, 'day').startOf('day')
  const tpl = seed({ taskContent: 'd22 batch chips', todoTime: base })
  const r = lib.repeatOn(tpl.taskId, lib.buildRepeatRule({ type: 'daily', interval: 1 }), 2)
  const group = db.call('queryTodos', { deleted: 0, repeatId: r.rid })
  for (const x of group) lib.planSet(x.taskId, '09:30')
  const out = lib.repeatOff(tpl.taskId, true)
  assert.equal(out.removed, group.length)
  for (const x of group) {
    const snap = db.call('getMeta', 'planChipsSnapshot:' + x.taskId)
    assert.ok(snap, 'chip snapshot persisted for ' + x.taskId)
    assert.equal(db.call('planAll', []).some(c => c.taskId === x.taskId), false, 'no orphan chips for ' + x.taskId)
  }
  assert.ok(db.call('getMeta', 'repeatRule:' + r.rid) == null, 'rule deleted for the dissolved group')
})

test('d22: source pins — expansion loop hoists allRows; --all uses the batched chip cascade', () => {
  const fsMod = fs
  const src = fsMod.readFileSync(path.join(process.cwd(), 'cli', 'lib-repeat.cjs'), 'utf8')
  assert.match(src, /const allRows = open\(\)\.call\('queryTodos', \{ deleted: 0 \}\)[\s\S]*?buildRenewalInstance[\s\S]*?allRows/, 'repeatOn expansion passes the pre-fetched allRows')
  assert.match(src, /function chipsSnapshotBatchForDelete/, 'batched cascade helper exists')
  assert.doesNotMatch(src, /for \(const x of open\(\)\.call\('queryTodos'/, 'the per-instance full-scan loop is gone')
})
