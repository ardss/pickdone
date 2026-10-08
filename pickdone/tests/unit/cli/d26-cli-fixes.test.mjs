/**
 * d26 CLI round fixes, each with a regression test that fails without the fix:
 *  - P2 categories: add/rename uniqueness is judged with the SAME normalization the resolver
 *    addresses with (normKey: NFKC + lowercase + whitespace-stripped) — `category add Work`
 *    next to "work" used to brick every later `--category work|Work` with AMBIGUOUS_MATCH;
 *  - P2 plan: the advertised `plan <date>` read form actually reads (a single positional that
 *    parses as a date routes through the same planList path `plan list <date>` uses);
 *  - P3 edit: --deadline honors the same clear words (none|clear) as --date/--reminder;
 *  - P3 repeat: bare `repeat off` reports the usage line instead of `task not found: "undefined"`.
 * Subprocess tests use isolated temp DBs (maint-r2 pattern) and never touch the real %APPDATA%.
 * Run: node --test tests/unit/cli/d26-cli-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { createRequire } from 'module'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

process.env.TODO_DB_DIR = isolatedTmpDir('todo-cli-d26-')
process.env.TODO_USER_DATA_DIR = isolatedTmpDir('todo-cli-d26-ud-')
const require_ = createRequire(import.meta.url)
const lib = require_('../../../cli/lib.js')
const schedule = require_('../../../cli/lib-schedule.cjs')
const CLI = require_.resolve('../../../cli/pickdone.js')

/* ---------- P2: category uniqueness uses the resolver's normalization ---------- */
test('d26: category add rejects case-variant duplicates (CATEGORY_EXISTS) instead of bricking the resolver', () => {
  const c = lib.addCategory('d26work')
  assert.ok(c.categoryId)
  // exact dup keeps its original error
  assert.throws(() => lib.addCategory('d26work'), e => e.code === 'CATEGORY_EXISTS')
  // case-variant dup: red before the fix (the row was created and --category then hit AMBIGUOUS_MATCH)
  assert.throws(() => lib.addCategory('D26WORK'), e => e.code === 'CATEGORY_EXISTS')
  assert.throws(() => lib.addCategory('d26 work'), e => e.code === 'CATEGORY_EXISTS', 'whitespace-stripped variants are the same key too')
  // the original name is still unambiguously addressable (case-folded resolution)
  assert.equal(lib.resolveCategory('D26WORK'), c.categoryId)
  assert.equal(lib.resolveCategory('d26work'), c.categoryId)
})

test('d26: category rename rejects a target that collides case-insensitively (CATEGORY_EXISTS)', () => {
  const a = lib.addCategory('d26alpha')
  lib.addCategory('d26beta')
  // renaming alpha → "D26BETA" must fail; red before the fix it silently created a near-duplicate
  assert.throws(() => lib.renameCategory('d26alpha', 'D26BETA'), e => e.code === 'CATEGORY_EXISTS')
  // renaming to a genuinely free name (including its own case-variant of itself) still works
  const renamed = lib.renameCategory('d26alpha', 'd26ALPHA')
  assert.equal(renamed.categoryId, a.categoryId, 'renaming to a case-variant of ITSELF is a no-op rename, not a collision')
})

/* ---------- P2: `plan <date>` read form ---------- */
const isolEnv = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd26-proc-'))
  return {
    env: { ...process.env, TODO_DB_DIR: path.join(dir, 'db'), TODO_USER_DATA_DIR: path.join(dir, 'ud') },
    dir
  }
}
const runCli = (args, env) => new Promise(resolve => {
  execFile(process.execPath, [CLI, ...args], { env, timeout: 30000 }, (err, stdout, stderr) =>
    resolve({ code: err ? (err.code ?? 1) : 0, stdout, stderr }))
})

test('d26: `plan <date>` reads the day timeline like `plan list <date>`', async () => {
  const { env, dir } = isolEnv()
  try {
    const add = await runCli(['add', 'd26 plan chip task', '--date', '2026-10-09', '--json'], env)
    assert.equal(add.code, 0, add.stderr)
    const task = JSON.parse(add.stdout).data
    const set = await runCli(['plan', 'set', String(task.taskId), '09:30', '--date', '2026-10-09', '--json'], env)
    assert.equal(set.code, 0, set.stderr)
    // red before the fix: bare `plan 2026-10-09` exited UNKNOWN_ARG even though the usage line advertises it
    const read = await runCli(['plan', '2026-10-09', '--json'], env)
    assert.equal(read.code, 0, 'plan <date> must be a read form, got: ' + read.stderr)
    const r = JSON.parse(read.stdout).data
    assert.equal(r.day, '2026-10-09')
    assert.equal(r.tasks.length, 1)
    assert.deepEqual(r.tasks[0].chips, ['09:30'])
    // parity: `plan list <date>` returns the same day
    const viaList = JSON.parse((await runCli(['plan', 'list', '2026-10-09', '--json'], env)).stdout).data
    assert.deepEqual(viaList, r)
    // relative keyword form works too
    const today = await runCli(['plan', 'today', '--json'], env)
    assert.equal(today.code, 0, today.stderr)
    // garbage single positional still reports UNKNOWN_ARG (it is not a date)
    const junk = await runCli(['plan', 'frobnicate'], env)
    assert.equal(junk.code, 1)
    assert.match(junk.stderr, /unknown sub-operation/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/* ---------- P3: edit --deadline clear ---------- */
test('d26: `edit --deadline clear` clears the deadline like `none` does (was a raw parse error)', async () => {
  const { env, dir } = isolEnv()
  try {
    const add = await runCli(['add', 'd26 deadline task', '--json'], env)
    assert.equal(add.code, 0, add.stderr)
    const task = JSON.parse(add.stdout).data
    const set = await runCli(['edit', String(task.taskId), '--deadline', '2026-10-09', '--json'], env)
    assert.equal(set.code, 0, set.stderr)
    // red before the fix: `--deadline clear` fell through to parseDate and threw cannot-parse
    const clear = await runCli(['edit', String(task.taskId), '--deadline', 'clear', '--json'], env)
    assert.equal(clear.code, 0, 'clear must be accepted, got: ' + clear.stderr)
    const after = JSON.parse(clear.stdout).data
    assert.equal(after.deadlineTs, 0)
    // none keeps working (pre-existing behavior)
    const set2 = await runCli(['edit', String(task.taskId), '--deadline', '2026-10-10', '--json'], env)
    assert.equal(set2.code, 0, set2.stderr)
    const none = await runCli(['edit', String(task.taskId), '--deadline', 'none', '--json'], env)
    assert.equal(none.code, 0, none.stderr)
    assert.equal(JSON.parse(none.stdout).data.deadlineTs, 0)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/* ---------- P3: bare `repeat off` reports usage ---------- */
test('d26: bare `repeat off` throws the USAGE line instead of `task not found: "undefined"`', async () => {
  await assert.rejects(
    async () => schedule.runRepeat({ opts: { _: ['off'] }, lib, emit: null, emitNext: null }),
    e => e.code === 'USAGE' && /usage: repeat off/.test(e.message),
    'red before the fix: repeatOff(undefined) failed as task-not-found'
  )
  // `repeat on` without a task keeps its existing usage guard (baseline)
  await assert.rejects(
    async () => schedule.runRepeat({ opts: { _: ['on'] }, lib, emit: null, emitNext: null }),
    e => e.code === 'USAGE'
  )
})
