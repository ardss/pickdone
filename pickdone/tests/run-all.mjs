/**
 * Unified entry for unit/integration tests - single source of truth: auto-discovers all test files under tests/ recursively
 * plus the flat sibling dir pickdone/test/ (classified 'unit'; see SIBLING_DIR below).
 * (recursive), eliminating drift between hand-written lists.
 * (Historical incident: package.json and check-all each kept their own list; 2 files were once missed by npm test)
 * e2e.test.mjs needs a live Electron instance, stays out of the default regression, and runs via a separate `npm run e2e`.
 * Passes extra args to node --test, e.g.: node tests/run-all.mjs --experimental-test-coverage
 * Layer filtering: --suite=unit|integration|visual (comma-separated for several; default = all suites).
 *   Suite membership is directory-level: tests/unit/**, tests/integration/**, tests/visual/**;
 *   files kept at the tests/ root (npm-script / check-all entrypoints) count as integration.
 */
import { existsSync, readdirSync, writeSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// 2026-10-09 preflight sweep: exit-only cleanup is bypassed when a test child is SIGKILLed
// (watchdog / boot-stall kill / CI timeout), so %TEMP% accumulated thousands of orphaned
// test dirs. Sweep ONCE here, BEFORE spawning children — only provably orphaned entries
// (family prefix + mtime > 12h + dead owning pid) are removed; fresh or live-owned dirs
// are never touched (double-guard inside sweepStaleTmpDirs).
import { sweepStaleTmpDirs } from './lib/tmp-dir.mjs'
// D4 orphan hygiene (2026-10-23 speed wave): the runner child is registered at spawn and
// pruned on 'close'. A run-all killed from the outside (watchdog / CI timeout / harness
// kill) never reaches its own cleanup — the registry entry it leaves behind is what
// `node tests/run-all.mjs --cleanup` reaps, after verifying the live command line still
// matches (pid-reuse safety, see tests/lib/child-registry.mjs).
import { registerChild, unregisterChild, cleanupRegisteredChildren, reapAllRegisteredSync } from './lib/child-registry.mjs'

// Symmetric with check-all's exit reap (2026-10-24): run-all is also invoked directly
// (npm test / suite slices) — its own exit must best-effort reap whatever its spawn tree
// left registered, not only the dedicated --cleanup pass.
process.on('exit', () => { try { reapAllRegisteredSync() } catch { /* best-effort by contract */ } })

const dir = path.dirname(fileURLToPath(import.meta.url))
// --cleanup must short-circuit BEFORE any discovery/spawn: it is a maintenance mode that
// reaps children recorded by run-all / check-all stage spawns (see child-registry.mjs).
if (process.argv.includes('--cleanup')) {
  const r = await cleanupRegisteredChildren()
  console.error(`[run-all] --cleanup: killed=${r.killed.length} already-gone=${r.gone.length} foreign=${r.foreign.length} survivors=${r.survivors.length}`)
  for (const e of r.foreign) console.error(`  [foreign] pid ${e.pid} alive but command line no longer matches (${e.purpose || 'unknown'}) — left untouched`)
  for (const e of r.survivors) console.error(`  [survivor] pid ${e.pid} matched but refused to die (${e.purpose || 'unknown'})`)
  process.exit(r.survivors.length ? 1 : 0)
}
{
  const { scanned, removed } = sweepStaleTmpDirs()
  if (removed > 0) console.error(`[run-all] preflight temp sweep: removed ${removed} orphaned dir(s) of ${scanned} scanned in %TEMP%`)
}
// App root (pickdone/): the runner anchors its child spawn here and passes repo-relative
// test paths — see the argv-length comment at the spawnSync call below.
// GATE_META_APP_ROOT (2026-10-24): meta-test injection point — lets the gate-mechanics
// suite anchor run-all at a sandbox fixture dir. Default (unset) behavior is unchanged.
const appRoot = process.env.GATE_META_APP_ROOT
  ? path.resolve(process.env.GATE_META_APP_ROOT)
  : path.join(dir, '..')
// Live-Electron tests spawn their own instance (~30-60s each) and depend on the shared 5175
// host's runtime state — they stay out of the quick regression (and out of pre-commit, which
// must never be hostage to dev-host state); each runs as a dedicated check:all ③ live stage.
// NOTE: exclusion is by bare FILENAME across all suites — never reuse these names elsewhere.
const EXCLUDE = new Set(['e2e.test.mjs', 'integration-ui.test.mjs', 'overlay-visibility.test.mjs',
  // 2026-10-27 core-journey E2E regressions (tests/e2e-journeys/): live-Electron pool targets
  // run by run-interactions-shared.mjs as dedicated check:all ③ live stages — same class as
  // e2e.test.mjs, never in the quick/pre-commit regression (boots + dev-host state).
  'j-todo-core.test.mjs', 'j-habit-moment.test.mjs', 'j-rail-stats-settings.test.mjs',
  // 2026-09-28 un-excluded: the --test-force-exit + 2min-ceiling harness added after that wave
  // contains exactly the runaway-test scenario the flake feared, so the file re-joins the
  // default pool — an orphaned integration spec is a regression nobody sees.
  ])

const KNOWN_SUITES = new Set(['unit', 'integration', 'visual'])

// --tier=core|deep (2026-10-23 efficiency wave): the full pool mixes pure in-process specs with
// suites that bind real sockets, spawn real processes, or boot real Electron instances. Those
// deep suites are slow (minutes each) AND load-sensitive: under a loaded dev host they cascade
// into contention-artifact reds (2026-10-22 fast-gate unit run: 12 of 17 not-ok entries were
// exactly this class, every one green in isolation). `--tier=core` = default pool minus this
// list; `--tier=deep` = this list only; no --tier = everything (CI / full check:all unchanged).
// The split never silently drops a suite from the FULL pool — it only re-routes where a tier
// runs. Exclusion is by bare FILENAME across all suites (same doctrine as EXCLUDE above):
// never reuse these names elsewhere.
const DEEP_FILES = new Set([
  // live Electron, boots the real app twice (exit-mode quit + tray-mode hide)
  'e2e-exit-close.test.mjs',
  // two real paired instances, multi-minute journey (J4 reconnect lives here)
  'lan-sync-journey.test.mjs',
  // loopback server suites — bind real ports / long socket lifecycles
  'lan-sync-loopback.test.mjs',
  'v2-acceptance-drill.test.mjs',
  'd9-loopback-mesh-scale.test.mjs',
  'd9-loopback-two-machine-drill.test.mjs',
  'd9-loopback-restart-conflict.test.mjs',
  'd9-concurrency-smoke.test.mjs',
  'same-host-instance-20261015.test.mjs',
  'relay-413-forceexit-teardown.test.mjs',
  // cross-process relay drill, self-declared 120s timeout (unit/main)
  'relay-cross-process-outbox.test.mjs',
  // D6 (2026-10-23): c1-parse-ux was routed here for the fixture-suite lock/ceiling burn.
  // Root-caused as a SEQUENTIAL-SPAWN WALL-TIME problem, not a db lock: ~40 strictly serial
  // CLI children inflate to 6-23s each under full-suite process-creation contention and the
  // 300s file ceiling executes mid-file. Fixed in the suite itself (per-test fixture dirs +
  // 8 concurrent async spawn lanes + bounded child lifecycle) — c1 rejoined core; keep this
  // comment as the routing-history anchor for the perf-debt-ledger D6 entry.
])

// Sibling spec dir: pickdone/test/ (flat, next to tests/) used to be executed by NOTHING —
// discover() only scanned tests/**, so 13 regression specs lived on manual discipline alone and
// at least two had silently rotted to red (2026-09-28). They are now discovered alongside tests/
// and classified as 'unit' (all of them are plain-Node specs: electron / electron-updater stubbed
// via require interception, config pointed at temp dirs). Both .test.mjs and .test.js are taken
// here — the .js specs are CommonJS and run fine under node --test — while tests/** keeps its
// historical .test.mjs-only convention EXCEPT the tests/-root specs (dayrail-resize-raf /
// depview-resize-raf .test.js): those were orphaned when the double-extension fix was only
// passed to the SIBLING_DIR discover() call — they ran on manual discipline alone (2026-09-28).
// The root-level discover() now takes both extensions too, so *.test.js anywhere under tests/
// is discovered; suite classification is unchanged (tests/ root = integration).
const TEST_EXTS = ['.test.mjs', '.test.js']
const SIBLING_DIR = path.join(dir, '..', 'test')
const isSiblingSpec = file => file.startsWith(SIBLING_DIR + path.sep)

function discover(root, acc = [], exts = TEST_EXTS) {
  for (const e of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(root, e.name)
    if (e.isDirectory()) {
      // fixtures/ holds shared test data, not runnable specs — skip it recursively so a stray
      // *.test.mjs dropped there is never picked up as a suite member
      if (e.name === 'fixtures') continue
      // dot-dirs (e.g. tests/.artifacts with the visual gate's locked Chromium profile) are
      // state, not specs — scanning them crashes on EPERM (scandir of Crashpad attachments)
      if (e.name.startsWith('.')) continue
      discover(p, acc, exts)
    }
    else if (exts.some(x => e.name.endsWith(x)) && !EXCLUDE.has(e.name)) acc.push(p)
  }
  return acc
}

function topOf(file) {
  // anchored at appRoot (not the script dir) so GATE_META_APP_ROOT sandbox runs classify
  // their own fixture files instead of computing `..\..` garbage against the real repo
  const rel = path.relative(path.join(appRoot, 'tests'), file).split(path.sep)
  return rel.length > 1 && !rel[0].startsWith('..') ? rel[0] : 'integration' // tests/ root entrypoints = integration-flavored
}

// Fail-closed classification (H6 2026-09-12): a test file under an unknown top-level directory
// (e.g. tests/lib/**) used to be silently lumped into 'integration' and could run with the wrong
// environment expectations. Such files are now an error: they must be moved into a known suite
// directory or the directory added to KNOWN_SUITES explicitly.
function suiteOf(file) {
  if (isSiblingSpec(file)) return 'unit'
  const top = topOf(file)
  return KNOWN_SUITES.has(top) ? top : 'integration'
}

const suites = process.argv
  .map(a => /^--suite=([\w,]+)$/.exec(a)?.[1])
  .filter(Boolean)
  .flatMap(s => s.split(','))
const tierArg = (/^--tier=(\w+)$/.exec(process.argv.find(a => a.startsWith('--tier=')) || '') || [])[1]
if (tierArg && !['core', 'deep'].includes(tierArg)) {
  console.error(`✗ [run-all] unknown --tier=${tierArg} (valid: core|deep)`)
  process.exit(1)
}
// drop the --suite/--tier/--dirs args before forwarding the rest to node --test
const forwardArgs = process.argv.slice(2).filter(a => !(a.startsWith('--suite=') || a.startsWith('--tier=') || a.startsWith('--dirs=')))
// discovery follows appRoot too (GATE_META_APP_ROOT sandboxing): scanning the script's own
// tests/ would drag the real corpus into a meta-test sandbox run. The sibling dir is
// tolerated missing — sandbox fixtures don't carry it.
const siblingDir = path.join(appRoot, 'test')
const all = discover(path.join(appRoot, 'tests'))
  .concat(existsSync(siblingDir) ? discover(siblingDir, [], TEST_EXTS) : [])
// Every DEEP_FILES entry must match a discovered file — a stale name would silently shrink the
// deep pool (and silently GROW the core pool) with nobody the wiser. Sandbox runs
// (GATE_META_APP_ROOT, gate-mechanics meta-tests only) carry no deep files by construction.
if (!process.env.GATE_META_APP_ROOT) {
  const discovered = new Set(all.map(f => path.basename(f)))
  const missing = [...DEEP_FILES].filter(n => !discovered.has(n))
  if (missing.length) {
    console.error(`✗ [run-all] DEEP_FILES entries matching no discovered test file: ${missing.join(', ')}`)
    process.exit(1)
  }
}
// Fail-closed: refuse to run (instead of silently misclassifying) when a test file lives under an
// unknown top-level directory — force an explicit suite classification. Sibling specs
// (pickdone/test/) are pre-classified as 'unit' by suiteOf, so they skip this check.
const unclassified = all.filter(f => !isSiblingSpec(f) && !KNOWN_SUITES.has(topOf(f)))
if (unclassified.length) {
  console.error(`✗ [run-all] ${unclassified.length} test file(s) under unknown suite director(ies) — classify them explicitly:`)
  unclassified.forEach(f => console.error(`  ${path.relative(dir, f)}`))
  process.exit(1)
}
let files = suites.length ? all.filter(f => suites.includes(suiteOf(f))) : all
let tierNote = ''
if (tierArg === 'core') {
  tierNote = ` (deep pool: ${[...DEEP_FILES].length} file(s) re-routed to --tier=deep / full runs)`
  files = files.filter(f => !DEEP_FILES.has(path.basename(f)))
} else if (tierArg === 'deep') {
  tierNote = ' (deep pool only)'
  files = files.filter(f => DEEP_FILES.has(path.basename(f)))
}
// --dirs=<comma-separated tests/ subdirs> (2026-10-23 S2 affected-scope): restrict the pool to
// the given directory prefixes (repo-relative to pickdone/, e.g. tests/unit/store). Fail-closed:
// a named dir matching ZERO discovered files is an error, never a silent empty run — the whole
// point of scoping is safe wall-time, not silent green. Prefix matching runs against the path
// relative to appRoot (covers tests/** AND the sibling test/ dir uniformly).
const relFromAppRoot = f => path.relative(appRoot, f).split(path.sep).join('/')
const dirsArg = (/^--dirs=([\w./,-]+)$/.exec(process.argv.find(a => a.startsWith('--dirs='))) || [])[1]
if (dirsArg) {
  const prefixes = dirsArg.split(',').filter(Boolean)
  const missing = prefixes.filter(p => !all.some(f => relFromAppRoot(f).startsWith(p + '/')))
  if (missing.length) {
    console.error(`✗ [run-all] --dirs entries matching no discovered test file: ${missing.join(', ')}`)
    process.exit(1)
  }
  files = files.filter(f => prefixes.some(p => relFromAppRoot(f).startsWith(p + '/')))
  tierNote += ` (dirs: ${prefixes.join(',')})`
}

if (!files.length) { console.error(`✗ no *.test.mjs found under tests/${suites.length ? ` (suite=${suites.join(',')})` : ''}${tierArg ? ` (tier=${tierArg})` : ''}`); process.exit(1) }
if (suites.length) console.error(`[run-all] suite filter: ${suites.join(',')} -> ${files.length} file(s)`)
if (tierArg) console.error(`[run-all] tier=${tierArg}: ${files.length} file(s)${tierNote}`)
else if (dirsArg) console.error(`[run-all] scope: ${files.length} file(s)${tierNote}`)

// With shell:true, unquoted file paths explode when the project path contains spaces (e.g. D:My Projects): the argument string is cut at the space;
// executing the binary inside the electron package does not rely on shell lookup, so shell can be safely dropped here
// Hygiene gate: every test gets a hard 2min ceiling via --test-timeout. A test that hangs (e.g. a
// socket/watcher never closed, or a promise awaiting a sync event that never fires in CI) becomes
// a NAMED failure in <=2min instead of burning the whole CI job budget with zero diagnostics
// (2026-09-19: ubuntu job sat 30min then was killed, 0 failures reported, hang unattributable).
// 2026-09-29: raised 120s -> 300s. At 120s the ceiling itself became the top flake source:
// three consecutive local full-suite runs each failed on a DIFFERENT wall-heavy test
// (clamp assertion / slow-drip snapshot / oversize-line sever) and the slowest LEGIT test
// measured 139s under load — the margin note below used to claim 6.5x when the slowest was
// ~18s. 5min still names a hang well inside the CI job budget instead of the 30min sit.
const TEST_TIMEOUT_MS = 300000
// D22 file-concurrency knob. 2026-10-10 (CTO sweep C#6): default changed from "node's own
// default" (= cores, observed 8-12 here) to 4 — the electron-booting integration specs are the
// flake surface under a loaded box, and the boot flakes (J4/F4a family) reproduce only at high
// concurrency. 4 trades wall time for boot stability; TEST_CONCURRENCY env still overrides.
// 2026-10-23 FALSIFIED HYPOTHESIS (kept for the record): a tier-aware core default of
// cores-2 (8) was measured LIVE — 22.1min but 7 not-ok entries, and the follow-up acceptance
// run reproduced the SAME suite families twice in a row (c1-parse-ux, d26 plan, purge family):
// root cause is NOT scheduling starvation but the cli-suite spawn storm: each file spawns
// dozens of real CLI children whose wall time inflates 10-20x under concurrent process
// creation (D6: c1-parse-ux, the 40-spawn worst case, breached the 300s file ceiling).
// Concurrency 4 shows the same families at lower frequency; D6 landed suite-side (c1 now
// runs its children on concurrent lanes), default stays 4.
// 2026-10-23 speed wave RE-RAISE (core 4 -> 8; deep stays 4): the three flake root causes the
// falsification run exposed are all fixed suite-side since — (1) D6 c1-parse-ux now spawns its
// ~40 CLI children on internal concurrent lanes with per-test fixture dirs, so its wall time no
// longer rides on file-level serialization; (2) D7/D8 landed the force-exit registration doctrine
// + guard, so leaked-handle children can no longer wedge a file past its ceiling; (3) the f4
// stamp-margin flake (timing margin too tight under load) is fixed in the suite. With the
// per-file root causes gone, concurrency 8 stops multiplying independent time bombs and only
// pays the wall-time win. TEST_CONCURRENCY env still overrides both tiers.
// ACCEPTANCE (same day, measured live): --tier=core at the new default 8 = 4774/4774 pass,
// 0 fail / 0 cancelled, 5:41 wall (slowest test 31.8s, 9.4x ceiling margin) on a LOADED
// daytime host. Honest caveat kept on the record: two earlier full-core passes at 8 under
// PEAK ambient load (parallel agent lanes saturating process creation) each dropped one
// non-deterministic red — a pomodoro timing assert, and a NEW native class: a per-file child
// dying at STARTUP with `Assertion failed: ncrypto::CSPRNG(nullptr, 0)` (exit 134, Node
// bug class, random file) — now covered by NATIVE_CRASH_RE's rerun-once doctrine below, same
// as the 0xC0000409 teardown crash. At 4 the same pool measured ~11-13min wall, both passes
// green, under the same load — 8 roughly halves the unit wall and stays zero-fail on the
// designated acceptance run.
// 2026-10-23 EVENING RE-REVERT of the default (8 stays available via TEST_CONCURRENCY=8 for
// quiet windows): the evening full gate under the day's worst ambient burst red'd the unit tier
// at 8 (28.7min, 5 victims) — the lan-sync drill convergence budgets (mesh / scale / 4-pair) and
// the C14/D19 sleepBackoff timing assert are FIXED-budget asserts that a burst can push past
// their ceilings in BOTH retry passes, and the CSPRNG rerun-once doctrine absorbed crashes but
// not budget overruns. Tally at 8 across the day: 2 green / 1 red depending on load — not a
// safe DEFAULT on a family box whose load is uncontrollable; 4 stayed green in every window
// measured today. The re-raise rationale above stands for quiet windows; flip via env.
const TEST_CONCURRENCY = process.env.TEST_CONCURRENCY || '4'
// --test-force-exit: a test that passes but leaks a handle (listening server, open socket,
// watcher) would otherwise keep the per-file child process alive forever — the runner then waits
// with ZERO results (0 failures, budget kill, unattributable). Force-exit makes the child leave
// once tests finish; --test-timeout above covers the in-test hang case.
const RUNNER_ARGS = ['--test', '--test-force-exit', `--test-timeout=${TEST_TIMEOUT_MS}`,
  ...(TEST_CONCURRENCY ? [`--test-concurrency=${TEST_CONCURRENCY}`] : []),
  // Pin the TAP reporter: check-test-summary.cjs anchors its fail/skip parsing on the TAP plan
  // (`1..N` + `# fail` lines), but Node >= 24 defaults the reporter to 'spec' even for non-TTY
  // stdout — the summary gate then read fail=undefined and red'd every run (2026-09-24).
  '--test-reporter=tap', '--test-reporter-destination=stdout',
  // Coverage table carrier: the TAP reporter does not print the coverage report on
  // node 22 (CI), so --experimental-test-coverage needs a second spec-reporter stream
  // (stderr) or the coverage ratchet never finds its "# all files" summary line.
  ...(forwardArgs.includes('--experimental-test-coverage')
    ? ['--test-reporter=spec', '--test-reporter-destination=stderr']
    : [])]


// Exact-set glob compaction for Windows' 32k spawn argv ceiling.
// Only collapse a directory/extension group when the glob matches exactly the discovered files;
// excluded fixtures and suite-filtered files must never slip into the runner.
function runnerFileArgs () {
  const groups = new Map()
  for (const file of files) {
    const ext = TEST_EXTS.find(e => file.endsWith(e))
    const folder = path.dirname(file)
    const key = folder + '\0' + ext
    if (!groups.has(key)) groups.set(key, { folder, ext, entries: [] })
    groups.get(key).entries.push(file)
  }
  const args = []
  for (const { folder, ext, entries } of groups.values()) {
    const matches = readdirSync(folder).filter(n => n.endsWith(ext))
    const expected = new Set(entries.map(f => path.basename(f)))
    if (entries.length >= 2 && matches.length === expected.size && matches.every(n => expected.has(n))) {
      args.push(path.relative(appRoot, folder).split(path.sep).join('/') + '/*' + ext)
    } else {
      args.push(...entries.map(f => path.relative(appRoot, f)))
    }
  }
  return args
}

// Streaming spawn (2026-10-23 perf wave S3): the old spawnSync buffered the ENTIRE TAP until
// process exit — a budget-killed or hung run showed ZERO output for its whole lifetime (the
// 2026-10-22 fast gate sat 15.3min on a 0-byte TAP). spawn + pipe-through prints each suite's
// results as its file completes; the same bytes are still accumulated for the downstream
// consumers below (native-crash retry, coverage summary, slow-test margin), so behavior is
// identical — only visibility changed.
// Synchronous stdout write (2026-10-26 composed-TAP contract): buffered end-of-run emission
// must land BEFORE process.exit() — async process.stdout.write can be truncated by an
// immediate exit when stdout is a pipe (pipeline mode redirects run-all's stdout into the
// gate's tap file), which would truncate the composed plan mid-stream.
const emitSync = buf => { try { writeSync(1, buf) } catch { /* stdout already closed */ } }
// `live:false` buffers the stdout pipe-through (bytes still accumulate in `out` for the
// downstream consumers) — used for passes whose TAP may be REBUILT (the composed
// full-corpus stream after flake-retry absorption), so the final stdout carries exactly
// ONE coherent plan instead of pass1 raw + composed concatenated (double-plan bug
// 2026-10-26: the composed stream was assigned to r.stdout but never emitted at all,
// while pass1+retry bytes had already been piped through live).
// Tradeoff, accepted deliberately: during a buffered pass the stdout/tap-file stays empty
// (no live growth) — stderr diagnostics and the failure-path emissions below keep every
// terminal state named.
function spawnRunner (fileArgsOverride = null, { live = true } = {}) {
  return new Promise(resolve => {
    // NODE_TEST_CONTEXT must NOT leak into the runner: when run-all itself is spawned from a
    // node:test process (the gate-mechanics meta-suite), the marker inherits down the chain and
    // the runner's run() recursion guard silently SKIPS every file — exit 0 with zero TAP, the
    // worst possible false green. Runner env is therefore scrubbed clean of it.
    const env = { ...process.env }
    delete env.NODE_TEST_CONTEXT
    const child = spawn(process.execPath, [...RUNNER_ARGS,
      ...forwardArgs, ...(fileArgsOverride || runnerFileArgs())],
    // Windows caps a spawned command line at ~32k chars: with ~350 discovered files, ABSOLUTE
    // paths (K:\...\pickdone\tests\...) blow past it and spawn fails with ENAMETOOLONG —
    // exit 1 with ZERO TAP output, which the summary gate could only read as a mystery red
    // (2026-09-26 check:fast round-2). Anchor STAYS at the app root: a D25 experiment moving the
    // cwd to tests/ to shave the argv broke ~20 cwd-anchored specs (build-whitelist, CI-workflow,
    // structure pins) for a ~4k-char saving — not worth it. The argv-cap guard margin instead
    // tracks reality: repo-relative argv measured 28702 chars at 3860+ tests, still ~4k under
    // the true 32767 cap; run-all-argv-limit.test.mjs asserts against that measured headroom.
    { cwd: appRoot, env, stdio: ['inherit', 'pipe', 'pipe'] })
    // D4: registry write at spawn, prune on close — a hard-killed run-all leaves its runner
    // child discoverable by `run-all --cleanup` instead of orphaned forever.
    if (child.pid) {
      registerChild(child.pid, { match: ['--test-force-exit', '--test-reporter=tap'], purpose: 'node --test runner (run-all)' })
      child.on('close', () => unregisterChild(child.pid))
    }
    const out = []
    const err = []
    child.stdout.on('data', d => { out.push(d); if (live) process.stdout.write(d) })
    child.stderr.on('data', d => { err.push(d); process.stderr.write(d) })
    child.on('error', e => resolve({ status: null, stdout: Buffer.concat(out), stderr: Buffer.concat(err), error: e, streamed: live }))
    child.on('close', code => resolve({ status: code, stdout: Buffer.concat(out), stderr: Buffer.concat(err), streamed: live }))
  })
}

// Pass 1 is spawned BUFFERED (live:false): if the flake-retry path composes a full-corpus
// TAP, that composed stream must be the only thing on stdout (exactly-once, one coherent
// plan). Every non-composing terminal path below emits the buffered bytes exactly once.
let r = await spawnRunner(null, { live: false })
// Native-crash retry (2026-10-10 nightly R2b): on Windows, per-file child processes die at
// teardown to a libuv assertion (`!(handle->flags & UV_HANDLE_CLOSING)`, src/win/async.c)
// surfacing as exitCode 3221226505 (0xC0000409) — a Node bug, NOT a test failure, and the
// crashing file is random per run (relay-registration-guard, datasafety-… both observed).
// It failed ~half of all full-suite runs and blocks every pre-commit. When the ONLY failing
// children are native crashes, rerun the whole runner EXACTLY ONCE (the CI `rerun --failed`
// doctrine): green second run = pass with a loud note; crash or real failure again = red.
// A genuinely failing test never benefits: it fails deterministically on the rerun too.
// 2026-10-23 speed wave: SECOND native signature observed live (exit 134, d22-ux-fixes) —
// `Assertion failed: ncrypto::CSPRNG(nullptr, 0)` fired INSIDE node::InitializeOncePerProcess,
// i.e. the per-file child died at STARTUP before running any test. Process-creation storms
// under a loaded host (concurrency 8 + parallel agent lanes) trigger it; same class as the
// libuv teardown assert: a Node-native abort, never a product red, random file per run.
const NATIVE_CRASH_RE = /exitCode: (?:3221226505|134)\b/
const onlyNativeCrash = tap => {
  const notOk = tap.match(/^not ok .*(?:\n(?!not ok ).*)*/gm) || []
  return notOk.length > 0 && notOk.every(block => NATIVE_CRASH_RE.test(block))
}
if (r.status !== 0 && r.stdout && onlyNativeCrash(String(r.stdout))) {
  console.error('[run-all] native teardown crash(s) (0xC0000409 libuv async assert) were the only failures — retrying the suite once (CI rerun doctrine)')
  // The rerun is BUFFERED (live:false), not live-streamed: the flake-retry branch downstream
  // re-emits `r.stdout` on its red paths, and with a live rerun those bytes were pass1's
  // ALREADY-EMITTED TAP (double plan in the gate's tap file). Buffered, the rerun becomes the
  // single authoritative stream for every downstream branch — pass1's crash TAP is superseded
  // and the final exactly-once emission owns the rerun's bytes (one coherent plan).
  r = await spawnRunner(null, { live: false })
}
// Flake-retry per FILE (2026-10-24, generalizes the rerun doctrine above): under gate
// self-load a rotating set of 1-6 fs/timing-sensitive files red per full run while
// passing solo (observed in one night: usage-quota relay restart, migrateData
// relocation-gate pair, key-rename M-1 pair, crypto F20, settings h8-3). Re-running
// the whole corpus costs ~26min and re-rolls the same dice; re-running JUST the
// failed files costs seconds. ONE retry, failed files only, budgets unchanged — a
// file failing twice is a real red and the retry TAP is the authoritative record.
// Flood guard: more than 12 failed files means systemic breakage — never spin.
const failedFileList = tap => {
  const files = new Set()
  for (const block of (tap.match(/^not ok .*(?:\n(?!not ok ).*)*/gm) || [])) {
    const m = /location: '?([^'\r\n]+)'?/.exec(block)
    if (!m) continue
    // location is 'file:line:col' for case-level failures — keep the file path only
    const file = m[1].replace(/\\\\/g, '\\').replace(/:\d+:\d+$/, '')
    if (/\.(?:test\.mjs|test\.js)$/.test(file)) files.add(file)
  }
  return [...files]
}
// --- flake-retry observability (2026-10-25, signal-integrity audit) ---
// The audit verdict was blunt: absorbing a first red into a silent green is the
// mechanized version of "blame the load and move on" — pass1's TAP got REPLACED
// by the retry's (so the skip ratchet saw only the retried few files = partial
// corpus blindness), nothing was persisted, and DEEP_FILES (the deliberately
// load-sensitive two-machine family) could be silently absorbed like any other
// file. The retry stays (it is a legitimate anti-jitter boundary under gate
// self-load) but from now on every absorbed red is: counted, persisted, loud,
// and impossible for the deep pool.
const FLAKE_LEDGER = path.join(appRoot, 'tests', '.artifacts', 'flake-files.json')
const recordFlake = async entries => {
  try {
    const fsx = await import('node:fs')
    fsx.mkdirSync(path.dirname(FLAKE_LEDGER), { recursive: true })
    const readLedger = () => {
      try {
        const v = JSON.parse(fsx.readFileSync(FLAKE_LEDGER, 'utf8'))
        return Array.isArray(v) ? v : []
      } catch { return [] } // first entry or unreadable prior
    }
    const prior = readLedger()
    // [merge-on-write 2026-10-26] plain read-modify-write LOST entries when two gates ran
    // concurrently (pre-commit lane + check:all lane): the second writer serialized from its
    // own stale snapshot and clobbered the first lane's entries on rename. Re-read the
    // ledger immediately BEFORE the tmp+rename and UNION the entry lists, deduped by the
    // entry's (at, files) pair — a same-instant same-file entry from both lanes is one
    // flake, not two. slice(-200) keeps the observability window as before.
    const fresh = readLedger()
    const seen = new Set()
    const dedupe = e => {
      const k = JSON.stringify([e && e.at, e && e.files])
      if (seen.has(k)) return false
      seen.add(k)
      return true
    }
    const next = [...prior, ...entries, ...fresh].filter(dedupe).slice(-200)
    // [determinism 2026-10-25] atomic write (tmp+rename): two concurrent gates must not
    // tear the shared ledger mid-write (rename within the same dir is atomic on POSIX
    // and effectively atomic on win32/NTFS).
    const tmp = FLAKE_LEDGER + '.tmp-' + process.pid
    fsx.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n')
    fsx.renameSync(tmp, FLAKE_LEDGER)
    console.error(`[run-all] ⚑FLAKY ledger updated: ${path.relative(appRoot, FLAKE_LEDGER)} (${next.length} entries)`)
  } catch (e) { console.error(`[run-all] flake ledger write failed: ${e.message}`) }
}

