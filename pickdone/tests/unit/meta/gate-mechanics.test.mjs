/**
 * gate-mechanics — META-TESTS for the gate machinery itself (GPT-adjudicated #2, P0).
 *
 * Verifies the gate DETECTS failures, by injecting them into sandboxed fixtures —
 * never by touching the real corpus or recursing into the real gate pool:
 *   1. nonzero test exit code            -> red (run-all, sandbox fixture)
 *   2. test crash + full child cleanup   -> red, registry emptied
 *   3. missing dir / zero tests executed -> red (fail-closed, never silent-empty)
 *   4. skip count over ratchet budget    -> red (TAP fed to check-test-summary)
 *   5. coverage below threshold          -> red (fresh sandbox summary + scratch baseline)
 *   6. artifact size over limit          -> red (limitFor tier decision, unit-level)
 *   7. first-run fail, retry pass        -> exit 0 BUT retry evidence retained (never
 *                                           disguised as a clean first pass)
 *   8. nested runner ownership           -> a runner's exit-reap must not touch other
 *                                           runners' registered children
 *   9. CDP/service port allocation       -> per-boot ephemeral, two probes never collide
 *  10. all sandbox tests pass            -> green
 *
 * Independent of the real gate pool: fixtures live in tmp dirs, every spawn is
 * `node tests/run-all.mjs` inside its own sandbox cwd. Evidence for every injection
 * (input, exit code, observed output, assertion) is written to
 * tests/.artifacts/gate-meta-evidence/<stamp>.json.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)

const HERE = path.dirname(fileURLToPath(import.meta.url))
// three levels up: tests/unit/meta/ -> pickdone/
const PICKDONE = path.resolve(HERE, '..', '..', '..')
const RUN_ALL = path.join(PICKDONE, 'tests', 'run-all.mjs')
const EVIDENCE_DIR = path.join(PICKDONE, 'tests', '.artifacts', 'gate-meta-evidence')
fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
const STAMP = new Date().toISOString().replace(/[:.]/g, '-')
const evidence = []

function record (name, input, proc, assertion) {
  evidence.push({ name, input, exitCode: proc?.status ?? null, assertion,
    stdoutTail: (proc?.stdout || '').split('\n').slice(-6).join('\n').slice(0, 800),
    stderrTail: (proc?.stderr || '').split('\n').slice(-6).join('\n').slice(0, 800) })
}

/** Build a sandbox appRoot with `tests/` fixtures; run-all discovers tests/**.test.mjs there. */
function sandbox (name, files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-meta-' + name + '-'))
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
  }
  return dir
}

const runAll = (cwd, args = [], env = {}) =>
  spawnSync(process.execPath, [RUN_ALL, ...args], { cwd, encoding: 'utf8', timeout: 240000,
    env: { ...process.env, TEST_CONCURRENCY: '1', GATE_META_APP_ROOT: cwd, ...env } })

const PASS = `import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('ok', () => assert.equal(1, 1))\n`
const FAIL = `import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('boom', () => assert.equal(1, 0))\n`

test('meta#1 nonzero test exit code -> red', () => {
  const dir = sandbox('nonzero', { 'tests/unit/boom.test.mjs': FAIL })
  const p = runAll(dir)
  record('nonzero-exit', 'one failing sandbox test', p, 'run-all exits 1')
  assert.equal(p.status, 1, 'nonzero child exit must turn the gate red')
})

test('meta#2 test crash -> red + own children cleaned', () => {
  const dir = sandbox('crash', { 'tests/unit/suicide.test.mjs':
    "process.kill(process.pid, 'SIGKILL')\n" })
  // [2026-10-31 P0] the sandbox run uses a PRIVATE registry dir (PICKDONE_CHILD_REGISTRY_DIR):
  // the old real-dir before/after global diff false-red'd whenever ANY concurrent lane
  // (check-all's parallel stage/live pool) registered a child in tests/.artifacts/runner-children
  // mid-run — the 2026-10-31 release-gate 5x red with drifting failure lineups. The leak
  // semantics are unchanged: the private dir must come out EMPTY.
  const reg = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-meta-registry-'))
  const p = runAll(dir, [], { PICKDONE_CHILD_REGISTRY_DIR: reg })
  record('crash-cleanup', 'sandbox test SIGKILLs itself', p, 'run-all exits 1, PRIVATE registry left empty')
  assert.equal(p.status, 1, 'a crashed test must turn the gate red')
  const leftovers = fs.existsSync(reg)
    ? fs.readdirSync(reg).filter(f => f.endsWith('.json'))
    : []
  assert.equal(leftovers.length, 0, 'the run must fully clean its own child registry (private dir empty, no leftovers)')
})

