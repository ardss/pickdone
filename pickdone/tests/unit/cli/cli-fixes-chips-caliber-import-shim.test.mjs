/** CLI + browser-shim domain fix regression tests — isolated temp DB via TODO_DB_DIR, never touches real data.
 *  Covers: repeatOff --all chip cascade (#1) / overview doneToday + stats doneCompleted caliber (#2/#3)
 *  / addTodo & import top-insert taskSort (#4) / backfill 600-min cap (#5) / Todoist subtask checked passthrough (#7)
 *  / import completedAt due-date fallback (#8) / shim getById+deleteMeta ops (#9).
 *  Run: node --test tests/cli-fixes-chips-caliber-import-shim.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import vm from 'node:vm'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-domain-'))
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const imp = require_('../../../cli/import.js')
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

const chipsOf = taskId => db.call('planAll', []).filter(r => r.taskId === taskId)

test('#1 repeatOff --all snapshots + clears plan chips of soft-deleted future instances', () => {
  const base = seed({ taskContent: '重复组模板-芯片级联', todoTime: +dayjs().add(1, 'day').startOf('day') })
  lib.planSet(base.taskId, '09:00')
  const { rid } = lib.repeatOn(base.taskId, lib.buildRepeatRule({ type: 'daily', interval: 1 }), 3)
  assert.ok(rid)
  // Give one future instance its own chip so the cascade has something to clean
  const group = db.call('queryTodos', { deleted: 0, repeatId: rid })
  const future = group.find(x => x.taskId !== base.taskId)
  lib.planSet(future.taskId, '10:00')
  assert.equal(chipsOf(future.taskId).length, 1)

  const r = lib.repeatOff(base.taskId, true)
  assert.equal(r.removed, group.length - 1, 'all other incomplete instances soft-deleted')
  // Soft-deleted instance: chips cleared from plan_chips + snapshot kept for restore
  assert.equal(chipsOf(future.taskId).length, 0, 'soft-deleted instance must not keep orphan chips')
  const snap = JSON.parse(db.call('getMeta', 'planChipsSnapshot:' + future.taskId) || '[]')
  assert.ok(Array.isArray(snap) && snap.some(c => c.mm === '10:00'), 'chip snapshot kept for restore backfill')
  // Template task (left alive, repeatId stripped) keeps its chips
  assert.equal(chipsOf(base.taskId).length, 1)
})

test('#2/#3 overview doneToday (completedAt caliber) and stats doneCompleted split', () => {
  const today0 = +dayjs().startOf('day')
  // scheduled yesterday, completed today → counts in doneToday (completion caliber), not in today.done (dayStart caliber)
  seed({ taskContent: '口径甲-昨日排今日完', todoTime: today0 - 86400000, complete: true, completedAt: Date.now() })
  // scheduled + completed today → counted in both calibers
  seed({ taskContent: '口径乙-今日排今日完', todoTime: today0, complete: true, completedAt: Date.now() })

  const ov = lib.overview()
  assert.ok(ov.today.doneToday >= 2, 'doneToday counts both completions fallen on today')

  // stats: scheduledDay done (planned caliber) vs doneByCompletionDay (completion caliber) must both surface
  const st = lib.stats({ from: today0 - 3 * 86400000, to: Date.now() })
  const fmt = ts => parseInt(dayjs(ts).format('YYYYMMDD'), 10)
  const yRow = st.find(r => r.day === fmt(today0 - 86400000))
  assert.equal(yRow.total, 1, 'yesterday row planned total')
  assert.equal(yRow.done, 1, 'yesterday planned-done caliber intact')
  assert.equal(yRow.doneCompleted, 0, 'completion happened today, not yesterday')
  const tRow = st.find(r => r.day === fmt(today0))
  assert.ok(tRow.doneCompleted >= 2, 'both completions aggregated under their completion day')
})

test('#4 addTodo top-insert taskSort (min-100 within target day pool)', () => {
  const tomorrow = +dayjs().add(2, 'day').startOf('day')
  seed({ taskContent: '排序池甲', todoTime: tomorrow, taskSort: 500 })
  seed({ taskContent: '排序池乙', todoTime: tomorrow, taskSort: 700 })
  const added = lib.addTodo({ content: '排序新任务', date: dayjs(tomorrow).format('YYYY-MM-DD') })
  assert.equal(added.taskSort, 400, 'new task lands above the current minimum (min-100)')

  // no-date pool gets the same treatment
  seed({ taskContent: '无日期池', todoTime: 0, taskSort: 1000 })
  const free = lib.addTodo({ content: '无日期新任务' })
  assert.equal(free.taskSort, 900)
})

test('#5 backfill caps at 600 minutes (DB clamp), >600 is a USAGE error', () => {
  assert.throws(() => lib.backfillRecord({ date: '2026-09-01', minutes: 601 }), e => e.code === 'USAGE')
  const rec = lib.backfillRecord({ date: '2026-09-01', minutes: 600 })
  assert.equal(rec.focusDuration, 600, '600 accepted without truncation')
  assert.match(rec.tomatoId, /^tmt_m_\d+_600_[0-9a-z]+$/, 'id keeps the tmt_m_<startTs>_<minutes>_<task-suffix> shape')
})

test('#7 Todoist CSV subtask checked column is parsed and passed through', () => {
  const csv = [
    'TYPE,CONTENT,PRIORITY,INDENT,checked',
    'task,待办父任务,1,1,',
    'task,已勾选子任务,,2,x',
    'task,未勾选子任务,,2,'
  ].join('\n')
  const items = imp.rowsToItems(csv, 'todoist')
  assert.equal(items.length, 1)
  assert.deepEqual(items[0].subs, [
    { text: '已勾选子任务', checked: true },
    { text: '未勾选子任务', checked: false }
  ], 'subtask completion state must survive parsing')
})

test('#8 imported completed tasks fall back completedAt → due → createTime', () => {
  const due5d = +dayjs().subtract(5, 'day').startOf('day')
  const r1 = imp.importItems(
    [{ title: '导入回退-有截止', done: true, completedAt: 0, due: due5d, list: '', priority: 0 }],
    { dryRun: false, format: 'ticktick' })
  assert.equal(r1.imported, 1)
  const row1 = db.call('queryTodos', { deleted: 0, keyword: '导入回退-有截止' })[0]
  assert.equal(row1.completedAt, due5d, 'completedAt falls back to the due date, not the import moment')

  const r2 = imp.importItems(
    [{ title: '导入回退-无截止', done: true, completedAt: 0, due: 0, list: '', priority: 0 }],
    { dryRun: false, format: 'ticktick' })
  assert.equal(r2.imported, 1)
  const row2 = db.call('queryTodos', { deleted: 0, keyword: '导入回退-无截止' })[0]
  const age = Date.now() - row2.completedAt
  assert.ok(age >= 0 && age < 60000, 'no due date → falls back to import createTime (≈now), never 0')
})

test('#9 browser shim implements getById and deleteMeta ops (aligned with ALLOWED_RENDERER_OPS)', async t => {
  // Minimal browser sandbox: localStorage map + window + dayjs, then run the shim IIFE in a vm
  const store = new Map()
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  }
  const sandbox = {
    console: { log () {}, warn () {}, error () {} },
    localStorage,
    URLSearchParams,
    location: { search: '' },
    Date,
    JSON,
    Math,
    Number,
    String,
    Object,
    Array,
    Set,
    RegExp,
    isNaN,
    encodeURIComponent,
    decodeURIComponent,
    btoa: s => Buffer.from(s, 'binary').toString('base64'),
    atob: s => Buffer.from(s, 'base64').toString('binary'),
    unescape, escape,
    window: null
  }
  sandbox.window = {
    dayjs: require_('dayjs'),
    todoAPI: undefined
  }
  sandbox.globalThis = sandbox
  vm.createContext(sandbox)
  const code = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..', 'browser-dev', 'todo-browser-shim.js'), 'utf8')
  vm.runInContext(code, sandbox)
  const dbCall = sandbox.window.todoAPI.dbCall

  await t.test('getById returns the row / null when missing', async () => {
    const rows = await dbCall('queryTodos', { deleted: 0, limit: 1 })
    assert.ok(rows.length)
    const hit = await dbCall('getById', rows[0].taskId)
    assert.equal(hit.taskId, rows[0].taskId)
    assert.equal(await dbCall('getById', 'no-such-id'), null, 'missing id → null (desktop parity)')
  })

  await t.test('deleteMeta removes the key instead of swallowing the call', async () => {
    await dbCall('setMeta', ['planChipsSnapshot:x', '["chip"]'])
    assert.equal(await dbCall('getMeta', 'planChipsSnapshot:x'), '["chip"]')
    assert.equal(await dbCall('deleteMeta', 'planChipsSnapshot:x'), true)
    assert.equal(await dbCall('getMeta', 'planChipsSnapshot:x'), null, 'key actually deleted, not silently ignored')
  })
})
