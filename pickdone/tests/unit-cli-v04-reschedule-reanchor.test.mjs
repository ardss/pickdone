/** CLI v0.4 — reschedule reminder re-anchor + date/deadline/reminder parser unification (review 2026-09-10).
 *  Parity source for the re-anchor was READ, not guessed: renderer EditPanel.applyDate(ts) re-anchors the
 *  main reminder to the new date at its original time-of-day (dayjs(ts).hour(t.hour()).minute(t.minute())),
 *  keeps it 0 when there was none, and shifts reminderExtra rows by the same day-diff — a bare todoTime
 *  patch on the CLI side used to leave the main reminder on the old day. Also pins: `edit --date ""` goes
 *  through the FULL clear cascade (same as none|clear, was a partial todoTime-only write), `project
 *  --deadline` delegates to the same parser as `edit --deadline` (day-granular), `edit --reminder none|clear`
 *  clears, non-JSON --dry-run previews print JSON instead of "[object Object]", and batch --dry-run exits 2
 *  on failures (parity with the real run).
 *  Isolated temp DB via TODO_DB_DIR, never touches real data; CLI-surface checks spawn cli/pickdone.js
 *  with the same TODO_DB_DIR (unit-cli-v03 pattern).
 *  Run: node --test tests/unit-cli-v04-reschedule-reanchor.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-v04-reanchor-'))
const require_ = createRequire(import.meta.url)
const db = require_('../src/main/db.js')
const lib = require_('../cli/lib.js')
const core = require_('../src/main/core/todo-core.js')
const dayjs = require_('dayjs')

db.init(process.env.TODO_DB_DIR)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const cliPath = path.join(ROOT, 'cli', 'pickdone.js')
const runCli = args => JSON.parse(execFileSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' }))
const runCliRaw = args => execFileSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' })
const runCliStatus = args => spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8' })

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
const chipsOf = taskId => db.call('planAll', []).filter(r => r.taskId === taskId)

test('reschedule re-anchors the main reminder to the new date at its original time and shifts extras by the day-diff', () => {
  const t = seed({
    taskContent: 'v4改期甲',
    todoTime: at(3, 9, 0),
    reminderTime: at(3, 8, 0),
    reminderExtra: [at(4, 10, 0), at(5, 14, 30)]
  })
  const out = runCli(['edit', t.taskId, '--date', '+5d', '--json'])
  assert.equal(out.ok, true)
  const row = db.call('getById', t.taskId)
  const newDay0 = day0Of(row.todoTime)
  const shift = dayjs(newDay0).diff(day0Of(t.todoTime), 'day')
  assert.equal(shift, 2, 'sanity: +5d on a +3d task is a 2-day shift')
  assert.equal(row.reminderTime, +dayjs(newDay0).hour(8).minute(0).second(0).millisecond(0),
    'main reminder lands on the new date at its original 08:00 (stayed on the old day before the fix)')
  assert.deepEqual(row.reminderExtra, [at(6, 10, 0), at(7, 14, 30)],
    'extra reminders shift by the same day-diff, keeping their own time-of-day (EditPanel.applyDate parity)')
  assert.equal(row.dayStart, newDay0, 'dayStart follows todoTime as usual')
})

test('explicit --reminder on the same command wins: no re-anchor, extras keep their absolute days', () => {
  const t = seed({
    taskContent: 'v4改期乙',
    todoTime: at(3, 9, 0),
    reminderTime: at(3, 8, 0),
    reminderExtra: [at(4, 10, 0)]
  })
  const out = runCli(['edit', t.taskId, '--date', '+5d', '--reminder', '+1d 07:30', '--json'])
  assert.equal(out.ok, true)
  const row = db.call('getById', t.taskId)
  assert.equal(day0Of(row.todoTime), day0Of(at(5, 0, 0)), 'date was still rescheduled')
  assert.equal(row.reminderTime, at(1, 7, 30), 'the explicit --reminder value lands verbatim (no re-anchor)')
  assert.deepEqual(row.reminderExtra, [at(4, 10, 0)], 'extras untouched when the command owns its reminder')
})

test('task without reminders is untouched: no phantom reminder rows after a reschedule', () => {
  const t = seed({ taskContent: 'v4改期丙', todoTime: at(1, 9, 0) })
  const out = runCli(['edit', t.taskId, '--date', '+4d', '--json'])
  assert.equal(out.ok, true)
  const row = db.call('getById', t.taskId)
  assert.equal(row.reminderTime, 0, 'no main reminder before, none after')
  assert.deepEqual(row.reminderExtra, [], 'no extras before, none after')
})

test('extras shift even without a main reminder (EditPanel.applyDate shifts them independently of remindTs)', () => {
  const t = seed({ taskContent: 'v4改期丁', todoTime: at(1, 9, 0), reminderExtra: [at(2, 10, 0)] })
  const out = runCli(['edit', t.taskId, '--date', '+4d', '--json'])
  assert.equal(out.ok, true)
  const row = db.call('getById', t.taskId)
  assert.equal(row.reminderTime, 0)
  assert.deepEqual(row.reminderExtra, [at(5, 10, 0)], 'shift = 3 days (day +1 → day +4), same time-of-day')
})

test('`edit --date ""` takes the FULL clear cascade (same shape as none|clear), not a partial todoTime-only write', () => {
  const extraTs = at(4, 10, 0)
  const t = seed({
    taskContent: 'v4空串清除',
    todoTime: at(3, 9, 0),
    reminderTime: at(3, 8, 0),
    reminderExtra: [extraTs]
  })
  const ymd = dayjs(day0Of(t.todoTime)).format('YYYY-MM-DD')
  db.call('planAddMany', [{ taskId: t.taskId, day: ymd, mm: '09:00' }])
  const out = runCli(['edit', t.taskId, '--date', '', '--json'])
  assert.equal(out.ok, true)
  const row = db.call('getById', t.taskId)
  assert.equal(row.todoTime, 0)
  assert.equal(row.dayStart, 0, 'dayStart cleared consistently with todoTime')
  assert.equal(row.reminderTime, 0, 'main reminder drops with the date — the partial path never did this')
  assert.deepEqual(row.reminderExtra, [extraTs], 'extras kept as-is, same as the App')
  assert.equal(chipsOf(t.taskId).length, 0, 'schedule chips cascade away (they have no day to live on)')
  const snap = JSON.parse(db.call('getMeta', 'planChipsSnapshot:' + t.taskId) || '[]')
  assert.equal(snap.length, 1, 'chip snapshot kept in meta for a later restore')
  assert.ok(lib.listTodos({ noDate: true }).some(x => x.taskId === t.taskId), 'task is back in the todo box')
})

test('`--date ""` dry-run previews todoTime 0 and writes nothing (preview parity with the new real behavior)', () => {
  const t = seed({ taskContent: 'v4空串预演', todoTime: at(3, 9, 0), reminderTime: at(3, 8, 0) })
  const out = runCli(['edit', t.taskId, '--date=', '--dry-run', '--json'])
  assert.equal(out.ok, true)
  assert.equal(out.data.dryRun, true)
  assert.equal(out.data.patch.todoTime, 0, 'empty string previews the cleared shape')
  assert.equal(db.call('getById', t.taskId).todoTime, at(3, 9, 0), 'dry run must not write')
})

test('project --deadline accepts the same vocabulary as edit --deadline (tomorrow / +Nd HH:mm), day-granular', () => {
  runCli(['category', 'add', 'V4Proj', '--json'])
  runCli(['project', 'V4Proj', '--on', '--json'])
  const out = runCli(['project', 'V4Proj', '--deadline', 'tomorrow', '--json'])
  assert.equal(out.ok, true, 'tomorrow must parse (the milestone parser used to reject it here)')
  assert.equal(out.data.deadline, +dayjs().add(1, 'day').startOf('day'), 'deadline is day-granular')
  const out2 = runCli(['project', 'V4Proj', '--deadline', '+3d 09:00', '--json'])
  assert.equal(out2.ok, true)
  assert.equal(out2.data.deadline, +dayjs().add(3, 'day').startOf('day'), 'offset-with-time truncates to the day')
  const out3 = runCli(['project', 'V4Proj', '--deadline', 'none', '--json'])
  assert.equal(out3.ok, true)
  assert.equal(out3.data.deadline, 0, 'clear word none still clears')
  assert.throws(() => runCli(['project', 'V4Proj', '--deadline', '不是日期XYZ', '--json']), /cannot parse date/,
    'bad input still fails loudly')
})

test('`edit --reminder none|clear` clears the main reminder (same convention as --remind-offset/--remind-extra)', () => {
  const t = seed({ taskContent: 'v4提醒清除甲', todoTime: at(2, 9, 0), reminderTime: at(2, 8, 0) })
  const out = runCli(['edit', t.taskId, '--reminder', 'none', '--json'])
  assert.equal(out.ok, true)
  assert.equal(db.call('getById', t.taskId).reminderTime, 0, 'none clears (used to throw "cannot parse date")')
  const b = seed({ taskContent: 'v4提醒清除乙', todoTime: at(2, 9, 0), reminderTime: at(2, 8, 0) })
  const out2 = runCli(['edit', b.taskId, '--reminder', 'clear', '--json'])
  assert.equal(out2.ok, true)
  assert.equal(db.call('getById', b.taskId).reminderTime, 0, 'clear is accepted as an alias')
  const c = seed({ taskContent: 'v4提醒重设丙', todoTime: at(2, 9, 0) })
  const out3 = runCli(['edit', c.taskId, '--reminder', '+1d 07:30', '--json'])
  assert.equal(out3.ok, true)
  assert.equal(db.call('getById', c.taskId).reminderTime, at(1, 7, 30), 'absolute datetimes still parse')
})

test('non-JSON --dry-run previews print the object as JSON instead of "[object Object]"', () => {
  const t = seed({ taskContent: 'v4预演甲', todoTime: at(1, 9, 0) })
  const out = runCliRaw(['edit', t.taskId, '--date', '+3d', '--dry-run'])
  assert.ok(!out.includes('[object Object]'), 'text mode must not print [object Object]')
  assert.ok(out.includes('"dryRun": true') && out.includes('"todoTime"'), 'the patch object renders as pretty JSON')
  assert.equal(db.call('getById', t.taskId).todoTime, at(1, 9, 0), 'dry run wrote nothing')
})

test('batch --dry-run exits 2 when failures exist, 0 when the plan is clean (parity with the real run)', () => {
  const a = seed({ taskContent: 'v4批量甲', todoTime: at(1, 9, 0) })
  const bad = runCliStatus(['batch', 'date', a.taskId, 'missing-id-xyz', '--to', '+2d', '--dry-run', '--json'])
  assert.equal(bad.status, 2, 'a dry-run with failures must set exit code 2 (was always 0)')
  const badOut = JSON.parse(bad.stdout)
  assert.equal(badOut.ok, true)
  assert.equal(badOut.data.failures.length, 1)
  assert.equal(badOut.data.failures[0].taskId, 'missing-id-xyz')
  const good = runCliStatus(['batch', 'date', a.taskId, '--to', '+2d', '--dry-run', '--json'])
  assert.equal(good.status, 0, 'a clean dry-run plan still exits 0')
  assert.equal(db.call('getById', a.taskId).todoTime, at(1, 9, 0), 'dry run wrote nothing')
})
