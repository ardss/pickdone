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
 *   C1-11 parseDate rejects out-of-range hour/minute in every time-bearing date form
 * Each CLI case spawns `node cli/pickdone.js` against a temp TODO_DB_DIR (never real data).
 *
 * D6 execution-model fix (2026-10-23, root-caused — docs/perf-debt-ledger.md D6):
 *   The old file ran ~40 CLI children STRICTLY SEQUENTIALLY (spawnSync per call) against one
 *   file-wide fixture dir. Under a loaded full-suite run (4 concurrent files, each spawning
 *   its own CLI children), per-child wall time inflates ~10-20x (measured 0.8-2s quiet →
 *   5.8-22.6s loaded, parent-side gaps 1-4ms — pure process-creation contention, NOT a db
 *   lock), so the serial chain needed >300s and node --test executed the whole FILE at the
 *   per-file ceiling ("not ok ... c1-parse-ux.test.mjs (300139ms)", 2/2 loaded repros).
 *   Fix, same assertions verbatim:
 *     - one isolated fixture dir PER TEST (never a shared file-wide db);
 *     - tests run with bounded in-file concurrency (8 lanes) via async spawn helpers, so
 *       wall time is Σ(spawns)/lanes instead of Σ(spawns);
 *     - every child has an awaited exit + a hard 120s kill timeout (the old C1-11
 *       execFileSync had NO timeout — an unbounded sync block is a 300s-ceiling hazard);
 *     - no sleeps, no retries: a slow child still fails the run, it just no longer
 *       starves 15 unrelated tests behind it in a serial chain.
 * Run: node --test tests/unit/cli/c1-parse-ux.test.mjs
 */
import { test, describe } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { isolatedTmpDir } from '../../lib/tmp-dir.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..', '..', '..')
const CLI = path.join(ROOT, 'cli', 'pickdone.js')

// 120s kill ceiling per child: on a heavily loaded dev box a cold CLI spawn
// (better-sqlite3 load) can take >30s, but a hung child must never outlive the file.
const CHILD_TIMEOUT_MS = 120000

/** Async CLI child with an awaited exit, piped+captured stdio and a hard kill timeout.
 *  Each test passes ITS OWN fixture dir; the env is per-child, so process.env is never
 *  mutated (the bare file-wide TODO_DB_DIR assignment was tmp-dir.mjs hygiene debt). */
function runCli (dir, args, { timeout = CHILD_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, TODO_DB_DIR: dir }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    const out = []
    const err = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch { /* already gone */ }
      reject(new Error(`CLI child timed out after ${timeout}ms: pickdone.js ${args.join(' ')}`))
    }, timeout)
    child.stdout.on('data', d => out.push(d))
    child.stderr.on('data', d => err.push(d))
    child.on('error', e => { if (!settled) { settled = true; clearTimeout(timer); reject(e) } })
    child.on('close', (status, signal) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ status, signal, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') })
    })
  })
}
/** JSON run with --json injected right after the command (so trailing value flags stay trailing) */
async function runJson (dir, args) {
  const [cmd, ...rest] = args
  const r = await runCli(dir, [cmd, '--json', ...rest])
  assert.equal(r.status, 0, `expected exit 0 for "${args.join(' ')}" — stderr: ${r.stderr}`)
  return JSON.parse(r.stdout)
}
function errEnvelope (r, args) {
  assert.equal(r.status, 1, `expected exit 1 for "${args.join(' ')}" — stdout: ${r.stdout}`)
  return JSON.parse(r.stderr)
}

let _seq = 0
const addTask = (dir, content, extra = []) => runJson(dir, ['add', content + ' #' + (++_seq), ...extra]).then(x => x.data)

