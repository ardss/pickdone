/**
 * CLI maint round (2026-09-22) — regression pins:
 *   m7-1  CSV import derives the important flag from priority exactly like lib.addTodo
 *         (high=3 → important=1) — imported high-priority tasks used to be quadrant-less
 *         and never showed up in the four-quadrant matrix.
 *   m7-2  Repeat renewal reads the LIVE per-task meta estimate of the instance being renewed
 *         (getEstimateOf) instead of the dead row estimate column, which db.js bumpSnow
 *         repurposes as accumulated focus minutes (150 focused min used to clamp to "20 🍅").
 *   m7-3  SETTINGS_MANIFEST follows the renderer's key migration: tomatoTime/restTime exist,
 *         the dead tomatoTimeDefault/restTimeDefault names are gone; the sync-surface keys
 *         appLocale/sidebarCollapsed/catFold are manifest-exposed.
 *   m7-4  `add` gains --deadline (same parser as edit, applied via the patchTodo pipeline).
 *   m7-5  `get` surfaces the live meta estimate under its own `tomatoEstimate` field and no
 *         longer overwrites the DB row's estimate column.
 * Isolated temp DB via TODO_DB_DIR, never touches real data (unit-cli pattern).
 * Run: node --test tests/unit/cli/m7-cli-quadrant-estimate-settings.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'
import dayjs from 'dayjs'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-m7-'))
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const importer = require_('../../../cli/import.js')
const core = require_('../../../src/main/core/todo-core.js')

db.init(process.env.TODO_DB_DIR)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(ROOT, 'cli', 'pickdone.js')
const runCliJson = args => JSON.parse(execFileSync(process.execPath, [cliPath, ...args, '--json'], { encoding: 'utf8' }))

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

/* ---------------- m7-1: import quadrant derivation aligns with addTodo ---------------- */

test('m7-1a: a high-priority (3) import row lands important=1 like lib.addTodo does', () => {
  const items = [{ list: 'Q', title: 'm7 高优先导入', notes: '', tags: [], due: 0, reminder: 0, priority: 3, done: false, completedAt: 0, subs: [] }]
  const r = importer.importItems(items, { format: 'ticktick' })
  assert.equal(r.imported, 1)
  const row = db.call('queryTodos', { deleted: 0 }).find(t => t.taskContent === 'm7 高优先导入')
  assert.equal(row.priority, 3)
  assert.equal(row.important, 1, 'high priority implies important (four-quadrant q1/q2 visibility)')
  assert.equal(row.urgent, 0, 'urgent stays 0 (same as addTodo without an explicit urgent)')
})

test('m7-1b: low/mid priority imports stay important=0 (matches the priority===3 rule)', () => {
  const items = [
    { list: 'Q', title: 'm7 低优先导入', notes: '', tags: [], due: 0, reminder: 0, priority: 1, done: false, completedAt: 0, subs: [] },
    { list: 'Q', title: 'm7 中优先导入', notes: '', tags: [], due: 0, reminder: 0, priority: 2, done: false, completedAt: 0, subs: [] }
  ]
  importer.importItems(items, { format: 'ticktick' })
  const rows = db.call('queryTodos', { deleted: 0 })
  assert.equal(rows.find(t => t.taskContent === 'm7 低优先导入').important, 0)
  assert.equal(rows.find(t => t.taskContent === 'm7 中优先导入').important, 0)
})

/* ---------------- m7-2: renewal inherits the live meta estimate ---------------- */

const today9 = () => +dayjs().hour(9).minute(0).second(0).millisecond(0)