// Split a TAP stream into { head, blocks, tail }: head = leading version line(s),
// blocks = top-level `ok N`/`not ok N` test blocks (indented continuation lines
// and their `# Subtest` prologue ride along), tail = the plan + summary comment lines.
const splitTapBlocks = tap => {
  const lines = String(tap).split(/\r?\n/)
  const head = []; const blocks = []; const tail = []
  let cur = null
  let prologue = []
  for (const line of lines) {
    if (/^(?:not )?ok \d+/.test(line)) {
      if (cur) blocks.push(cur)
      cur = [...prologue, line]
      prologue = []
    } else if (/^# Subtest/.test(line) && !/^\s/.test(line)) {
      prologue = [line]
    } else if (/^1\.\.\d+/.test(line) || (/^# (pass|fail|cancel|skip|tests|suites|cancelled|skipped|todo|duration_ms)/.test(line))) {
      if (cur) { blocks.push(cur); cur = null }
      prologue = []
      tail.push(line)
    } else if (cur && (/^\s/.test(line) || line === '')) {
      cur.push(line)
    } else if (cur) {
      cur.push(line)
    } else {
      head.push(line)
    }
  }
  if (cur) blocks.push(cur)
  return { head, blocks, tail }
}
const blockFile = block => {
  const m = /(?:^|\n)\s*location: '?([^'\r\n]+)'?/.exec(block.join('\n'))
  return m ? m[1].replace(/\\\\/g, '\\').replace(/:\d+:\d+$/, '') : null
}
const renumber = blocks => blocks.map((b, i) => {
  const lines = [...b]
  lines[0] = lines[0].replace(/^(ok|not ok) \d+/, (m0, kw) => `${kw} ${i + 1}`)
  return lines
})

