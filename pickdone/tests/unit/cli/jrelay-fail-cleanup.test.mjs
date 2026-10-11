/* journey-relay.cjs fail-cleanup + boot-gate regression (OFFLINE: no SSH, no network, no
 * process spawn — pure source-contract pins, runs in well under 60s).
 *
 * Pins the two leak/deadlock classes observed in real runs:
 *   1. FAIL/interrupt path must ALWAYS run killInstances before exiting — a mid-journey
 *      failure or Ctrl+C otherwise leaks device A's spawned instance holding the temp dir.
 *   2. killInstances is strictly PATH-scoped ($_ .Path -eq) — never a bare process-name
 *      kill, so real installs / drill instances (e.g. C:\pickdone-drill) are untouchable.
 *   3. The boot poll gates the first local CLI call on the app-owned todos.db — an eager
 *      CLI poll creates a plaintext DB and forces the exe into migration (db.key superseded,
 *      bus unreachable: APP_NOT_RUNNING observed for 60s+ on 2026-10-11).
 *
 * Run: node --test tests/unit/cli/jrelay-fail-cleanup.test.mjs */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const src = readFileSync(join(fileURLToPath(new URL('.', import.meta.url)), '..', '..', '..', 'cli', 'journey-relay.cjs'), 'utf8')

test('FAIL path: step-loop break is followed by killInstances BEFORE process.exit(1)', () => {
  const runner = src.slice(src.indexOf('(async () => {'))
  const idxKill = runner.indexOf('await killInstances()')
  const idxFail = runner.indexOf("if (failed)")
  const idxExit1 = runner.indexOf('process.exit(1)')
  assert.ok(idxKill > -1, 'runner must call await killInstances() after the step loop')
  assert.ok(idxFail > -1 && idxExit1 > -1, 'runner must gate process.exit(1) on the failed flag')
  assert.ok(idxKill < idxExit1, `killInstances (at ${idxKill}) must run before exit(1) (at ${idxExit1})`)
  // the success path must clean up too (final killInstances before exit(0))
  const idxExit0 = runner.indexOf('process.exit(0)')
  const idxKill2 = runner.indexOf('await killInstances()', idxKill + 1)
  assert.ok(idxKill2 > -1 && idxKill2 < idxExit0, 'a second cleanup must run before exit(0)')
})

test('interrupt hardening: SIGINT/SIGTERM handlers route through the path-scoped cleanup', () => {
  assert.ok(src.includes("process.on('SIGINT'"), 'SIGINT handler must be registered')
  assert.ok(src.includes("process.on('SIGTERM'"), 'SIGTERM handler must be registered')
  const handler = src.slice(src.indexOf('function interruptCleanup'), src.indexOf("process.on('SIGINT'"))
  assert.ok(handler.includes('interrupted'), 'handler must be re-entrant guarded')
  assert.ok(handler.includes('killInstances()'), 'handler must run the SAME killInstances cleanup')
  assert.ok(handler.includes('process.exit('), 'handler must terminate the process after cleanup')
})

test('killInstances is strictly PATH-scoped — bare process-name kills are forbidden', () => {
  const fn = src.slice(src.indexOf('async function killInstances'), src.indexOf('/* Interrupt hardening'))
  const scoped = (fn.match(/\.Path -eq/g) || []).length
  assert.ok(scoped >= 2, `local AND remote filters must be path-scoped (found ${scoped})`)
  // anywhere in the file: a Stop-Process NOT preceded by a Path filter would endanger real installs
  for (const m of src.matchAll(/Stop-Process[^\n]*/g)) {
    const window = src.slice(Math.max(0, m.index - 400), m.index)
    assert.ok(/Path -eq/.test(window), 'every Stop-Process must sit behind a $_.Path -eq filter: ' + m[0])
  }
})

test('boot poll gates the first local CLI call on the app-owned todos.db', () => {
  const boot = src.slice(src.indexOf("step('boot:"), src.indexOf("step('enable:"))
  const gateIdx = boot.indexOf("fs.existsSync(path.join(A.ud, 'todos.db'))")
  const firstCli = boot.indexOf('cliLocalEnv(')
  assert.ok(gateIdx > -1, 'local boot poll must gate on todos.db existence')
  assert.ok(firstCli > gateIdx, `the todos.db gate (at ${gateIdx}) must precede the first CLI poll (at ${firstCli})`)
  assert.ok(boot.includes("test -f '${B_UD_POSIX()}/todos.db'"), 'remote boot poll must gate on the remote todos.db too')
})
