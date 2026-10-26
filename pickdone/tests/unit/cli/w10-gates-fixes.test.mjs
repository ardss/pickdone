/* W10 (2026-10-26) gate fixes — "who checks the checks", golden style per
 * gate-must-fail-golden.test.mjs. Four verified bugs pinned here:
 *
 *   fix 1 (tests/run-all.mjs): after flake-retry absorption the composed full-corpus TAP was
 *     assigned to r.stdout but NEVER emitted, while pass1+retry bytes had already been piped
 *     live to stdout — the summary gate parsed a raw double/plan-less stream and the skip
 *     ratchet read a partial corpus. Also the composed summary hardcoded `# cancelled 0`
 *     while kept not-ok blocks (failures blockFile() cannot locate into the retried file
 *     set: shared helpers, tests/lib/*.mjs) were neither retried nor counted. Pinned: the
 *     composed stream is emitted EXACTLY ONCE with ONE coherent plan, and kept not-ok
 *     refuses composition (falls through to the red path).
 *   fix 2 (tests/run-all.mjs recordFlake): read-modify-write lost ledger entries when two
 *     gates ran concurrently — pinned via source contract (re-read + union before tmp+rename).
 *   fix 3 (cli/lint-staged.mjs): the zero-match path exited 0 green even when staged js/vue
 *     in-scope files existed (prefix-normalization failure) — fail-closed breaker pinned
 *     golden-style against fixture repos (mirrors pre-commit stage-1 guard, 021f905b).
 *   fix 4 (cli/check-test-summary.cjs): CHECK_TEST_SUMMARY_SKIP_BASELINE voided the skip
 *     ratchet from any stray exported env var — pinned: override without the self-test flag
 *     warns loudly and is IGNORED.
 *
 * Run: node --test tests/unit/cli/w10-gates-fixes.test.mjs
 */
import { test, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.join(import.meta.dirname, '../../..')
const RUN_ALL = path.join(ROOT, 'tests', 'run-all.mjs')
const LINT_STAGED = path.join(ROOT, 'cli', 'lint-staged.mjs')
const SUMMARY_GATE = path.join(ROOT, 'cli', 'check-test-summary.cjs')
const RUN_ALL_SRC = fs.readFileSync(RUN_ALL, 'utf8')
const SUMMARY_SRC = fs.readFileSync(SUMMARY_GATE, 'utf8')

const madeDirs = []
// Git never leaks between the real checkout and a fixture (2026-10-11 incident, see
// gate-must-fail-golden): scrub EVERY GIT_* pointer for all child processes.
const GIT_SAFE_ENV = (() => {
  const e = { ...process.env }
  for (const k of Object.keys(e)) { if (/^GIT_/i.test(k)) delete e[k] }
  return e
})()

afterEach(() => {
  for (const d of madeDirs.splice(0)) { try { fs.rmSync(d, { recursive: true, force: true }) } catch { /* next run cleans via .tmp-* */ }
  }
})

const mkSandbox = name => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w10-gates-' + name + '-'))
  madeDirs.push(dir)
  const write = (rel, body) => {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, body)
    return p
  }
  return { dir, write }
}

const PASS = `import test from 'node:test'\nimport assert from 'node:assert/strict'\ntest('steady-ok', () => assert.equal(1, 1))\n`
// First-run jitter fixture: fails pass 1 (no marker yet), green on the flake-retry pass.
const FLAKY = marker => `import test from 'node:test'\nimport assert from 'node:assert/strict'\nimport fs from 'node:fs'\nimport path from 'node:path'\nconst marker = ${JSON.stringify(marker)}\ntest('flaky-first-run', () => {\n  if (!fs.existsSync(marker)) { fs.writeFileSync(marker, '1'); assert.ok(false, 'first-run jitter') }\n})\n`