if (r.status !== 0 && !r.error && r.stdout) {
  const failedFiles = failedFileList(String(r.stdout))
  if (failedFiles.length > 0 && failedFiles.length <= 12) {
    console.error(`[run-all] ${failedFiles.length} file(s) failed — flake-retry pass on just those files (one shot, budgets unchanged)`)
    for (const f of failedFiles) console.error('  ↻ ' + path.relative(appRoot, f))
    // 30s settle before the retry: the full pass leaves the host hot (concurrent-pool
    // debris, fs flushing); retrying into the same heat re-loses the same races
    // (check-test-scope-golden flunked the immediate retry twice before this delay).
    await new Promise(r2 => setTimeout(r2, 30000))
    // The retry pass is buffered too (live:false): its bytes may be folded into the composed
    // full-corpus stream, and every terminal branch below emits its buffers exactly once.
    const retry = await spawnRunner(failedFiles.map(f => path.relative(appRoot, f)), { live: false })
    if (retry.status === 0) {
      const deepHit = failedFiles.filter(f => DEEP_FILES.has(path.basename(f)))
      if (deepHit.length > 0) {
        // [signal-integrity 2026-10-25] the deep pool IS the deliberate load-sensitivity
        // probe — a first red there is the signal we built this suite to catch. The retry
        // run stays on record, but it must never flip the exit: pass1 red stays red.
        console.error('[run-all] ⚑FLAKY retry GREEN but DEEP_FILES hit (' + deepHit.map(f => path.basename(f)).join(', ') + ') — NOT absorbed: pass1 red stands, retry recorded as evidence')
        await recordFlake([{
          at: new Date().toISOString(), absorbed: false, deepPool: true,
          files: failedFiles.map(f => path.relative(appRoot, f)),
          note: 'deep-pool load-sensitivity: retry green, pass1 red stands'
        }])
        // pass1 TAP stays in r.stdout (final exactly-once emission) — the suite verdict.
        console.error('[run-all] retry TAP below is EVIDENCE ONLY (suite verdict = pass1):')
        emitSync(retry.stdout || '')
      } else {
        // Compose a FULL-corpus TAP for the summary gate: pass1 blocks minus the
        // retried files' blocks, then the retry's own blocks — the skip ratchet
        // sees every file of this run again (partial-corpus blindness closed).
        // Fail-closed twice over (2026-10-26): composition is refused BOTH on parse
        // low-confidence AND when the kept corpus still carries not-ok blocks —
        // blockFile()-null-located failures (shared helpers, tests/lib/*.mjs) are
        // neither retried nor absorbable, and counting them as zero was a fake green.
        const pass1 = String(r.stdout || '')
        const retryTap = String(retry.stdout || '')
        const p1 = splitTapBlocks(pass1)
        const rt = splitTapBlocks(retryTap)
        const retriedSet = new Set(failedFiles)
        const kept = []
        let keptNotOk = 0
        for (const b of p1.blocks) {
          const file = blockFile(b)
          if (file && retriedSet.has(file)) continue // retry's verdict is authoritative
          if (/^not ok \d+/.test(b[0])) keptNotOk++
          kept.push(b)
        }
        const planOk = /^1\.\.\d+/.test(p1.tail.find(l => /^1\.\.\d+/.test(l)) || '')
        const notOkInRetry = rt.blocks.filter(b => /^not ok \d+/.test(b[0])).length
        // pass1's cancel count rides the kept corpus (retried files' cancels cannot be
        // separated block-wise; the gate reds on any nonzero cancelled either way)
        const cancelled1 = Number((/# cancelled\s+(\d+)/.exec(p1.tail.join('\n')) || [])[1] || 0)
        if (planOk && keptNotOk === 0 && notOkInRetry === 0 && rt.blocks.length > 0) {
          const all = renumber([...kept, ...rt.blocks])
          const skips = all.filter(b => /# (SKIP|skip)/.test(b.join('\n'))).length
          const composed = [
            ...p1.head,
            ...all.map(b => b.join('\n')),
            `1..${all.length}`,
            `# pass ${all.length - skips}`,
            // fail line is MANDATORY (2026-10-26): the composed summary previously omitted it
            // entirely — parseSummary returns fail=undefined without it and the gate fail-closed
            // on "摘要解析失败". Here both counts are provably 0 (the branch guard above).
            `# fail ${keptNotOk + notOkInRetry}`,
            `# skip ${skips}`,
            // REAL counts (2026-10-26): the hardcoded `# cancelled 0` masked kept cancel
            // blocks; pass1's summary count is carried through so the gate sees truth.
            `# cancelled ${cancelled1}`,
            `# COMPOSED after flake-retry absorption (${failedFiles.length} file(s) re-ran green; pass1 blocks for those files replaced by retry blocks)`,
            `# flake-absorbed-at ${new Date().toISOString()}`
          ].join('\n')
          console.error(`[run-all] ⚑FLAKY absorbed ${failedFiles.length} file(s) (load-band class) — suite green, composed full-corpus TAP, ledger updated`)
          await recordFlake([{
            at: new Date().toISOString(), absorbed: true, deepPool: false,
            files: failedFiles.map(f => path.relative(appRoot, f)),
            pass1Blocks: String(pass1.match(/^not ok .*(?:\n(?!not ok ).*)*/gm) || []).length,
            note: 'first red re-ran green under lighter load (retried files only + 30s settle)'
          }])
          // r.stdout = the ONE coherent composed stream; final emission below writes it once.
          r = { status: 0, stdout: composed, stderr: r.stderr, streamed: false }
        } else if (keptNotOk > 0) {
          // Kept not-ok outside the retried file set: real failures the retry never covered.
          // Refuse composition and fall through to the RED path — pass1's exit stands.
          console.error(`[run-all] ⚑FLAKY absorption REFUSED: ${keptNotOk} pass1 not-ok block(s) OUTSIDE the retried file set (failures in shared helpers / unattributable blocks are neither retried nor absorbable) — real red stands`)
          await recordFlake([{
            at: new Date().toISOString(), absorbed: false, deepPool: false,
            files: failedFiles.map(f => path.relative(appRoot, f)),
            keptNotOk,
            note: 'kept pass1 not-ok outside retried set — absorption refused, composition skipped'
          }])
          console.error('[run-all] retry TAP below is EVIDENCE ONLY (suite verdict = pass1):')
          emitSync(retry.stdout || '')
          // r stays pass1 (status !== 0) → red exit via the final emission + status
        } else {
          console.error(`[run-all] ⚑FLAKY absorbed but TAP composition skipped (parse confidence low: plan=${planOk} keptNotOk=${keptNotOk} retryNotOk=${notOkInRetry}) — raw pass1+retry TAP on stdout, SKIP RATCHET SAW PARTIAL CORPUS`)
          console.error('[run-all] ⚑FLAKY ledger still records this absorption')
          await recordFlake([{
            at: new Date().toISOString(), absorbed: true, deepPool: false, composed: false,
            files: failedFiles.map(f => path.relative(appRoot, f)),
            note: 'absorbed; ratchet saw partial corpus (composition guard failed)'
          }])
          r = { status: 0, stdout: Buffer.concat([r.stdout, retry.stdout]), stderr: r.stderr, streamed: false }
        }
      }
    } else {
      console.error('[run-all] flake-retry did NOT absorb — real red, retry TAP below is authoritative')
      emitSync(r.stdout) // pass1 raw TAP precedes the authoritative retry TAP
      r = retry
    }
  }
}
// Fail closed and LOUD on spawn errors: r.status is null when the child never ran, so the
// old `r.status ?? 1` fell through to exit 1 with empty output — indistinguishable from a
// test failure and unattributable. Name the errno instead.
if (r.error) {
  console.error(`✗ [run-all] test runner failed to spawn: ${r.error.code || r.error.message}`)
  process.exit(1)
}
// TAP/spec streams were already piped through live by spawnRunner() — no end-of-run replay.
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
    // fail count MUST ride along (2026-09-29 instrument fix): an ABORTED suite under-loads the
    // file set (fewer children -> smaller denominator) and reads up to ~11pt HIGHER than the
    // same tree fully green (84.83 aborted vs 73.26 green, same commit). The ratchet must only
    // reuse summaries from GREEN runs — without the fail count it could not tell them apart.
    // String() is mandatory: spawnSync without `encoding` returns Buffers, and Buffer.match
    // throws — the throw used to abort the whole summary write (first CI run after the edit).
    const stdoutText = String(r.stdout || '')
    const failCount = (stdoutText.match(/^not ok /gm) || []).length
    // suite tag: the coverage ratchet only auto-raises its baseline from the suite it was
    // calibrated on ('unit'); a full-suite summary must be visibly labeled so the ratchet
    // can tell the instruments apart instead of silently mixing them. A --tier run is a
    // DIFFERENT instrument still (its file set is a strict subset/superset) — the tier rides
    // the tag so the ratchet treats it as compare-only, never as a raise source.
    const suiteTag = (suites.length ? suites.join('+') : 'all') + (tierArg ? `+${tierArg}` : '')
    // [determinism 2026-10-25] atomic write (tmp+rename) — a concurrent gate must not read
    // a torn summary (the ratchet must never raise a baseline from a half-written file).
    const covTmp = path.join(artifacts, 'coverage-summary.json.tmp-' + process.pid)
    fs.writeFileSync(covTmp,
      JSON.stringify({ ...all, failCount, suite: suiteTag, generatedAt: new Date().toISOString() }, null, 2) + '\n')
    fs.renameSync(covTmp, path.join(artifacts, 'coverage-summary.json'))
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
// Exactly-once stdout emission (2026-10-26 composed-TAP contract): passes that may be
// composed are spawned buffered (live:false), so r.stdout here is the ONE authoritative
// stream — the raw TAP for non-composing runs, the composed full-corpus TAP after
// absorption. Emit it synchronously (flush before process.exit truncates a pipe).
if (!r.streamed && r.stdout && r.stdout.length) emitSync(r.stdout)
process.exit(r.status ?? 1)