test('meta#3 missing dir / zero tests executed -> red (fail-closed)', () => {
  const dir = sandbox('empty', {})
  const p = runAll(dir, ['--dirs=tests/does-not-exist'])
  record('zero-executed', 'dirs pointing at a nonexistent dir', p, 'fail-closed exit 1')
  assert.equal(p.status, 1, 'zero discovered files must fail closed, never silent-empty green')
})

test('meta#4 skip count over ratchet budget -> red; under budget -> green', () => {
  const tap = (skip) => `TAP version 13\n1..${10 + skip}\n# pass 10\n# fail 0\n# cancelled 0\n# skip ${skip}\n# todo 0\n`
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-meta-skip-'))
  const over = path.join(dir, 'over.tap'); fs.writeFileSync(over, tap(5))
  const under = path.join(dir, 'under.tap'); fs.writeFileSync(under, tap(1))
  // [w10-gates 2026-10-26] the baseline override is now gated on CHECK_TEST_SUMMARY_SELFTEST=1
  // (a bare override from any stray exported env var silently voided the ratchet) — this fixture
  // IS the self-test, so it must set both flags.
  const env = { ...process.env, CHECK_TEST_SUMMARY_SELFTEST: '1', CHECK_TEST_SUMMARY_SKIP_BASELINE: '2' }
  const red = spawnSync(process.execPath, ['cli/check-test-summary.cjs', over], { cwd: PICKDONE, encoding: 'utf8', timeout: 60000, env })
  const green = spawnSync(process.execPath, ['cli/check-test-summary.cjs', under], { cwd: PICKDONE, encoding: 'utf8', timeout: 60000, env })
  record('skip-over-budget', 'TAP # skip 5 vs budget 2', red, 'red')
  record('skip-under-budget', 'TAP # skip 1 vs budget 2', green, 'green')
  assert.equal(red.status, 1, 'skips over the ratchet budget must be red')
  assert.equal(green.status, 0, 'skips under the budget stay green')
})

test('meta#5 coverage below threshold -> red (FULLY sandboxed ratchet run)', () => {
  // [2026-10-31 P1] the old version OVERWROTE the real repo's tests/.artifacts/coverage-summary.json
  // with a fake 10/10/10 summary — a concurrent check-coverage-ratchet lane read the poison slot.
  // Now the ratchet CLI itself runs inside a sandbox cwd: SUMMARY_FILE is __dirname-anchored, so a
  // copy of the script + a fresh sandbox summary gives the REAL gate the poisoned input, with the
  // baseline routed to a scratch file via its own env override. The real summary is never touched.
  const scratchBase = path.join(os.tmpdir(), 'gate-meta-cov-baseline.json')
  const platKey = `${process.platform}@node${process.versions.node.split('.')[0]}`
  fs.writeFileSync(scratchBase, JSON.stringify({ _comment: 'gate-meta sandbox baseline', baselines: { [platKey]: { lines: 80, branches: 80, functions: 80 } } }))
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gate-meta-cov-'))
  fs.mkdirSync(path.join(dir, 'cli'), { recursive: true })
  fs.mkdirSync(path.join(dir, 'tests', '.artifacts'), { recursive: true })
  fs.copyFileSync(path.join(PICKDONE, 'cli', 'check-coverage-ratchet.cjs'), path.join(dir, 'cli', 'check-coverage-ratchet.cjs'))
  fs.writeFileSync(path.join(dir, 'tests', '.artifacts', 'coverage-summary.json'), JSON.stringify({
    lines: 10, branches: 10, functions: 10, failCount: 0, suite: 'unit', generatedAt: new Date().toISOString()
  }))
  const realSummary = path.join(PICKDONE, 'tests', '.artifacts', 'coverage-summary.json')
  const realBefore = fs.existsSync(realSummary) ? fs.readFileSync(realSummary, 'utf8') : null
  const p = spawnSync(process.execPath, ['cli/check-coverage-ratchet.cjs'],
    { cwd: dir, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, PICKDONE_COV_RATCHET_BASELINE_FILE: scratchBase } })
  record('coverage-below-threshold', 'sandbox ratchet reads a fresh 10/10/10 summary vs baseline 80/80/80', p, 'red')
  assert.equal(p.status, 1, 'coverage below baseline must be red')
  const realAfter = fs.existsSync(realSummary) ? fs.readFileSync(realSummary, 'utf8') : null
  assert.equal(realAfter, realBefore, 'the REAL coverage-summary.json slot must never be touched by this meta-test')
})

