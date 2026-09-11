/** Round-6 CLI fixes (F6-2..F6-8), each with its regression test:
 *  F6-2 `add --after` resolves the ref to a real taskId (raw keyword used to land in predecessors and
 *      read as "ready" forever); unknown ref fails fast with a non-zero exit.
 *  F6-3 explicit --done/--no-date win over a saved view's undone-only presets (applyViewConds takes the
 *      override); `list --view X --done` used to silently re-apply done:false.
 *  F6-4 `deps list` / `ready` honor --json (structured data) while keeping the text default.
 *  F6-5 `milestone add` echoes the milestone it actually inserted (the list is date-sorted, so
 *      milestones.at(-1) echoed a different row whenever the new date was not the latest).
 *  F6-6 --lunar is honored on the `list --on` and `search` paths (was silently ignored).
 *  F6-7 a bare/invalid --limit no longer collapses the result to 1 row / 0 rows.
 *  F6-8 multi-field `edit` resolves the target exactly once — a --content rename no longer lets the
 *      trailing --remind-offset re-resolve the (possibly renamed) keyword into a different task.
 *  Isolated temp DB via TODO_DB_DIR, never touches real data (cli-r5-fixes pattern).
 *  Run: node --test tests/unit/cli/f6-cli-round6-fixes.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'module'
import { fileURLToPath } from 'node:url'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-cli-f6-'))
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')
const core = require_('../../../src/main/core/todo-core.js')
const dayjs = require_('dayjs')

db.init(process.env.TODO_DB_DIR)

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const cliPath = path.join(ROOT, 'cli', 'pickdone.js')
const runCli = args => JSON.parse(spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', env: { ...process.env } }).stdout)
const runCliRaw = args => spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', env: { ...process.env } })

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

const tomorrow9 = () => +dayjs().add(1, 'day').hour(9).minute(0).second(0).millisecond(0)

/* ---------- F6-2: add --after ---------- */
test('f6-2: add --after <keyword> stores the resolved taskId as predecessor', () => {
  const pred = seed({ taskContent: 'f6前置任务' })
  const out = runCli(['add', 'f6依赖任务', '--after', 'f6前置', '--json'])
  assert.equal(out.ok, true)
  const row = db.call('getById', out.data.taskId)
  assert.deepEqual(lib.parsePredecessors(row.predecessors), [pred.taskId],
    'keyword resolved to the real taskId (the raw string "f6前置" used to be stored verbatim)')
})

test('f6-2b: add --after with an unknown ref fails fast (non-zero exit, TASK_NOT_FOUND)', () => {
  const res = runCliRaw(['add', 'f6孤儿任务', '--after', 'f6根本不存在', '--json'])
  assert.notEqual(res.status, 0, 'must exit non-zero instead of creating a task with a dead predecessor')
  const err = JSON.parse(res.stderr)
  assert.equal(err.error, 'TASK_NOT_FOUND')
  assert.equal(db.call('queryTodos', { deleted: 0, keyword: 'f6孤儿任务' }).length, 0, 'no task row created')
})

/* ---------- F6-3: explicit flags beat view presets ---------- */
test('f6-3: list --view X --done shows done tasks (explicit flag overrides the view done:false preset)', () => {
  const cat = lib.addCategory('f6视图分类')
  const doneTask = seed({ taskContent: 'f6已完成任务', complete: true, categoryId: cat.categoryId })
  seed({ taskContent: 'f6未完成任务', categoryId: cat.categoryId })
  const v = lib.viewAdd('f6视图甲', { category: String(cat.categoryId) })
  const out = runCli(['list', '--view', v.id, '--done', '--json'])
  assert.equal(out.ok, true)
  const ids = out.data.map(t => t.taskId)
  assert.ok(ids.includes(doneTask.taskId), 'done task visible with explicit --done (was filtered out by the view preset)')
  assert.ok(!out.data.some(t => !t.complete), 'only done tasks shown')
  // default view listing stays undone-only (FilterView parity untouched)
  const out2 = runCli(['list', '--view', v.id, '--json'])
  assert.ok(out2.data.some(t => t.taskId && !t.complete))
  assert.ok(!out2.data.some(t => t.complete), 'without the flag the view is still undone-only')
})

test('f6-3b: list --view X --no-date wins over a nodate view window on a dated view', () => {
  const cat = lib.addCategory('f6无日期分类')
  const undated = seed({ taskContent: 'f6无日期任务', categoryId: cat.categoryId, todoTime: 0 })
  seed({ taskContent: 'f6有日期任务', categoryId: cat.categoryId, todoTime: tomorrow9() })
  const v = lib.viewAdd('f6视图乙', { category: String(cat.categoryId) }) // dateMode all
  const out = runCli(['list', '--view', v.id, '--no-date', '--json'])
  const ids = out.data.map(t => t.taskId)
  assert.ok(ids.includes(undated.taskId), 'undated task visible')
  assert.ok(!out.data.some(t => t.todoTime), 'dated task excluded by the explicit --no-date')
})