test('m7-2: renewal carries the LIVE meta estimate, not the focus-minutes-poisoned estimate column', () => {
  const rid = 'repeat_m7est1'
  // estimate column holds accumulated focus minutes (bumpSnow semantics) — 150 min used to clamp to 20
  const t = seed({ taskContent: 'm7续期估时任务', repeatId: rid, todoTime: today9(), dayStart: +dayjs().startOf('day'), estimate: 150 })
  db.call('setMeta', ['tomatoEstimateState:' + t.taskId, '3']) // the real estimated workload
  db.call('setMeta', ['repeatRule:' + rid, JSON.stringify({ ...core.REPEAT_DEFAULTS, repeatType: 'day', repeatInterval: 1 })])
  const { renewed } = lib.toggleComplete(t.taskId, true)
  assert.ok(renewed, 'renewal created')
  assert.equal(renewed.estimate, 3, 'renewed instance estimate = the live meta value (was clamp(column)=20)')
  assert.equal(db.call('getMeta', 'tomatoEstimateState:' + renewed.taskId), '3', 'meta key copied to the new instance')
})

test('m7-2b: with no meta key, renewal falls back to the row column (legacy rows keep working)', () => {
  const rid = 'repeat_m7est2'
  const t = seed({ taskContent: 'm7续期旧数据', repeatId: rid, todoTime: today9(), dayStart: +dayjs().startOf('day'), estimate: 2 })
  db.call('setMeta', ['repeatRule:' + rid, JSON.stringify({ ...core.REPEAT_DEFAULTS, repeatType: 'day', repeatInterval: 1 })])
  const { renewed } = lib.toggleComplete(t.taskId, true)
  assert.ok(renewed)
  assert.equal(renewed.estimate, 2, 'getEstimateOf legacy fallback keeps pre-X2 rows renewing with their estimate')
})

/* ---------------- m7-3: settings manifest key migration ---------------- */

test('m7-3: manifest exposes tomatoTime/restTime + the sync-surface keys, dead names are gone', () => {
  const rows = lib.settingsList()
  const keys = new Set(rows.map(r => r.key))
  for (const k of ['tomatoTime', 'restTime', 'appLocale', 'sidebarCollapsed', 'catFold']) {
    assert.ok(keys.has(k), `manifest carries "${k}"`)
  }
  for (const dead of ['tomatoTimeDefault', 'restTimeDefault']) {
    assert.ok(!keys.has(dead), `dead key "${dead}" removed from the manifest`)
  }
  const byKey = Object.fromEntries(rows.map(r => [r.key, r]))
  assert.equal(byKey.tomatoTime.type, 'number')
  assert.equal(byKey.restTime.type, 'number')
  assert.equal(byKey.appLocale.type, 'string')
  assert.equal(byKey.sidebarCollapsed.type, 'boolean')
  assert.equal(byKey.catFold.type, 'boolean')
})

test('m7-3b: settings set persists tomatoTime through the row path', () => {
  const r = lib.settingsSet('tomatoTime', '30')
  assert.equal(r.value, 30)
  assert.equal(lib.settingsDoc().tomatoTime, 30)
})

/* ---------------- m7-4: add --deadline ---------------- */

test('m7-4: add --deadline parses like edit and writes deadlineTs on the new row', () => {
  const added = runCliJson(['add', 'm7 deadline task', '--deadline', '2026-10-01'])
  const row = added.data || added
  const got = db.call('getById', row.taskId)
  assert.equal(got.deadlineTs, +dayjs('2026-10-01'), 'deadlineTs set at creation (edit-parity parser)')
})

/* ---------------- m7-5: get keeps the estimate column intact ---------------- */

test('m7-5: get surfaces tomatoEstimate without overwriting the row estimate column', () => {
  const added = runCliJson(['add', 'm7 get caliber task'])
  const taskId = (added.data || added).taskId
  lib.setEstimate(taskId, 7)
  seed({ taskContent: 'm7 column guard', estimate: 150 }) // noise
  const got = runCliJson(['get', taskId])
  const row = got.data || got
  assert.equal(row.tomatoEstimate, 7, 'live meta estimate under its own field')
  assert.equal(row.estimate, 0, 'the DB column is no longer clobbered (UI export caliber preserved)')
})
