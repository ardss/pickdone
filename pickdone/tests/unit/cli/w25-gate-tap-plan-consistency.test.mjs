/**
 * W25 maintenance (2026-11-01) — TAP plan/summary unit alignment + flake-absorption
 * fail-closed semantics. Four fixes pinned here:
 *   ① run-all.mjs composed TAP: plan is now in TEST-POINT units (pass+fail+skip), the same
 *     unit as the summary lines below it — the old `1..${all.length}` counted FILE BLOCKS.
 *     cli/check-test-summary.cjs parseSummary exposes `plan` and the gate cross-checks
 *     plan vs pass+fail+skip+cancelled: composed streams (marked `# COMPOSED-TAP-FOLLOWS`)
 *     mismatch => red (fail-closed); raw node:test TAP mismatch is node's own legitimate
 *     top-level-vs-all-points semantics => loud warning only.
 *   ② run-all.mjs low-confidence absorption branch: no longer flips a red pass1 to exit 0
 *     unconditionally — green requires raw evidence (retry child exit 0 + plan line + zero
 *     not-ok lines in the retry TAP).
 *   ③ check-test-summary skip-case replay regex matches INDENTED nested `ok N ... # SKIP`.
 *   ④ tests/lib/runtime.mjs spawnApp seeds an empty todos.db only into auto-created
 *     mkdtemp dirs — an externally supplied userDataDir is reused as-is.
 *   ⑤ tests/lib/tmp-dir.mjs sweep family covers `todo-cov-` (leaked by the coverage
 *     ratchet's tmpdir mkdtemp, unreachable by tests/-source extraction).
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { sweepStaleTmpDirs } from '../../lib/tmp-dir.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PICKDONE = path.resolve(HERE, '..', '..', '..')
const RUN_ALL = path.join(PICKDONE, 'tests', 'run-all.mjs')
const CHECK_SUMMARY = path.join(PICKDONE, 'cli', 'check-test-summary.cjs')

const withTap = (body) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-w25-tap-'))
  const p = path.join(dir, 'fixture.tap')
  fs.writeFileSync(p, body)
  return p
}

const runSummary = (tapPath, env = {}) =>
  spawnSync(process.execPath, [CHECK_SUMMARY, tapPath], {
    cwd: PICKDONE, encoding: 'utf8', timeout: 60000,
    env: { ...process.env, CHECK_TEST_SUMMARY_SELFTEST: '1', CHECK_TEST_SUMMARY_SKIP_BASELINE: '0', ...env }
  })

const COMPOSED = (plan, pass, fail, skip, extraPoints = 3) =>
  `TAP version 13\n` +
  `1..2\nok 1 - raw pass1 a\nnot ok 2 - raw pass1 b\n` +
  `# COMPOSED-TAP-FOLLOWS: consumers anchor the LAST plan (raw pass1 above is evidence)\n` +
  Array.from({ length: extraPoints }, (_, i) => `ok ${i + 1} - composed point ${i + 1}`).join('\n') + '\n' +
  `1..${plan}\n# pass ${pass}\n# fail ${fail}\n# skip ${skip}\n# cancelled 0\n`

test('w25#1 composed TAP with plan == pass+fail+skip+cancelled -> green', () => {
  const p = runSummary(withTap(COMPOSED(3, 3, 0, 0)))
  assert.equal(p.status, 0, `consistent composed stream must pass, stderr=${p.stderr}`)
})

test('w25#2 composed TAP with block-count plan (the old bug shape) -> red, fail-closed', () => {
  // 3 composed test points but plan says 1..2 — exactly what `1..${all.length}` produced
  // when the corpus has fewer file blocks than test points. Low confidence must NOT read green.
  const p = runSummary(withTap(COMPOSED(2, 3, 0, 0)))
  assert.equal(p.status, 1, 'plan/summary mismatch on a COMPOSED stream must red')
  assert.match(p.stderr, /口径不一致/, 'the red must name the plan-vs-summary misalignment')
})

test('w25#3 raw node:test TAP with plan != summary points -> green + loud warning only', () => {
  // node:test legit semantics: plan counts TOP-LEVEL tests, the summary counts ALL test
  // points (nested subtests) — observed live: plan 1..5230 vs # pass 5250. Must not red.
  const p = runSummary(withTap(
    `TAP version 13\n1..2\nok 1 - top a\nok 2 - top b\n# pass 5\n# fail 0\n# skip 0\n# cancelled 0\n`
  ))
  assert.equal(p.status, 0, `raw-stream plan mismatch is node's own unit split, must stay green, stderr=${p.stderr}`)
  assert.match(p.stderr, /仅告警不拦截/, 'the mismatch must still be announced loudly')
})

test('w25#4 skip ratchet replay lists INDENTED nested skip lines (fix 3)', () => {
  const tap = [
    'TAP version 13',
    '1..2',
    'ok 1 - file block',
    '  ok 1 - nested skipped point # SKIP',
    '  ok 2 - also nested # SKIP',
    '1..2',
    '# pass 1',
    '# fail 0',
    '# skip 2',
    '# cancelled 0',
    ''
  ].join('\n')
  const p = runSummary(withTap(tap))
  assert.equal(p.status, 1, 'skip over baseline must red')
  // the replay used to filter with /^ok\b/ and miss every indented line — both names must appear
  assert.match(p.stderr, /nested skipped point/, 'indented nested skip case #1 must be named in the replay')
  assert.match(p.stderr, /also nested/, 'indented nested skip case #2 must be named in the replay')
})

test('w25#5 flake absorption composed plan is in TEST-POINT units (fix 1, sandbox e2e)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-w25-sandbox-'))
  const marker = path.join(dir, 'marker-b.flag')
  const flaky = `
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
test('flaky point', () => {
  if (!fs.existsSync(${JSON.stringify(marker)})) { fs.writeFileSync(${JSON.stringify(marker)}, '1'); assert.fail('first pass fails') }
})
test('steady point', () => assert.equal(1, 1))
`
  const steady = `
import test from 'node:test'
import assert from 'node:assert/strict'
// one nested subtest: this file yields 2 top-level ok BLOCKS but 3 TEST POINTS — exactly
// the unit split that let the old block-count plan (1..4) drift from the point count (5)
test('outer with nested', async t => { await t.test('inner point', () => assert.equal(1, 1)) })
test('flat point', () => assert.equal(1, 1))
`
  fs.mkdirSync(path.join(dir, 'tests', 'unit'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'tests', 'unit', 'a-steady.test.mjs'), steady)
  fs.writeFileSync(path.join(dir, 'tests', 'unit', 'b-flaky.test.mjs'), flaky)
  const p = spawnSync(process.execPath, [RUN_ALL], {
    cwd: dir, encoding: 'utf8', timeout: 240000,
    env: { ...process.env, TEST_CONCURRENCY: '1', GATE_META_APP_ROOT: dir }
  })
  assert.equal(p.status, 0, `flaky file re-ran green -> absorption -> exit 0. stderr tail: ${(p.stderr || '').slice(-800)}`)
  assert.match(p.stdout, /COMPOSED-TAP-FOLLOWS/, 'the composed stream must be on stdout')
  // anchored LAST plan must equal the composed corpus's test-point count (5: 2 flaky + 3 steady),
  // NOT the file-block count (2) the old `1..${all.length}` produced.
  const lines = (p.stdout || '').split(/\r?\n/)
  let planIdx = -1
  for (let i = lines.length - 1; i >= 0; i--) { if (/^1\.\.\d+\s*$/.test(lines[i])) { planIdx = i; break } }
  assert.ok(planIdx !== -1, 'composed stream must carry a plan')
  const plan = Number(/^1\.\.(\d+)/.exec(lines[planIdx])[1])
  const markerIdx = lines.findIndex(l => l.includes('COMPOSED-TAP-FOLLOWS'))
  const sec = lines.slice(markerIdx, planIdx + 6)
  // The composed plan is in the SUMMARY's own unit by construction (both are derived from
  // the same pass/fail/skip numbers in run-all) — assert the composer's promise end to end.
  const num = re => Number((sec.find(l => re.test(l)) || '').replace(re, '')) || 0
  const passN = num(/^# pass /); const failN = num(/^# fail /); const skipN = num(/^# skip /); const cancelN = num(/^# cancelled /)
  assert.equal(passN, 5, `composed # pass must count test points, got ${passN}`)
  assert.equal(plan, passN + failN + skipN + cancelN, `plan (1..${plan}) must equal pass(${passN})+fail(${failN})+skip(${skipN})+cancelled(${cancelN})`)
  assert.equal(plan, 5, 'composed plan carries exactly the sandbox corpus test-point count')
  // source pin: the plan literal is derived from the summary numbers, never from all.length
  const src = fs.readFileSync(RUN_ALL, 'utf8')
  assert.ok(src.includes('`1..${passPoints + keptNotOk + notOkInRetry + skips}`'), 'run-all must compose the plan from pass/fail/skip test-point units')
  assert.ok(!/^\s*`1\.\.\$\{all\.length\}`/m.test(src), 'the old block-count plan must be gone (comment mentions allowed)')
})

test('w25#6 spawnApp seeds todos.db only for auto-created dirs (fix 4, source pin)', () => {
  // spawnApp unconditionally spawned Electron, so the seeding branch is pinned at source
  // level: exactly one todos.db write, and it must live inside the `if (autoDir)` guard.
  const src = fs.readFileSync(path.join(PICKDONE, 'tests', 'lib', 'runtime.mjs'), 'utf8')
  const needle = "writeFileSync(path.join(userDataDir, 'todos.db'), '')"
  const first = src.indexOf(needle)
  assert.ok(first !== -1, 'the empty-todos.db seed must still exist')
  assert.equal(src.indexOf(needle, first + 1), -1, 'exactly one seeding site (no re-introduced unconditional write)')
  const guard = src.indexOf('if (autoDir) {')
  assert.ok(guard !== -1 && guard < first, 'the seed must be inside the if (autoDir) guard')
  const guardEnd = src.indexOf('\n  }', guard)
  assert.ok(first < guardEnd, 'the seed must be inside the if (autoDir) block body')
  // external dirs keep the reuse contract: no write before the guard either
  assert.ok(!src.slice(0, guard).includes("writeFileSync(path.join(userDataDir"), 'no unconditional write may precede the guard')
})

test('w25#7 sweep family covers todo-cov- (fix 5), via the private-root API', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-w25-sweep-root-'))
  const mk = (name, ageHours) => {
    const d = path.join(root, name)
    fs.mkdirSync(d, { recursive: true })
    fs.mkdirSync(path.join(d, 'inner'), { recursive: true })
    const old = new Date(Date.now() - ageHours * 3600 * 1000)
    fs.utimesSync(d, old, old)
    return d
  }
  const stale = mk('todo-cov-abcd1234', 13) // no pid encoding -> age guard alone applies
  const fresh = mk('todo-cov-fresh', 0)
  const foreign = mk('unrelated-prefix-dir', 13)
  const res = sweepStaleTmpDirs(root)
  assert.ok(!fs.existsSync(stale), 'stale todo-cov- dir must be swept')
  assert.ok(fs.existsSync(fresh), 'fresh todo-cov- dir must never be swept (mtime guard)')
  assert.ok(fs.existsSync(foreign), 'non-family dirs must be untouched')
  assert.ok(res.scanned >= 2, `family scan must have considered the todo-cov- entries (scanned=${res.scanned})`)
  fs.rmSync(path.join(root, path.basename(fresh)), { recursive: true, force: true })
  fs.rmSync(path.join(root, path.basename(foreign)), { recursive: true, force: true })
  fs.rmSync(root, { recursive: true, force: true })
})