test('GOLDEN run-all composed TAP: emitted exactly once, ONE coherent plan, full corpus, real counts', { timeout: 240000 }, async () => {
  const { dir, write } = mkSandbox('composed')
  write('tests/unit/steady.test.mjs', PASS)
  write('tests/unit/flaky.test.mjs', FLAKY(path.join(dir, 'tests', 'unit', '.ran-once')))
  const r = spawnSync(process.execPath, [RUN_ALL], {
    encoding: 'utf8', timeout: 220000,
    env: { ...process.env, GATE_META_APP_ROOT: dir, TEST_CONCURRENCY: '1' }
  })
  const out = r.stdout || ''
  assert.equal(r.status, 0, 'flake-retry absorption must leave the suite green: ' + (r.stderr || '').slice(-600))
  assert.match(r.stderr || '', /⚑FLAKY absorbed/, 'absorption must be loud on stderr')
  // exactly-once emission: ONE plan line, not pass1 raw + composed concatenated
  const plans = out.match(/^1\.\.\d+/gm) || []
  assert.equal(plans.length, 1, `stdout must carry exactly ONE TAP plan (double-plan bug), got ${plans.length}`)
  // composed stream is the authoritative record
  assert.match(out, /# COMPOSED after flake-retry absorption/, 'the emitted stream must be the composed full-corpus TAP')
  assert.match(out, /^1\.\.2$/m, 'composed plan must cover BOTH pass1-kept and retry blocks (2 blocks)')
  // full corpus: the non-retried pass1 file's block is present (partial-corpus blindness closed)
  assert.match(out, /steady-ok/, 'kept pass1 blocks (non-retried files) must appear in the composed stream')
  assert.match(out, /flaky-first-run/, 'retry blocks must appear in the composed stream')
  // real summary counts, anchored after the single plan
  const tail = out.slice(out.search(/^1\.\.\d+/m))
  assert.match(tail, /^# fail 0$/m, 'composed summary must report the real (zero) fail count')
  assert.match(tail, /^# cancelled 0$/m, 'composed summary must report the real cancel count')
  assert.match(tail, /^# pass 2$/m, 'composed summary pass count must cover the full corpus')
  // observability ledger: absorption recorded
  const ledger = JSON.parse(fs.readFileSync(path.join(dir, 'tests', '.artifacts', 'flake-files.json'), 'utf8'))
  assert.ok(ledger.length >= 1 && ledger.some(e => e.absorbed === true), 'flake ledger must record the absorption')
})

test('CONTRACT run-all composition fail-closes on kept not-ok + emits real counts; ledger merge-on-write', () => {
  // fix 1b: kept pass1 not-ok blocks (failures blockFile() cannot attribute to a retried
  // file — shared helpers, tests/lib/*.mjs) must REFUSE composition and fall to the red path
  assert.match(RUN_ALL_SRC, /keptNotOk > 0/,
    'composition must refuse when kept not-ok blocks exist outside the retried file set')
  assert.match(RUN_ALL_SRC, /absorption REFUSED/, 'the refusal must be loud')
  assert.match(RUN_ALL_SRC, /absorbed: false, deepPool: false,\r?\n\s+files: failedFiles[\s\S]*?keptNotOk,/,
    'a refused absorption must be recorded as absorbed:false')
  // fix 1b: the composed summary carries REAL counts, not a hardcoded `# cancelled 0`
  assert.ok(!/# cancelled 0'/.test(RUN_ALL_SRC), 'no hardcoded `# cancelled 0` may remain in the composed summary')
  assert.match(RUN_ALL_SRC, /# cancelled \$\{cancelled1\}/, 'composed summary must emit the real cancel count')
  assert.match(RUN_ALL_SRC, /# fail \$\{keptNotOk \+ notOkInRetry\}/,
    'composed summary MUST carry a # fail line — without it parseSummary returns fail=undefined and the gate fail-closes')
  // exactly-once emission contract: buffered pass1 + single final synchronous emission
  assert.match(RUN_ALL_SRC, /let r = await spawnRunner\(null, \{ live: false \}\)/, 'pass1 must spawn buffered so composition can own the stream')
  assert.match(RUN_ALL_SRC, /if \(!r\.streamed && r\.stdout && r\.stdout\.length\) emitSync\(r\.stdout\)/,
    'the final stdout emission must be exactly-once via the streamed flag')
  assert.match(RUN_ALL_SRC, /writeSync\(1, buf\)/, 'emission must be synchronous (flush before process.exit truncates a pipe)')
  // fix 2: merge-on-write — the ledger is re-read immediately before the tmp+rename and the
  // entry lists unioned (deduped), so a concurrent gate lane cannot be clobbered
  const freshIdx = RUN_ALL_SRC.indexOf('const fresh = readLedger()')
  const writeIdx = RUN_ALL_SRC.indexOf("writeFileSync(tmp, JSON.stringify(next")
  assert.ok(freshIdx > -1, 'recordFlake must re-read the ledger before the atomic write')
  assert.ok(writeIdx > -1 && freshIdx < writeIdx, 'the re-read must happen BEFORE the tmp+rename, not once at entry')
  assert.match(RUN_ALL_SRC, /\[\.\.\.prior, \.\.\.entries, \.\.\.fresh\]\.filter\(dedupe\)\.slice\(-200\)/,
    'prior + new entries + freshly-read entries must be unioned, deduped, window-bounded')
})

test('GOLDEN lint-staged breaker: staged in-scope js with empty selection is red; genuinely empty list is green', () => {
  // Fixture mirrors the normalization-failure shape: a repo whose toplevel IS the app root
  // (no pickdone/ nesting) — the staged path 'renderer/js/x.js' satisfies the scope+extension
  // contract only via the OPTIONAL pickdone/ prefix, so selection is empty while real
  // in-scope source is staged. (Git paths are toplevel-relative: cwd pickdone resolves to
  // the fixture toplevel either way.)
  const mkRepo = name => {
    const { dir, write } = mkSandbox(name)
    write('renderer/js/existing.js', 'const ok = 1\n')
    execSync('git init -q && git config user.email t@t && git config user.name t && git add -A && git commit -qm init',
      { cwd: dir, env: GIT_SAFE_ENV, stdio: 'ignore' })
    return { dir, write }
  }
  const runGate = root => spawnSync(process.execPath, [LINT_STAGED], {
    cwd: root, encoding: 'utf8', timeout: 60000, env: { ...GIT_SAFE_ENV, GATE_ROOT: root }
  })

  // breaker: in-scope source staged, selection empty → exit 1, loud
  const bad = mkRepo('ls-breaker')
  bad.write('renderer/js/new.js', 'const bad = 1\n')
  execSync('git add renderer/js/new.js', { cwd: bad.dir, env: GIT_SAFE_ENV, stdio: 'ignore' })
  const rb = runGate(bad.dir)
  assert.equal(rb.status, 1, 'staged in-scope js with 0 selected must fail closed: ' + (rb.stdout || '') + (rb.stderr || ''))
  assert.match((rb.stderr || '') + (rb.stdout || ''), /ESLint breaker/, 'the breaker must name itself loudly')
  assert.match((rb.stderr || '') + (rb.stdout || ''), /renderer[/\\]js[/\\]new\.js/, 'the breaker must list the unselected staged files')

  // genuinely empty stage list (nothing staged after the initial commit) → green
  const empty = mkRepo('ls-empty')
  const re = runGate(empty.dir)
  assert.equal(re.status, 0, 'a genuinely empty staged list must stay green: ' + (re.stdout || '') + (re.stderr || ''))
  assert.match(re.stdout || '', /no staged source changes in lint scope/)

  // staged but NOT in-scope source (docs) → green (breaker must not fire on non-source files)
  const docs = mkRepo('ls-docs')
  docs.write('docs/note.md', 'hello\n')
  execSync('git add docs/note.md', { cwd: docs.dir, env: GIT_SAFE_ENV, stdio: 'ignore' })
  const rd = runGate(docs.dir)
  assert.equal(rd.status, 0, 'docs-only staged list must stay green: ' + (rd.stdout || '') + (rd.stderr || ''))
})

test('GOLDEN check-test-summary: stray SKIP_BASELINE override warns + is ignored; with SELFTEST=1 honored', () => {
  const { dir } = mkSandbox('summary-override')
  // skip=5 exceeds EVERY platform baseline (win32 0 / linux 2 / darwin 1) so this pins on any host
  const tap = 'TAP version 13\n1..7\nok 1 - a\nok 2 - b # SKIP p1\nok 3 - c # SKIP p2\nok 4 - d # SKIP p3\nok 5 - e # SKIP p4\nok 6 - f # SKIP p5\nok 7 - g\n# pass 2\n# fail 0\n# cancelled 0\n# skip 5\n# todo 0\n'
  const tapFile = path.join(dir, 'skip5.tap')
  fs.writeFileSync(tapFile, tap)
  const run = env => spawnSync(process.execPath, [SUMMARY_GATE, tapFile], {
    encoding: 'utf8', timeout: 60000, env: { ...GIT_SAFE_ENV, ...env }
  })
  const combined = r => (r.stdout || '') + (r.stderr || '')

  // stray override (no self-test flag): IGNORED → ratchet still reds; warning is loud
  const stray = run({ CHECK_TEST_SUMMARY_SKIP_BASELINE: '99' })
  assert.equal(stray.status, 1, 'a stray override must NOT void the skip ratchet: ' + combined(stray))
  assert.match(combined(stray), /CHECK_TEST_SUMMARY_SELFTEST/, 'the ignored override must print a loud warning')
  // honored override: self-test flag present → green with baseline 99
  const honored = run({ CHECK_TEST_SUMMARY_SKIP_BASELINE: '99', CHECK_TEST_SUMMARY_SELFTEST: '1' })
  assert.equal(honored.status, 0, 'override WITH the self-test flag must be honored: ' + combined(honored))
  // control: no override, skip 5 > platform baseline → red (proves the red above is the ratchet)
  const control = run({})
  assert.equal(control.status, 1, 'skip over the platform baseline must be red without any override: ' + combined(control))

  // source contract: the gate computes the baseline through the gated branch
  assert.match(SUMMARY_SRC, /CHECK_TEST_SUMMARY_SELFTEST === '1'/, 'the self-test gate must be exact-string === \'1\'')
})