/* ---------- F6-4: ready / deps list honor --json ---------- */
test('f6-4: deps list --json returns structured predecessors; ready --json returns task rows', () => {
  const pred = seed({ taskContent: 'f6依赖前列', complete: true })
  const main = seed({ taskContent: 'f6依赖主体', predecessors: JSON.stringify([pred.taskId]) })
  const out = runCli(['deps', main.taskId, 'list', '--json'])
  assert.equal(out.ok, true)
  assert.equal(out.data.taskId, main.taskId)
  assert.deepEqual(out.data.predecessors, [{ taskId: pred.taskId, content: pred.taskContent, complete: true, missing: false }])
  // default (no --json) keeps the text form
  const raw = runCliRaw(['deps', main.taskId, 'list'])
  assert.match(raw.stdout, /predecessors of \[f6依赖主体\]: 1/)
  const ready = runCli(['ready', '--json'])
  assert.equal(ready.ok, true)
  assert.ok(Array.isArray(ready.data))
  assert.ok(ready.data.some(t => t.taskId === main.taskId), 'pred complete → main is ready')
  assert.ok(!ready.data.some(t => t.taskId === pred.taskId), 'completed pred is not in ready')
})

/* ---------- F6-5: milestone add echoes the inserted row ---------- */
test('f6-5: milestone add echoes the milestone actually added, not the sorted-last row', () => {
  const cat = lib.addCategory('f6里程碑项目')
  // Existing milestone dated FAR future; the new one lands EARLIER, so the sorted list ends with the OLD row
  lib.addMilestone(cat.categoryId, 'f6晚里程碑', '+90d')
  const out = runCli(['milestone', cat.categoryId, 'add', 'f6早里程碑', '+3d', '--json'])
  assert.equal(out.ok, true)
  assert.equal(out.data.added.title, 'f6早里程碑')
  assert.equal(out.data.added.date, +dayjs().add(3, 'day').startOf('day'),
    'echoes the inserted row (used to echo milestones[milestones.length-1] = the +90d row)')
  // last row in the sorted list is the far-future one — pinning the trap the old echo fell into
  assert.equal(out.data.milestones[out.data.milestones.length - 1].title, 'f6晚里程碑')
})

/* ---------- F6-6: --lunar on the --on and search paths ---------- */
test('f6-6: list --on D --lunar and search --lunar annotate rows like the main list path', () => {
  const dated = seed({ taskContent: 'f6 lunar search 任务', todoTime: tomorrow9() })
  const outS = runCli(['search', 'lunar search', '--lunar', '--json'])
  const hitS = outS.data.find(t => t.taskId === dated.taskId)
  assert.ok(hitS, 'search found the task')
  assert.ok(hitS.lunar && /\d{4}-\d{2}-\d{2} · /.test(hitS.lunar), 'search row carries the lunar annotation (was silently ignored)')
  const ymd = dayjs(tomorrow9()).format('YYYY-MM-DD')
  const outO = runCli(['list', '--on', ymd, '--lunar', '--json'])
  const hitO = outO.data.find(t => t.taskId === dated.taskId)
  assert.ok(hitO, '--on found the task')
  assert.ok(hitO.lunar && /\d{4}-\d{2}-\d{2} · /.test(hitO.lunar), '--on row carries the lunar annotation')
})

/* ---------- F6-7: bare/invalid --limit normalization ---------- */
test('f6-7: list --view X --limit (bare) no longer collapses the result', () => {
  const cat = lib.addCategory('f6限额分类')
  for (const n of ['甲', '乙', '丙']) seed({ taskContent: 'f6限额任务' + n, categoryId: cat.categoryId, todoTime: tomorrow9() })
  const v = lib.viewAdd('f6视图丙', { category: String(cat.categoryId) })
  const bare = runCli(['list', '--view', v.id, '--limit', '--json'])
  assert.equal(bare.data.length, 3, 'bare --limit falls back to the default cap (slice(0, Number(true)) used to empty the list)')
  const two = runCli(['list', '--view', v.id, '--limit', '2', '--json'])
  assert.equal(two.data.length, 2, 'a valid --limit still caps the rows')
  const bad = runCli(['list', '--all', '--limit', 'abc', '--json'])
  assert.notEqual(bare.data.length, 1)
  assert.ok(Array.isArray(bad.data), 'non-numeric --limit does not throw')
})

/* ---------- F6-8: multi-field edit resolves once ---------- */
test('f6-8: edit --content rename + --remind-offset in one command applies both to the same task', () => {
  const t = seed({ taskContent: 'f6改名字任务', todoTime: tomorrow9(), reminderTime: tomorrow9() })
  const out = runCli(['edit', 'f6改名字', '--content', 'f6新名字任务', '--remind-offset', '10', '--json'])
  assert.equal(out.ok, true)
  const row = db.call('getById', t.taskId)
  assert.equal(row.taskContent, 'f6新名字任务', 'rename applied')
  assert.deepEqual(row.reminderOffsets, [-10],
    'offset applied to the SAME task (after the rename it used to re-resolve the old keyword and could mutate a different match)')
  assert.equal(row.reminderTime, t.reminderTime, 'main reminder untouched by the offset write')
})
