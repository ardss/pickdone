/**
 * Unified entry for unit/integration tests - single source of truth: auto-discovers all test files under tests/ recursively
 * (recursive), eliminating drift between hand-written lists.
 * (Historical incident: package.json and check-all each kept their own list; 2 files were once missed by npm test)
 * e2e.test.mjs needs a live Electron instance, stays out of the default regression, and runs via a separate `npm run e2e`.
 * Passes extra args to node --test, e.g.: node tests/run-all.mjs --experimental-test-coverage
 * Layer filtering: --suite=unit|integration|visual (comma-separated for several; default = all suites).
 *   Suite membership is directory-level: tests/unit/**, tests/integration/**, tests/visual/**;
 *   files kept at the tests/ root (npm-script / check-all entrypoints) count as integration.
 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
// App root (pickdone/): the runner anchors its child spawn here and passes repo-relative
// test paths — see the argv-length comment at the spawnSync call below.
const appRoot = path.join(dir, '..')
// Live-Electron tests spawn their own instance (~30-60s each) and depend on the shared 5175
// host's runtime state — they stay out of the quick regression (and out of pre-commit, which
// must never be hostage to dev-host state); each runs as a dedicated check:all ③ live stage.
// NOTE: exclusion is by bare FILENAME across all suites — never reuse these names elsewhere.
const EXCLUDE = new Set(['e2e.test.mjs', 'integration-ui.test.mjs', 'overlay-visibility.test.mjs'])

const KNOWN_SUITES = new Set(['unit', 'integration', 'visual'])

function discover(root, acc = []) {
  for (const e of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(root, e.name)
    if (e.isDirectory()) {
      // fixtures/ holds shared test data, not runnable specs — skip it recursively so a stray
      // *.test.mjs dropped there is never picked up as a suite member
      if (e.name === 'fixtures') continue
      // dot-dirs (e.g. tests/.artifacts with the visual gate's locked Chromium profile) are
      // state, not specs — scanning them crashes on EPERM (scandir of Crashpad attachments)
      if (e.name.startsWith('.')) continue
      discover(p, acc)
    }
    else if (e.name.endsWith('.test.mjs') && !EXCLUDE.has(e.name)) acc.push(p)
  }
  return acc
}

function topOf(file) {
  const rel = path.relative(dir, file).split(path.sep)
  return rel.length > 1 ? rel[0] : 'integration' // tests/ root entrypoints = integration-flavored
}

// Fail-closed classification (H6 2026-09-12): a test file under an unknown top-level directory
// (e.g. tests/lib/**) used to be silently lumped into 'integration' and could run with the wrong
// environment expectations. Such files are now an error: they must be moved into a known suite
// directory or the directory added to KNOWN_SUITES explicitly.
function suiteOf(file) {
  const top = topOf(file)
  return KNOWN_SUITES.has(top) ? top : 'integration'
}

const suites = process.argv
  .map(a => /^--suite=([\w,]+)$/.exec(a)?.[1])
  .filter(Boolean)
  .flatMap(s => s.split(','))
// drop the --suite args before forwarding the rest to node --test
const forwardArgs = process.argv.slice(2).filter(a => !a.startsWith('--suite='))
const all = discover(dir)
// Fail-closed: refuse to run (instead of silently misclassifying) when a test file lives under an
// unknown top-level directory — force an explicit suite classification.
const unclassified = all.filter(f => !KNOWN_SUITES.has(topOf(f)))
if (unclassified.length) {
  console.error(`✗ [run-all] ${unclassified.length} test file(s) under unknown suite director(ies) — classify them explicitly:`)
  unclassified.forEach(f => console.error(`  ${path.relative(dir, f)}`))
  process.exit(1)
}
const files = suites.length ? all.filter(f => suites.includes(suiteOf(f))) : all

if (!files.length) { console.error(`✗ no *.test.mjs found under tests/${suites.length ? ` (suite=${suites.join(',')})` : ''}`); process.exit(1) }
if (suites.length) console.error(`[run-all] suite filter: ${suites.join(',')} -> ${files.length} file(s)`)

// With shell:true, unquoted file paths explode when the project path contains spaces (e.g. D:My Projects): the argument string is cut at the space;
// executing the binary inside the electron package does not rely on shell lookup, so shell can be safely dropped here
// Hygiene gate: every test gets a hard 2min ceiling via --test-timeout. A test that hangs (e.g. a
// socket/watcher never closed, or a promise awaiting a sync event that never fires in CI) becomes
// a NAMED failure in <=2min instead of burning the whole CI job budget with zero diagnostics
// (2026-09-19: ubuntu job sat 30min then was killed, 0 failures reported, hang unattributable).
const TEST_TIMEOUT_MS = 120000
// --test-force-exit: a test that passes but leaks a handle (listening server, open socket,
// watcher) would otherwise keep the per-file child process alive forever — the runner then waits
// with ZERO results (0 failures, budget kill, unattributable). Force-exit makes the child leave
// once tests finish; --test-timeout above covers the in-test hang case.
const r = spawnSync(process.execPath, ['--test', '--test-force-exit', `--test-timeout=${TEST_TIMEOUT_MS}`,
  // Pin the TAP reporter: check-test-summary.cjs anchors its fail/skip parsing on the TAP plan
  // (`1..N` + `# fail` lines), but Node >= 24 defaults the reporter to 'spec' even for non-TTY
  // stdout — the summary gate then read fail=undefined and red'd every run (2026-09-24).
  '--test-reporter=tap', '--test-reporter-destination=stdout',
  // Coverage table carrier: the TAP reporter does not print the coverage report on
  // node 22 (CI), so --experimental-test-coverage needs a second spec-reporter stream
  // (stderr) or the coverage ratchet never finds its "# all files" summary line.
  ...(forwardArgs.includes('--experimental-test-coverage')
    ? ['--test-reporter=spec', '--test-reporter-destination=stderr']
    : []),
  ...forwardArgs, ...files.map(f => path.relative(appRoot, f))],
  // Windows caps a spawned command line at ~32k chars: with ~350 discovered files, ABSOLUTE
  // paths (K:\...\pickdone\tests\...) blow past it and spawnSync fails with ENAMETOOLONG —
  // exit 1 with ZERO TAP output, which the summary gate could only read as a mystery red
  // (2026-09-26 check:fast round-2). Anchor the spawn at the app root and pass repo-relative
  // paths so the argv stays an order of magnitude under the cap regardless of checkout depth.
  { cwd: appRoot, stdio: ['inherit', 'pipe', 'pipe'], maxBuffer: 1 << 28 })
// Fail closed and LOUD on spawn errors: r.status is null when the child never ran, so the
// old `r.status ?? 1` fell through to exit 1 with empty output — indistinguishable from a
// test failure and unattributable. Name the errno instead.
if (r.error) {
  console.error(`✗ [run-all] test runner failed to spawn: ${r.error.code || r.error.message}`)
  process.exit(1)
}
// Timing summary: print the enforced per-test ceiling next to the SLOWEST observed test, so a
// near-ceiling duration reads as "slow but finished" and a kill-at-ceiling reads as "hung".
// The 2min ceiling itself stays as-is (observed margin vs the slowest test is 6.5x+).
if (r.stdout) process.stdout.write(r.stdout) // forward the TAP verbatim (summary gate parses it)
if (r.stderr) process.stderr.write(r.stderr) // spec reporter stream (coverage table) + runner warnings
// When coverage was requested, persist a machine-readable summary for the coverage ratchet,
// so the gate can compare without re-running the whole unit suite (running both concurrently
// on a 4-vCPU CI runner doubled the load enough to time tests out, 2026-09-26).
if (forwardArgs.includes('--experimental-test-coverage')) {
  try {
    const all = (() => {
      const lines = ((r.stdout || '') + '\n' + (r.stderr || '')).split(/\r?\n/)
      for (let i = lines.length - 1; i >= 0; i--) {
        const m = /^#?\s*(?:ℹ\s*)?all\s+files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/.exec(lines[i])
        if (m) return { lines: +m[1], branches: +m[2], functions: +m[3] }
      }
      return null
    })()
    const fs = await import('node:fs')
    const artifacts = path.join(dir, '.artifacts')
    fs.mkdirSync(artifacts, { recursive: true })
    fs.writeFileSync(path.join(artifacts, 'coverage-summary.json'),
      JSON.stringify({ ...all, generatedAt: new Date().toISOString() }, null, 2) + '\n')
    if (all) console.error(`[run-all] coverage summary written: ${all.lines}/${all.branches}/${all.functions}`)
    else console.error('[run-all] coverage requested but no all-files summary found — ratchet will fall back to its own run')
  } catch (e) { console.error(`[run-all] coverage summary write failed: ${e.message}`) }
}
try {
  const tap = r.stdout ? r.stdout.toString() : ''
  const slow = []
  for (const m of tap.matchAll(/^ {2}duration_ms: ([0-9.]+)/gm)) slow.push(parseFloat(m[1]))
  if (slow.length) {
    const max = Math.max(...slow)
    console.error(`[run-all] per-test timeout ceiling: ${TEST_TIMEOUT_MS}ms; slowest observed test: ${max.toFixed(0)}ms (${(TEST_TIMEOUT_MS / max).toFixed(1)}x margin)`)
  }
} catch { /* diagnostics only — never mask the runner's real exit status */ }
process.exit(r.status ?? 1)
