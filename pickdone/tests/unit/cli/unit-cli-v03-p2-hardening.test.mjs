/** Regression suite for the review P2 hardening batch (2026-09-10):
 *  1. category add --folder --parent rejected (nested folders are invisible in the App)
 *  2. project --status + --deadline apply BOTH flags (previously the second silently dropped)
 *  3. list --view + --on is a usage error (--view owns the date window)
 *  4. batch done on already-complete tasks is an idempotent skip (completedAt untouched, not counted)
 *  5. main-process audit: recordCustom lands + rotation-window retry keeps the line */
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'module'
import { test } from 'node:test'
import assert from 'node:assert/strict'

process.env.TODO_DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-p2-'))
const require_ = createRequire(import.meta.url)
const db = require_('../../../src/main/db.js')
const lib = require_('../../../cli/lib.js')

db.init(process.env.TODO_DB_DIR)
const ROOT = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..')
const ENV = { ...process.env, TODO_DB_DIR: process.env.TODO_DB_DIR }
const run = (args) => JSON.parse(execFileSync(process.execPath, [path.join(ROOT, 'cli', 'pickdone.js'), ...args], { encoding: 'utf8', env: ENV, timeout: 120000 }))

let seq = 0
function seed (over = {}) {
  const now = Date.now() + (seq++)
  const t = {
    complete: false, createTime: now, delete: false, reminderTime: 0, reminderOffsets: [],
    estimate: 0, difficulty: 0, repeatId: null, subtasks: null, image: null, files: null,
    categoryId: 0, updateTime: now, syncTime: 0, taskContent: 'p2 task', taskDescribe: '',
    taskSort: 0, todoTime: 0, userId: 1, status: 'add', version: 0, ...over
  }
  db.call('upsert', t)
  return t
}

test('P2-1: category add --folder --parent is rejected (nested folders invisible in App)', () => {
  lib.addCategory('P2Outer', { folder: true })
  assert.throws(() => lib.addCategory('P2Nested', { folder: true, parent: 'P2Outer' }), e => e.code === 'CATEGORY_NESTED_FOLDER')
})

test('P2-2: project --status and --deadline apply in one invocation', () => {
  lib.addCategory('P2Proj')
  lib.setProjectFlag('P2Proj', true)
  const r = run(['project', 'P2Proj', '--status', 'paused', '--deadline', '+14d', '--json'])
  assert.equal(r.ok, true)
  assert.equal(r.data.status, 'paused')
  assert.ok(r.data.deadline > Date.now(), 'deadline must be set alongside status')
})

test('P2-3: list --view + --on is a usage error', () => {
  lib.viewAdd('p2view', {})
  let out = ''
  try {
    out = execFileSync(process.execPath, [path.join(ROOT, 'cli', 'pickdone.js'), 'list', '--view', 'p2view', '--on', 'today', '--json'], { encoding: 'utf8', env: ENV, timeout: 120000 })
  } catch (e) { out = (e.stdout || '') + (e.stderr || '') } // usage errors exit non-zero; the JSON envelope goes to stderr
  const j = JSON.parse(out)
  assert.equal(j.ok, false)
  assert.equal(j.error, 'USAGE')
})

test('P2-4: batch done on already-complete tasks is an idempotent skip', () => {
  const a = seed({ taskId: 'tid_p2_a', taskContent: 'p2 already done', complete: true, completedAt: 1757000000000 })
  seed({ taskId: 'tid_p2_b', taskContent: 'p2 fresh' })
  const r = lib.batchRun('done', ['tid_p2_a', 'tid_p2_b'], {})
  assert.equal(r.changed, 1, 'only the fresh task counts as changed')
  assert.equal(r.failures.length, 0)
  const skipped = r.outcomes.find(o => o.taskId === 'tid_p2_a')
  assert.equal(skipped.skipped, true)
  const after = db.call('getById', a.taskId)
  assert.equal(after.completedAt, 1757000000000, 'completedAt must stay untouched')
})

test('P2-5: audit recordCustom lands and survives a rotation window', () => {
  process.env.TODO_USER_DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-p2-audit-'))
  const audit = require_('../../../src/main/audit.js')
  audit.resetForTests()
  audit.setDirResolver(() => process.env.TODO_USER_DATA_DIR)
  audit.setMaxBytes(50) // tiny: the second entry must rotate the first away
  audit.recordCustom('import', ['import:run', 'x.csv'], [], [], 'imported 7 task(s)')
  audit.recordCustom('import', ['import:run', 'y.csv'], [], [], 'imported 3 task(s)')
  const file = audit.auditFile()
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.equal(lines.length, 1, 'the first line rotated away')
  assert.equal(lines[0].note, 'imported 3 task(s)')
  assert.equal(lines[0].actor, 'app')
  // Rotation archives are timestamped (cross-process safe, 2026-09-10 review): find any archive of the active file
  const base = path.basename(file)
  const archives = fs.readdirSync(path.dirname(file)).filter(f => f.startsWith(base + '.') && f !== base)
  assert.equal(archives.length, 1, 'exactly one timestamped archive')
  const rolled = JSON.parse(fs.readFileSync(path.join(path.dirname(file), archives[0]), 'utf8').trim().split('\n')[0])
  assert.equal(rolled.note, 'imported 7 task(s)')
})
