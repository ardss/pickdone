/** Regression for review P1 (2026-09-10): `list --view` used to fetch with the default row cap and only
 *  filter afterwards — libraries with more tasks than the cap silently lost matching rows vs the app's
 *  FilterView. The view's conds are now pushed into the query (dateMode/category/done, limit 500). */
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'module'
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-view-cap-'))
const require_ = createRequire(import.meta.url)
const db = require_('../src/main/db.js')
const lib = require_('../cli/lib.js')
const dayjs = require_('dayjs')

db.init(process.env.TODO_DB_DIR)

const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '..')
const today0 = +dayjs().startOf('day')

let seq = 0
function seedTask (over = {}) {
  const now = Date.now() + (seq++)
  const t = {
    complete: false, createTime: now, delete: false,
    reminderTime: 0, reminderOffsets: [], estimate: 0, difficulty: 0,
    repeatId: null, subtasks: null, image: null, files: null,
    categoryId: 0, updateTime: now, syncTime: 0,
    taskContent: 'cap task', taskDescribe: '',
    taskSort: 0, userId: 1, status: 'add', version: 0,
    todoTime: today0, dayStart: today0, ...over
  }
  db.call('upsert', t)
  return t
}
const overdue0 = today0 - 2 * 86400000

test('viewFetchOpts pushes dateMode/category/done into the fetch and raises the cap', () => {
  const o = lib.viewFetchOpts({ dateMode: 'today', catId: 7 })
  assert.equal(o.range, 'today')
  assert.equal(o.noDate, false)
  assert.equal(o.done, false)
  assert.equal(o.category, 7)
  assert.equal(o.limit, 500)
  assert.equal(lib.viewFetchOpts({ dateMode: 'none' }).noDate, true)
  assert.equal(lib.viewFetchOpts({ dateMode: 'all' }).range, null)
  assert.equal(lib.viewFetchOpts({}).category, null)
})

test('list --view returns every matching task beyond the old 200-row cap (210 seeded)', () => {
  for (let i = 0; i < 210; i++) seedTask({ taskId: 'tid_cap_' + i, taskContent: 'cap ' + i, todoTime: overdue0, dayStart: overdue0 })
  seedTask({ taskId: 'tid_cap_done', taskContent: 'cap done', todoTime: overdue0, dayStart: overdue0, complete: true }) // view is undone-only
  lib.viewAdd('capview', { overdue: true })
  const out = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'cli', 'pickdone.js'), 'list', '--view', 'capview', '--json'], {
    encoding: 'utf8', env: { ...process.env, TODO_DB_DIR: process.env.TODO_DB_DIR }, timeout: 120000
  }))
  assert.equal(out.ok, true)
  const ids = out.data.map(t => t.taskId)
  assert.equal(ids.length, 210, 'all 210 undone today tasks must come back, cap or not')
  for (const probe of ['tid_cap_0', 'tid_cap_209']) assert.ok(ids.includes(probe), probe + ' must not be truncated away')
  assert.ok(!ids.includes('tid_cap_done'), 'completed tasks stay excluded')
})

test('user --limit still narrows a --view result after filtering', () => {
  const out = JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'cli', 'pickdone.js'), 'list', '--view', 'capview', '--json', '--limit', '5'], {
    encoding: 'utf8', env: { ...process.env, TODO_DB_DIR: process.env.TODO_DB_DIR }, timeout: 120000
  }))
  assert.equal(out.data.length, 5)
})
