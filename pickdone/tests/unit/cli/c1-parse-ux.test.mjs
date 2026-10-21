/**
 * C1 fix round — parse/UX hardening regression tests (review-confirmed issues):
 *   C1-1  unknown flags fail with USAGE instead of being silently swallowed
 *         (`add x --dat tomorrow` used to create an undated task with exit 0)
 *   C1-2  value-taking keys reject a following `--flag` token
 *         (`edit id --content --urgent` used to write content=1)
 *   C1-3  bare `--estimate` guard (used to silently write estimate=1 via Number(true))
 *   C1-4  undo/delete/restore/edit usage checks run BEFORE the --dry-run branch
 *         (bare `undo --dry-run` used to die on resolveTask(undefined) → INTERNAL)
 *   C1-5  `edit --desc ""` clears the description; empty --content is rejected
 *   C1-6  setEstimate warns + tags clamped:true / ignored:true instead of silent clamping
 *   C1-7  INTERNAL errors print the stack to stderr
 *   C1-8  done already-complete skip envelope uses the top-level emitNext shape
 *   C1-9  help text --limit cap matches the real 5000 cap (lib-tasks.cjs)
 * Each CLI case spawns `node cli/pickdone.js` against a temp TODO_DB_DIR (never real data).
 * Run: node --test tests/unit/cli/c1-parse-ux.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..', '..', '..')
const CLI = path.join(ROOT, 'cli', 'pickdone.js')
process.env.TODO_DB_DIR = isolatedTmpDir('todo-cli-c1-')

function runCli (args) {
  // 120s: on a heavily loaded dev box a cold CLI spawn (better-sqlite3 load) can take >30s
  return spawnSync(process.execPath, [CLI, ...args], { env: { ...process.env }, encoding: 'utf8', timeout: 120000 })
}
/** JSON run with --json injected right after the command (so trailing value flags stay trailing) */
function runJson (args) {
  const [cmd, ...rest] = args
  const r = runCli([cmd, '--json', ...rest])
  assert.equal(r.status, 0, `expected exit 0 for "${args.join(' ')}" — stderr: ${r.stderr}`)
  return JSON.parse(r.stdout)
}
function errEnvelope (r, args) {
  assert.equal(r.status, 1, `expected exit 1 for "${args.join(' ')}" — stdout: ${r.stdout}`)
  return JSON.parse(r.stderr)
}

let _seq = 0
const addTask = (content, extra = []) => runJson(['add', content + ' #' + (++_seq), ...extra]).data

/* ---------------- C1-1: unknown flag → USAGE ---------------- */
test('c1-1: typo flag on add fails with USAGE instead of silently creating an undated task', () => {
  const r = runCli(['add', 'c1 unknown flag probe', '--dat', 'tomorrow', '--json'])
  const e = errEnvelope(r, ['add ... --dat tomorrow'])
  assert.equal(e.error, 'USAGE')
  assert.ok(e.message.includes('--dat'), 'error names the offending flag: ' + e.message)
  // nothing was written by the rejected command
  const rows = runJson(['search', 'c1 unknown flag probe'])
  assert.equal(rows.data.length, 0, 'the misspelled-flag command must not create anything')
})

test('c1-1b: unknown flag on a read command fails with USAGE too', () => {
  const e = errEnvelope(runCli(['list', '--kw', 'x', '--json']), ['list --kw x'])
  assert.equal(e.error, 'USAGE')
  assert.ok(e.message.includes('--kw'))
})

test('c1-1c: known flags still work after the whitelist (add --desc/--date/--estimate, list --view/--keyword/--lunar)', () => {
  const t = addTask('c1 whitelist sanity', ['--date', 'tomorrow', '--desc', 'd1', '--estimate', '4'])
  assert.equal(t.taskContent.includes('c1 whitelist sanity'), true)
  assert.equal(runJson(['get', String(t.taskId)]).data.tomatoEstimate, 4)
  const rows = runJson(['list', '--all', '--keyword', 'whitelist sanity'])
  assert.equal(rows.data.length, 1)
})