describe('c1 parse/UX hardening (real CLI children, per-test fixture, 8 lanes)', { concurrency: 8 }, () => {
  /* ---------------- C1-1: unknown flag → USAGE ---------------- */
  test('c1-1: typo flag on add fails with USAGE instead of silently creating an undated task', async () => {
    const dir = isolatedTmpDir('todo-cli-c1-')
    const r = await runCli(dir, ['add', 'c1 unknown flag probe', '--dat', 'tomorrow', '--json'])
    const e = errEnvelope(r, ['add ... --dat tomorrow'])
    assert.equal(e.error, 'USAGE')
    assert.ok(e.message.includes('--dat'), 'error names the offending flag: ' + e.message)
    // nothing was written by the rejected command
    const rows = await runJson(dir, ['search', 'c1 unknown flag probe'])
    assert.equal(rows.data.length, 0, 'the misspelled-flag command must not create anything')
  })

  test('c1-1b: unknown flag on a read command fails with USAGE too', async () => {
    const dir = isolatedTmpDir('todo-cli-c1-')
    const e = errEnvelope(await runCli(dir, ['list', '--kw', 'x', '--json']), ['list --kw x'])
    assert.equal(e.error, 'USAGE')
    assert.ok(e.message.includes('--kw'))
  })

  test('c1-1c: known flags still work after the whitelist (add --desc/--date/--estimate, list --view/--keyword/--lunar)', async () => {
    const dir = isolatedTmpDir('todo-cli-c1-')
    const t = await addTask(dir, 'c1 whitelist sanity', ['--date', 'tomorrow', '--desc', 'd1', '--estimate', '4'])
    assert.equal(t.taskContent.includes('c1 whitelist sanity'), true)
    assert.equal((await runJson(dir, ['get', String(t.taskId)])).data.tomatoEstimate, 4)
    const rows = await runJson(dir, ['list', '--all', '--keyword', 'whitelist sanity'])
    assert.equal(rows.data.length, 1)
  })

  /* ---------------- C1-2: value-key followed by a flag → USAGE, no silent write ---------------- */
  test('c1-2: `edit id --content --urgent` is rejected, content is NOT written as 1', async () => {
    const dir = isolatedTmpDir('todo-cli-c1-')
    const t = await addTask(dir, 'c1 content flag guard')
    const e = errEnvelope(await runCli(dir, ['edit', String(t.taskId), '--content', '--urgent', '--json']), ['edit --content --urgent'])
    assert.equal(e.error, 'USAGE')
    assert.ok(e.message.includes('--content requires a value'), e.message)
    const back = (await runJson(dir, ['get', String(t.taskId)])).data
    assert.ok(back.taskContent.includes('c1 content flag guard'), 'content unchanged, got: ' + back.taskContent)
    assert.equal(back.urgent, 0, 'urgent untouched')
  })

  /* ---------------- C1-3: bare --estimate ---------------- */
  test('c1-3: trailing bare `--estimate` fails with USAGE instead of writing estimate=1', async () => {
    const dir = isolatedTmpDir('todo-cli-c1-')
    const t = await addTask(dir, 'c1 bare estimate')
    const e = errEnvelope(await runCli(dir, ['edit', String(t.taskId), '--estimate', '--json']), ['edit --estimate'])
    assert.equal(e.error, 'USAGE')
    assert.equal((await runJson(dir, ['get', String(t.taskId)])).data.tomatoEstimate, 0, 'no estimate written')
  })

  /* ---------------- C1-4: usage checks run before the dry-run branch ---------------- */
  test('c1-4: bare `undo/delete/restore --dry-run` reports USAGE, not INTERNAL', async () => {
    const dir = isolatedTmpDir('todo-cli-c1-')
    for (const c of ['undo', 'delete', 'restore']) {
      const e = errEnvelope(await runCli(dir, [c, '--dry-run', '--json']), [c, '--dry-run'])
      assert.equal(e.error, 'USAGE', c + ' must fail with USAGE, got: ' + e.error + ' ' + e.message)
      assert.ok(e.message.includes('usage: ' + c), e.message)
    }
  })

  test('c1-4b: `edit --content x --dry-run` without a target reports USAGE, not INTERNAL', async () => {
    const dir = isolatedTmpDir('todo-cli-c1-')
    const e = errEnvelope(await runCli(dir, ['edit', '--content', 'x', '--dry-run', '--json']), ['edit --content x --dry-run'])
    assert.equal(e.error, 'USAGE')
  })

  test('c1-4c: edit/delete --dry-run still previews when a target IS given', async () => {
    const dir = isolatedTmpDir('todo-cli-c1-')
    const t = await addTask(dir, 'c1 dry preview ok')
    const d = await runJson(dir, ['edit', String(t.taskId), '--content', 'c1 dry preview renamed', '--dry-run'])
    assert.equal(d.data.dryRun, true)
    assert.equal(d.data.patch.taskContent, 'c1 dry preview renamed')
    const del = await runJson(dir, ['delete', String(t.taskId), '--dry-run'])
    assert.equal(del.data.would, 'soft delete → recycle bin')
    await runJson(dir, ['undo', String(t.taskId)]) // no-op safety: task was never completed
  })

  /* ---------------- C1-5: empty-string values ---------------- */
  test('c1-5: `edit --desc ""` clears the description (was: "edit requires at least one field")', async () => {
    const dir = isolatedTmpDir('todo-cli-c1-')
    const t = await addTask(dir, 'c1 desc clear', ['--desc', 'old description'])
    const r = await runJson(dir, ['edit', String(t.taskId), '--desc', ''])
    assert.equal(r.data.taskDescribe, '', 'description cleared')
    assert.equal((await runJson(dir, ['get', String(t.taskId)])).data.taskDescribe, '')
  })

  test('c1-5b: `edit --content ""` is rejected with USAGE (blank title would write an unmatchable row)', async () => {
    const dir = isolatedTmpDir('todo-cli-c1-')
    const t = await addTask(dir, 'c1 empty title guard')
    const e = errEnvelope(await runCli(dir, ['edit', String(t.taskId), '--content', '', '--json']), ['edit --content ""'])
    assert.equal(e.error, 'USAGE')
    assert.ok(e.message.includes('cannot be empty'), e.message)
    assert.ok((await runJson(dir, ['get', String(t.taskId)])).data.taskContent.includes('c1 empty title guard'))
  })

  /* ---------------- C1-6: setEstimate clamp/ignore visibility ---------------- */
  test('c1-6: --estimate 99 clamps to 20 with a stderr warning and clamped:true in JSON', async () => {
    const dir = isolatedTmpDir('todo-cli-c1-')
    const t = await addTask(dir, 'c1 estimate clamp')
    const r = await runCli(dir, ['edit', String(t.taskId), '--json', '--estimate', '99'])
    assert.equal(r.status, 0)
    const out = JSON.parse(r.stdout)
    assert.equal(out.data.tomatoEstimate, 20)
    assert.equal(out.data.clamped, true)
    assert.ok(r.stderr.includes('clamped'), 'stderr warns: ' + r.stderr)
  })

  test('c1-6b: --estimate abc is ignored (stored as 0) with a stderr warning and ignored:true', async () => {
    const dir = isolatedTmpDir('todo-cli-c1-')
    const t = await addTask(dir, 'c1 estimate garbage')
    const r = await runCli(dir, ['edit', String(t.taskId), '--json', '--estimate', 'abc'])
    assert.equal(r.status, 0)
    const out = JSON.parse(r.stdout)
    assert.equal(out.data.tomatoEstimate, 0)
    assert.equal(out.data.ignored, true)
    assert.ok(r.stderr.includes('not a number'), 'stderr warns: ' + r.stderr)
    assert.equal(out.data.clamped, undefined)
  })

  test('c1-6c: in-range estimate carries no clamped/ignored markers', async () => {
    const dir = isolatedTmpDir('todo-cli-c1-')
    const t = await addTask(dir, 'c1 estimate normal')
    const out = await runJson(dir, ['edit', String(t.taskId), '--estimate', '5'])
    assert.equal(out.data.tomatoEstimate, 5)
    assert.equal(out.data.clamped, undefined)
    assert.equal(out.data.ignored, undefined)
  })

  /* ---------------- C1-7: INTERNAL errors keep the stack on stderr ---------------- */
  test('c1-7: a non-CliError crash prints the stack to stderr alongside the INTERNAL envelope', async () => {
    const badDb = path.join(isolatedTmpDir('todo-cli-c1-bad-'), 'todos.db')
    fs.writeFileSync(badDb, 'this is not a database')
    const r = await runCli(badDb, ['overview', '--json'])
    assert.equal(r.status, 1)
    const e = JSON.parse(r.stderr.split('\n').filter(l => l.startsWith('{'))[0])
    assert.equal(e.error, 'INTERNAL')
    assert.ok(r.stderr.includes('\n    at '), 'stderr carries a stack trace')
  })

  /* ---------------- C1-8: done already-complete envelope shape ---------------- */
  test('c1-8: skipped done reports top-level ok/command with skipped inside data (emitNext shape)', async () => {
    const dir = isolatedTmpDir('todo-cli-c1-')
    const t = await addTask(dir, 'c1 done skip shape')
    await runJson(dir, ['done', String(t.taskId)])
    const out = await runJson(dir, ['done', String(t.taskId)])
    assert.equal(out.ok, true)
    assert.equal(out.command, 'done')
    assert.equal(out.data.skipped, true)
    assert.equal(out.data.ok, undefined, 'ok must NOT be nested inside data')
    assert.equal(out.data.command, undefined)
    assert.equal(out.data.renewed, null, 'renewed stays present (null) for a skipped completion')
  })

  /* ---------------- C1-9: help text matches the real --limit cap (in-process, no child) ---------------- */
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
    // Its own fixture dir, passed explicitly as TODO_DB_DIR (user-dir priority: TODO_DB_DIR
    // wins over TODO_USER_DATA_DIR, so this is the ONE authoritative isolation knob here).
    const dir = isolatedTmpDir('todo-cli-c1-date-')
    const run = async (args) => {
      const r = await runCli(dir, args)
      return r.stdout + r.stderr
    }
    for (const date of ['+2d 25:00', 'tomorrow 25:00', 'tomorrow 09:99', '9/15 24:00']) {
      const raw = await run(['add', 't-' + date, '--date', date, '--json'])
      assert.match(raw, /invalid time/, date + ' must be rejected with a time-specific error')
      assert.doesNotMatch(raw, /"ok"\s*:\s*true/, date + ' must not succeed')
    }
    // sanity: a valid time still works end-to-end
    const ok = await run(['add', 't-valid-time', '--date', 'tomorrow 09:00', '--json'])
    assert.match(ok, /"ok"\s*:\s*true/, 'valid HH:mm still succeeds')
  })
})