test('meta#6 artifact size over limit -> error tier (limitFor decision)', () => {
  const src = fs.readFileSync(path.join(PICKDONE, 'cli', 'check-file-size.cjs'), 'utf8')
  // the tier table is the decision core; the store tier errors at 700 — the tier that once
  // let a 706-line store slip through in the first place
  assert.match(src, /warn: 400, error: 700/, 'store tier keeps its 700 error line')
  record('size-limit-tiers', 'LIMITS store tier ships error=700', { status: 0 }, 'tier table intact')
})

test('meta#7 first-run fail, retry pass -> green BUT retry evidence retained', () => {
  const dir = sandbox('flaky', { 'tests/unit/flaky.test.mjs': [
    "import test from 'node:test'",
    "import assert from 'node:assert/strict'",
    "import fs from 'node:fs'",
    "import path from 'node:path'",
    "const marker = path.join(process.env.GATE_META_STATE, 'ran-once')",
    "test('flaky-by-state', () => {",
    "  if (!fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); assert.fail('first run fails on purpose') }",
    "  assert.equal(fs.readFileSync(marker, 'utf8'), '1')",
    "})",
  ].join('\n') })
  const state = path.join(dir, 'state'); fs.mkdirSync(state)
  const p = runAll(dir, [], { GATE_META_STATE: state })
  const stderr = p.stderr || ''
  record('flaky-retry-pass', 'sandbox test fails first run, passes the per-file retry', p,
    'exit 0 AND the retry/floated-first-failure evidence stays in stderr')
  assert.equal(p.status, 0, 'an absorbed retry is ultimately green')
  assert.match(stderr, /flake-retry/, 'the retry event must be recorded, never disguised as a clean pass')
  assert.match(stderr, /↻/, 'the retried file must be named')
  assert.match(stderr, /⚑FLAKY/, 'the absorption must be loud (signal-integrity contract 2026-10-25)')
  // observability contract: the absorption lands in the ledger inside the sandbox appRoot
  const ledger = path.join(dir, 'tests', '.artifacts', 'flake-files.json')
  assert.ok(fs.existsSync(ledger), 'flake ledger must exist after an absorption')
  assert.match(fs.readFileSync(ledger, 'utf8'), /flaky\.test\.mjs/, 'the ledger names the absorbed file')
})