/* ---------------- C1-2: value-key followed by a flag → USAGE, no silent write ---------------- */
test('c1-2: `edit id --content --urgent` is rejected, content is NOT written as 1', () => {
  const t = addTask('c1 content flag guard')
  const e = errEnvelope(runCli(['edit', String(t.taskId), '--content', '--urgent', '--json']), ['edit --content --urgent'])
  assert.equal(e.error, 'USAGE')
  assert.ok(e.message.includes('--content requires a value'), e.message)
  const back = runJson(['get', String(t.taskId)]).data
  assert.ok(back.taskContent.includes('c1 content flag guard'), 'content unchanged, got: ' + back.taskContent)
  assert.equal(back.urgent, 0, 'urgent untouched')
})

/* ---------------- C1-3: bare --estimate ---------------- */
test('c1-3: trailing bare `--estimate` fails with USAGE instead of writing estimate=1', () => {
  const t = addTask('c1 bare estimate')
  const e = errEnvelope(runCli(['edit', String(t.taskId), '--estimate', '--json']), ['edit --estimate'])
  assert.equal(e.error, 'USAGE')
  assert.equal(runJson(['get', String(t.taskId)]).data.tomatoEstimate, 0, 'no estimate written')
})

/* ---------------- C1-4: usage checks run before the dry-run branch ---------------- */
test('c1-4: bare `undo/delete/restore --dry-run` reports USAGE, not INTERNAL', () => {
  for (const c of ['undo', 'delete', 'restore']) {
    const e = errEnvelope(runCli([c, '--dry-run', '--json']), [c, '--dry-run'])
    assert.equal(e.error, 'USAGE', c + ' must fail with USAGE, got: ' + e.error + ' ' + e.message)
    assert.ok(e.message.includes('usage: ' + c), e.message)
  }
})

test('c1-4b: `edit --content x --dry-run` without a target reports USAGE, not INTERNAL', () => {
  const e = errEnvelope(runCli(['edit', '--content', 'x', '--dry-run', '--json']), ['edit --content x --dry-run'])
  assert.equal(e.error, 'USAGE')
})

test('c1-4c: edit/delete --dry-run still previews when a target IS given', () => {
  const t = addTask('c1 dry preview ok')
  const d = runJson(['edit', String(t.taskId), '--content', 'c1 dry preview renamed', '--dry-run'])
  assert.equal(d.data.dryRun, true)
  assert.equal(d.data.patch.taskContent, 'c1 dry preview renamed')
  const del = runJson(['delete', String(t.taskId), '--dry-run'])
  assert.equal(del.data.would, 'soft delete → recycle bin')
  runJson(['undo', String(t.taskId)]) // no-op safety: task was never completed
})

/* ---------------- C1-5: empty-string values ---------------- */
test('c1-5: `edit --desc ""` clears the description (was: "edit requires at least one field")', () => {
  const t = addTask('c1 desc clear', ['--desc', 'old description'])
  const r = runJson(['edit', String(t.taskId), '--desc', ''])
  assert.equal(r.data.taskDescribe, '', 'description cleared')
  assert.equal(runJson(['get', String(t.taskId)]).data.taskDescribe, '')
})

test('c1-5b: `edit --content ""` is rejected with USAGE (blank title would write an unmatchable row)', () => {
  const t = addTask('c1 empty title guard')
  const e = errEnvelope(runCli(['edit', String(t.taskId), '--content', '', '--json']), ['edit --content ""'])
  assert.equal(e.error, 'USAGE')
  assert.ok(e.message.includes('cannot be empty'), e.message)
  assert.ok(runJson(['get', String(t.taskId)]).data.taskContent.includes('c1 empty title guard'))
})

/* ---------------- C1-6: setEstimate clamp/ignore visibility ---------------- */
test('c1-6: --estimate 99 clamps to 20 with a stderr warning and clamped:true in JSON', () => {
  const t = addTask('c1 estimate clamp')
  const r = runCli(['edit', String(t.taskId), '--json', '--estimate', '99'])
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout)
  assert.equal(out.data.tomatoEstimate, 20)
  assert.equal(out.data.clamped, true)
  assert.ok(r.stderr.includes('clamped'), 'stderr warns: ' + r.stderr)
})

