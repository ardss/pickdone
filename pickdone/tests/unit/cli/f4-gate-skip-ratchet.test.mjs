/**
 * W32 maintenance (2026-11-03) agent F4 — gate skip-blindness fixes. Four anchors:
 *   ① [P1] live-pool skip intake: tests/run-interactions-shared.mjs now extracts each pool
 *     target's internal skip count from its stdout TAP summary, aggregates a pool total, and
 *     prints `# skip N` in its summary tail; cli/check-test-summary.cjs folds that total into
 *     the SAME skip ratchet via `--live-pool-skip=N` / env CHECK_TEST_SUMMARY_LIVE_POOL_SKIP
 *     (absent intake => behavior byte-identical, backward compatible). Previously the 9-target
 *     pool's t.skip() counts were invisible to any plan-anchored parse — the pool could be
 *     eroded by unlimited skips with the gate green.
 *   ② [P2] run-all.mjs low-confidence flake branch: the RAW-PASS1-ABOVE composition anchored
 *     the gate on the RETRY's plan, so pass1 skips escaped the ratchet entirely. run-all now
 *     appends a merged `# skip pass1+retry` line after the retry summary.
 *   ③ [P3] parity-cli-ui.test.mjs cleans its tmpdir and restores TODO_DB_DIR.
 *   ④ [P3] run-interactions-shared bootInstance closes its two log fds in reapIsolated.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PICKDONE = path.resolve(HERE, '..', '..', '..')
const CHECK_SUMMARY = path.join(PICKDONE, 'cli', 'check-test-summary.cjs')
const RUN_ALL = path.join(PICKDONE, 'tests', 'run-all.mjs')
const SHARED_POOL = path.join(PICKDONE, 'tests', 'run-interactions-shared.mjs')
const PARITY = path.join(PICKDONE, 'tests', 'unit', 'parity-cli-ui.test.mjs')

const require_ = createRequire(import.meta.url)
const { parseSummary } = require_(CHECK_SUMMARY)

const withTap = (body) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-f4-tap-'))
  const p = path.join(dir, 'fixture.tap')
  fs.writeFileSync(p, body)
  return p
}

const runSummary = (tapPath, { extraArgs = [], env = {} } = {}) =>
  spawnSync(process.execPath, [CHECK_SUMMARY, tapPath, ...extraArgs], {
    cwd: PICKDONE, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CHECK_TEST_SUMMARY_SELFTEST: '1', CHECK_TEST_SUMMARY_SKIP_BASELINE: '2', ...env }
  })

// The exact stream shape run-all's low-confidence branch emits since the W32 fix:
// raw pass1 plan+summary on top, separator, retry plan+summary (the LAST plan the gate
// anchors), then the merged pass1+retry `# skip` line appended after the retry summary.
const LOWCONF = (pass1Skip, retrySkip) =>
  `TAP version 13\n` +
  `1..3\nok 1 - pass1 a\nok 2 - pass1 b\nok 3 - pass1 c\n` +
  `# pass 3\n# fail 0\n# skip ${pass1Skip}\n# cancelled 0\n` +
  `# RAW-PASS1-ABOVE; RETRY-TAP-FOLLOWS: consumers anchor the LAST plan\n` +
  `1..1\nok 1 - retry flaky file\n` +
  `# pass 1\n# fail 0\n# skip ${retrySkip}\n# cancelled 0\n` +
  `# skip ${pass1Skip + retrySkip}\n`

test('f4#1 parseSummary on the low-confidence composed stream sees the MERGED skip (fix 2)', () => {
  const s = parseSummary(LOWCONF(2, 0))
  assert.equal(s.skip, 2, 'last-match parsing must land on the merged `# skip 2` line, not the retry-own `# skip 0`')
  assert.equal(s.fail, 0)
  assert.equal(s.pass, 1)
  assert.equal(s.cancelled, 0)
  // retry-only skips merge too (both sides can carry skips)
  const s2 = parseSummary(LOWCONF(2, 3))
  assert.equal(s2.skip, 5, 'pass1 + retry skips must sum')
})

test('f4#2 gate reds when the merged skip exceeds the ratchet (fix 2, end to end)', () => {
  const p = runSummary(withTap(LOWCONF(3, 0)))
  assert.equal(p.status, 1, 'merged skip 3 > baseline 2 must red — before the fix this read green')
  assert.match(p.stderr, /# skipped = 3/, 'the red must report the merged count')
})

test('f4#3 gate stays green when the merged skip is within the ratchet (fix 2)', () => {
  const p = runSummary(withTap(LOWCONF(2, 0)))
  assert.equal(p.status, 0, `merged skip 2 <= baseline 2 must stay green, stderr=${p.stderr}`)
})

test('f4#4 --live-pool-skip intake rides the same ratchet and reds over baseline (fix 1)', () => {
  const clean = withTap('TAP version 13\n1..1\nok 1 - x\n# pass 1\n# fail 0\n# skip 0\n# cancelled 0\n')
  const p = runSummary(clean, { extraArgs: ['--live-pool-skip=5'] })
  assert.equal(p.status, 1, 'unit skip 0 + live-pool skip 5 > baseline 2 must red')
  assert.match(p.stderr, /\+ 5\(live pool\)/, 'the red must name the live-pool share')
  const p2 = runSummary(clean, { extraArgs: ['--live-pool-skip=2'] })
  assert.equal(p2.status, 0, `unit 0 + pool 2 <= baseline 2 must stay green, stderr=${p2.stderr}`)
  assert.match(p2.stdout, /# skipped 2/, 'the green line must report the merged total')
})

test('f4#5 env intake CHECK_TEST_SUMMARY_LIVE_POOL_SKIP is honored (fix 1)', () => {
  const clean = withTap('TAP version 13\n1..1\nok 1 - x\n# pass 1\n# fail 0\n# skip 0\n# cancelled 0\n')
  const p = runSummary(clean, { env: { CHECK_TEST_SUMMARY_LIVE_POOL_SKIP: '3' } })
  assert.equal(p.status, 1, 'env-forwarded pool skip must ride the ratchet')
  assert.match(p.stderr, /\+ 3\(live pool\)/)
  const bad = runSummary(clean, { env: { CHECK_TEST_SUMMARY_LIVE_POOL_SKIP: 'not-a-number' } })
  assert.equal(bad.status, 0, 'a malformed intake must be ignored (warned), never red nor trusted')
  assert.match(bad.stderr, /非法.*已忽略/)
})

test('f4#6 backward compat: no intake => gate behavior unchanged (fix 1)', () => {
  const clean = withTap('TAP version 13\n1..1\nok 1 - x\n# pass 1\n# fail 0\n# skip 0\n# cancelled 0\n')
  const p = runSummary(clean)
  assert.equal(p.status, 0, `no intake flag/env => clean run stays green, stderr=${p.stderr}`)
  assert.match(p.stdout, /# skipped 0 ≤ 基线 2/)
})

test('f4#7 shared pool emits a pool-total `# skip N` and closes its log fds (fixes 1+4, source pins)', () => {
  const src = fs.readFileSync(SHARED_POOL, 'utf8')
  // fix 1: per-target skip extraction + pool-total summary emission
  assert.match(src, /# skip \$\{poolSkips\}/, 'the pool summary must emit the aggregated `# skip N` line')
  assert.ok(src.includes('extractSkipCount'), 'targets must have their skip count extracted from stdout')
  assert.ok(src.includes("stdio: ['ignore', 'pipe', 'inherit']"), "runTarget must pipe target stdout (old 'inherit' was blind to TAP summaries)")
  // fix 4: the two per-boot log fds must be saved and closed in reapIsolated
  assert.match(src, /logFds = \[logFdOut, logFdErr\]/, 'boot fds must be saved')
  assert.match(src, /for \(const fd of logFds\) \{ try \{ fs\.closeSync\(fd\) \} catch \{\} \}/, 'reapIsolated must close the saved fds')
  assert.ok(!/stdio: \['ignore', fs\.openSync\(logFile, 'a'\), fs\.openSync\(logFile, 'a'\)\]/.test(src), 'the leaky inline openSync stdio pair must be gone')
})

test('f4#8 run-all low-confidence branch appends the merged skip line (fix 2, source pins)', () => {
  const src = fs.readFileSync(RUN_ALL, 'utf8')
  assert.match(src, /# skip \$\{pass1Skips \+ retrySkips\}/, 'the RAW-PASS1-ABOVE stream must carry the merged skip line')
  assert.match(src, /const countSkips = tail => tail\.reduce/, 'skip counts must be parsed from both tails')
})

test('f4#9 parity-cli-ui cleans its tmpdir and restores TODO_DB_DIR (fix 3, source pins)', () => {
  const src = fs.readFileSync(PARITY, 'utf8')
  assert.match(src, /\bafter\(/, 'cleanup must run in a node:test after-hook')
  assert.match(src, /delete process\.env\.TODO_DB_DIR/, 'a previously-unset TODO_DB_DIR must be deleted, not set to undefined-string')
  assert.match(src, /rmSync\(tmpDbDir/, 'the mkdtemp db dir must be removed')
  // end to end: run the parity suite standalone and assert it stays green after the refactor
  // (the env restore itself is observable only inside the child process — the source pins above
  // pin the restore logic; a child cannot mutate this process's env to prove it from here).
  const p = spawnSync(process.execPath, [PARITY], { cwd: PICKDONE, encoding: 'utf8', timeout: 120000, env: { ...process.env, TODO_DB_DIR: '' } })
  assert.equal(p.status, 0, `parity suite must stay green after the cleanup refactor, stderr=${(p.stderr || '').slice(-600)}`)
})