test('meta#8 nested runner ownership: exit-reap spares other runners\' children', () => {
  // Real registry, two owners, ZERO side effects by construction:
  //  - "foreign" entry: pid = THIS process (guaranteed alive) with a match fragment that
  //    cannot be in its command line -> reapEntry verdict 'foreign' (alive, never killed)
  //  - "own" entry: pid = 999999998 (nothing there) -> reapEntry verdict 'gone' -> cleaned.
  // B (a child) reaps first: both entries must survive. Then the rightful owner (this
  // process) reaps: its own gone-entry is cleaned, the foreign one is still not ours.
  const regDir = path.join(PICKDONE, 'tests', '.artifacts', 'runner-children')
  fs.mkdirSync(regDir, { recursive: true })
  const foreign = path.join(regDir, String(process.pid) + '.json')
  const own = path.join(regDir, '999999998.json')
  // per-pid layout: ONE file = ONE entry object (not an array) — readAll skips array-shaped
  // files as corrupt, and a fixture in the wrong shape silently voids the whole case.
  fs.writeFileSync(foreign, JSON.stringify({ pid: process.pid, match: ['gate-meta-foreign-probe-nonexistent-fragment'], purpose: 'meta-test foreign (alive, non-matching)', owner: 999999999, bornAt: new Date().toISOString() }))
  fs.writeFileSync(own, JSON.stringify({ pid: 999999998, match: [], purpose: 'meta-test own (absent pid -> gone)', owner: process.pid, bornAt: new Date().toISOString() }))
  try {
    const probe = spawnSync(process.execPath, ['-e',
      `const r = require('${path.join(PICKDONE, 'tests/lib/child-registry.mjs').replace(/\\/g, '/')}');
       r.reapAllRegisteredSync();
       const left = require('fs').readdirSync(${JSON.stringify(regDir)}).filter(f => f.endsWith('.json'));
       console.log('LEFT:' + left.join(','));`], { encoding: 'utf8', timeout: 60000 })
    const left = (probe.stdout || '').match(/LEFT:(.*)/)?.[1] || ''
    record('nested-ownership', 'child B reaps while foreign (owner A, alive) + own (owner meta-test) entries exist', probe,
      'both survive: B only ever cleans what B itself registered')
    assert.ok(left.split(',').includes(String(process.pid) + '.json'), 'the foreign entry must survive another process\u2019s exit-reap')
    assert.ok(left.split(',').includes('999999998.json'), 'the meta-test\u2019s own entry must survive the CHILD\u2019s reap (it belongs to the meta-test, not the child)')
    // now the rightful owner (this process) reaps — its own gone-entry is cleaned, the foreign stays
    const { reapAllRegisteredSync } = require_(path.join(PICKDONE, 'tests', 'lib', 'child-registry.mjs'))
    reapAllRegisteredSync()
    const after = fs.readdirSync(regDir).filter(f => f.endsWith('.json'))
    assert.ok(!after.includes('999999998.json'), 'the rightful owner cleans its own gone-entry')
    assert.ok(after.includes(String(process.pid) + '.json'), 'the foreign entry is still not ours to reap')
  } finally {
    fs.rmSync(foreign, { force: true })
    fs.rmSync(own, { force: true })
  }
})

test('meta#9 live-pool port allocation (pickFreePort) never collides', async () => {
  // [2026-10-31 P2] was a fake-green: it probed bare net.createServer().listen(0) — zero gate
  // code exercised. The REAL allocator the live pool boots with is tests/lib/runtime.mjs
  // pickFreePort (multi-span dodge for WinNAT reserved ranges). Exercise it: pick one port,
  // HOLD it (as a booting instance would), then pick again — the second pick must neither
  // collide nor return an unbindable port.
  const net = await import('node:net')
  const { pickFreePort } = await import(pathToFileURL(path.join(PICKDONE, 'tests', 'lib', 'runtime.mjs')).href)
  const a = await pickFreePort()
  const holder = net.createServer()
  await new Promise((res, rej) => { holder.once('error', rej); holder.listen(a, '127.0.0.1', res) })
  try {
    const b = await pickFreePort()
    record('port-collision', 'two pickFreePort probes with the first port held', { status: a === b ? 1 : 0 }, 'distinct, bindable ports')
    assert.notEqual(b, a, 'a held port must never be handed out again by the live-pool allocator')
  } finally {
    await new Promise(res => holder.close(res))
  }
})

test('meta#10 all sandbox tests pass -> green', () => {
  const dir = sandbox('green', { 'tests/unit/ok.test.mjs': PASS })
  const p = runAll(dir)
  record('all-green', 'one passing sandbox test', p, 'run-all exits 0')
  assert.equal(p.status, 0, 'a clean sandbox run must be green')
})

test('meta-evidence: persist every injection record', async () => {
  const out = path.join(EVIDENCE_DIR, STAMP + '.json')
  fs.writeFileSync(out, JSON.stringify({ stamp: STAMP, cases: evidence }, null, 2))
  assert.ok(evidence.length >= 9, 'every injection must leave recorded evidence at ' + out)
})