test('c1-6b: --estimate abc is ignored (stored as 0) with a stderr warning and ignored:true', () => {
  const t = addTask('c1 estimate garbage')
  const r = runCli(['edit', String(t.taskId), '--json', '--estimate', 'abc'])
  assert.equal(r.status, 0)
  const out = JSON.parse(r.stdout)
  assert.equal(out.data.tomatoEstimate, 0)
  assert.equal(out.data.ignored, true)
  assert.ok(r.stderr.includes('not a number'), 'stderr warns: ' + r.stderr)
  assert.equal(out.data.clamped, undefined)
})

test('c1-6c: in-range estimate carries no clamped/ignored markers', () => {
  const t = addTask('c1 estimate normal')
  const out = runJson(['edit', String(t.taskId), '--estimate', '5'])
  assert.equal(out.data.tomatoEstimate, 5)
  assert.equal(out.data.clamped, undefined)
  assert.equal(out.data.ignored, undefined)
})

/* ---------------- C1-7: INTERNAL errors keep the stack on stderr ---------------- */
test('c1-7: a non-CliError crash prints the stack to stderr alongside the INTERNAL envelope', () => {
  const badDb = path.join(isolatedTmpDir('todo-cli-c1-bad-'), 'todos.db')
  fs.writeFileSync(badDb, 'this is not a database')
  const r = spawnSync(process.execPath, [CLI, 'overview', '--json'], {
    env: { ...process.env, TODO_DB_DIR: badDb }, encoding: 'utf8', timeout: 30000
  })
  assert.equal(r.status, 1)
  const e = JSON.parse(r.stderr.split('\n').filter(l => l.startsWith('{'))[0])
  assert.equal(e.error, 'INTERNAL')
  assert.ok(r.stderr.includes('\n    at '), 'stderr carries a stack trace')
})

/* ---------------- C1-8: done already-complete envelope shape ---------------- */
test('c1-8: skipped done reports top-level ok/command with skipped inside data (emitNext shape)', () => {
  const t = addTask('c1 done skip shape')
  runJson(['done', String(t.taskId)])
  const out = runJson(['done', String(t.taskId)])
  assert.equal(out.ok, true)
  assert.equal(out.command, 'done')
  assert.equal(out.data.skipped, true)
  assert.equal(out.data.ok, undefined, 'ok must NOT be nested inside data')
  assert.equal(out.data.command, undefined)
  assert.equal(out.data.renewed, null, 'renewed stays present (null) for a skipped completion')
})

/* ---------------- C1-9: help text matches the real --limit cap ---------------- */
test('c1-9: help documents the real 5000 limit cap (lib-tasks.cjs clamp), not the stale 500', () => {
  const require_ = createRequire(import.meta.url)
  const { HELP } = require_(path.join(ROOT, 'cli', 'cli-help.cjs'))
  assert.ok(HELP.includes('max 5000'), 'help must say max 5000')
  assert.ok(!HELP.includes('max 500,'), 'stale "max 500" text must be gone')
})

/* [C1 #1] out-of-range HH:mm in the three time-bearing date forms must be REJECTED with a
 * time-specific CliError, never dayjs-carried into another day (App nlDate rejects h>23 —
 * the CLI accepting `tomorrow 25:00` split the two surfaces' semantics). */
test('C1-11 parseDate rejects out-of-range hour/minute in offset/keyword/bare-MD time parts', async () => {
  const { execFileSync } = await import('node:child_process')
  const path = await import('node:path')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'c1-date-'))
  const run = (args) => {
    let out = ''
    try {
      out = execFileSync(process.execPath, ['cli/pickdone.js', ...args, '--json'], {
        cwd: path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), '../../..'),
        env: { ...process.env, TODO_USER_DATA_DIR: ud, TODO_ISOLATION_OK: '1' },
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (e) { out = (e.stdout || '') + (e.stderr || '') }
    return out
  }
  for (const date of ['+2d 25:00', 'tomorrow 25:00', 'tomorrow 09:99', '9/15 24:00']) {
    const raw = run(['add', 't-' + date, '--date', date])
    assert.match(raw, /invalid time/, date + ' must be rejected with a time-specific error')
    assert.doesNotMatch(raw, /"ok"\s*:\s*true/, date + ' must not succeed')
  }
  // sanity: a valid time still works end-to-end
  const ok = run(['add', 't-valid-time', '--date', 'tomorrow 09:00'])
  assert.match(ok, /"ok"\s*:\s*true/, 'valid HH:mm still succeeds')
})
