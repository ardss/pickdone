/* D5 maint round (2026-09-20) — CLI regression tests:
 *  1. [P2] cli/lib.js repeatOn: expandRepeatDates now receives the holiday list — a
 *     skipStatutoryHolidays rule no longer expands instances ONTO statutory holidays
 *     (missing arg defaulted to []).
 *  2. [P2] cli/lib.js renewal/expansion taskSort: the (min+max)/2 MIDPOINT (which lands the
 *     new instance in the MIDDLE of the day's step chain) is replaced by the renderer's
 *     renewal convention (store/todo.js ensureNextRepeatInstance → addTodo addToTop:false →
 *     utils/core.js nextSort): bottom-insert min-512, empty day 1024.
 *  3. [P2] cli/import.js dedup key: the day component is the tz-stable creator-calendar
 *     YYYY-MM-DD bucket (rows carry the creator IANA tz) — the same file re-imported under a
 *     DIFFERENT process timezone into the same library dedupes (was: local-midnight ms
 *     fingerprint → full double import).
 * Isolated temp DB via TODO_DB_DIR, never touches real data (f6 pattern).
 * Run: node --test tests/unit/cli/d5-main-cli-round.test.mjs */
import { test } from 'node:test'
import path from 'node:path'
import fs from 'node:fs'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-cli-d5-main-')
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const core = require_('../../../src/main/core/todo-core.js')
const dayjs = require_('dayjs')

db.init(process.env.TODO_DB_DIR)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')

let _seq = 0
function seed (over = {}) {
  const now = Date.now() + (_seq++)
  const t = {
    complete: false, createTime: now, delete: false,
    reminderTime: 0, reminderOffsets: [], reminderExtra: [], estimate: 0, difficulty: 0,
    repeatId: null, subtasks: null, image: null, files: null,
    categoryId: 0, updateTime: now, syncTime: 0,
    taskContent: 'd5任务', taskDescribe: '',
    taskSort: 0, todoTime: 0, userId: 1, status: 'add', version: 0, ...over
  }
  if (!t.taskId) t.taskId = core.genTaskId(1, now)
  db.call('upsert', t)
  return db.call('getById', t.taskId)
}

/* ---- 1: repeatOn passes the holiday list (skipStatutoryHolidays honored) ---- */
test('d5-cli-1: repeatOn with skipStatutoryHolidays skips statutory holidays in initial expansion', () => {
  // 2026-10-01..03 are statutory holidays (holidays.js 2026 data). Base on 2026-09-28 with a
  // daily rule: the expansion window crosses the holiday.
  const base = +dayjs('2026-09-28 09:00')
  const tpl = seed({ taskContent: 'd5重复', todoTime: base, dayStart: +dayjs(base).startOf('day') })
  const rule = { repeatType: 'day', repeatDayCount: 12, repeatInterval: 1, skipStatutoryHolidays: true }
  const r = lib.repeatOn(tpl.taskId, rule, 12)
  assert.ok(r && r.rid, 'repeat group created')
  assert.ok(r.made > 0, 'instances generated')
  const instances = db.call('queryTodos', { deleted: 0, repeatId: r.rid })
  const days = instances.map(t => dayjs(t.dayStart).format('YYYY-MM-DD'))
  for (const h of ['2026-10-01', '2026-10-02', '2026-10-03']) {
    assert.ok(!days.includes(h), 'holiday ' + h + ' must be skipped, got ' + days.join(','))
  }
  // sanity: non-holiday days ARE present
  assert.ok(days.includes('2026-09-29'), 'non-holiday days expand')
})

/* ---- 2: renewal taskSort uses the renderer's min-512 / 1024 convention ---- */
test('d5-cli-2: renewal instance sort = day-pool min-512 (bottom insert), empty day = 1024', () => {
  const d0 = +dayjs('2026-11-02 09:00').startOf('day')
  const d1 = +dayjs('2026-11-03 09:00').startOf('day')
  const tpl = seed({
    taskContent: 'd5续期模板', todoTime: +dayjs('2026-11-02 09:00'), dayStart: d0,
    repeatId: 'repeat_d5t1', deadlineTs: 0,
  })
  db.call('setMeta', ['repeatRule:repeat_d5t1', JSON.stringify({ repeatType: 'day', repeatDayCount: 5, repeatInterval: 1 })])
  // occupy the NEXT day's pool: a live instance with sort -200
  seed({ taskContent: 'd5占位', todoTime: +dayjs('2026-11-03 09:00'), dayStart: d1, taskSort: -200 })
  const r = lib.toggleComplete(tpl.taskId, {})
  assert.ok(r && r.renewed, 'renewal instance generated')
  assert.equal(r.renewed.dayStart, d1)
  assert.equal(r.renewed.taskSort, Math.fround(-200 - 512), 'bottom-insert on the occupied day (renderer nextSort addToTop:false)')
  // empty-day renewal: another group whose next day has no tasks → 1024 baseline
  const tpl2 = seed({
    taskContent: 'd5续期模板2', todoTime: +dayjs('2026-12-01 09:00'), dayStart: +dayjs('2026-12-01 09:00').startOf('day'),
    repeatId: 'repeat_d5t2',
  })
  db.call('setMeta', ['repeatRule:repeat_d5t2', JSON.stringify({ repeatType: 'day', repeatDayCount: 5, repeatInterval: 1 })])
  const r2 = lib.toggleComplete(tpl2.taskId, {})
  assert.ok(r2 && r2.renewed)
  assert.equal(r2.renewed.taskSort, 1024, 'empty day uses the renderer 1024 baseline (was midpoint 0)')
})

/* ---- 3: import dedup key is timezone-stable ---- */
test('d5-cli-3: the same CSV imported under two different timezones dedupes', () => {
  // Child processes (TZ is process-wide; the harness must not shift): first import under
  // Asia/Shanghai, second under America/New_York, SAME TODO_DB_DIR + same CSV.
  const csv = ['List Name,Title,Due Date', 'Inbox,d5去重任务,2026-07-20', 'Inbox,d5无日期任务,'].join('\r\n')
  const csvPath = path.join(process.env.TODO_DB_DIR, 'dedup.csv')
  fs.writeFileSync(csvPath, csv)
  const script = `
    const { createRequire } = require('module')
    const req = createRequire(${JSON.stringify(path.join(ROOT, 'package.json'))})
    const r = req('./cli/import.js').importFile(${JSON.stringify(csvPath)}, { format: 'ticktick' })
    process.stdout.write(JSON.stringify({ imported: r.imported, duplicates: r.duplicates }))
  `
  const run = tz => spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    env: { ...process.env, TZ: tz },
  })
  const first = run('Asia/Shanghai')
  assert.equal(first.status, 0, 'first import run failed: ' + first.stderr)
  const one = JSON.parse(first.stdout)
  assert.equal(one.imported, 2, 'first import creates both rows')
  assert.equal(one.duplicates, 0)
  const second = run('America/New_York')
  assert.equal(second.status, 0, 'second import run failed: ' + second.stderr)
  const two = JSON.parse(second.stdout)
  assert.equal(two.duplicates, 2, 're-import under a different TZ must dedupe both rows, got ' + JSON.stringify(two))
  assert.equal(two.imported, 0)
})
