/* W12 gate fixes (2026-10-26) — source-contract pins (no TAP fixtures in tests/unit/cli, per
 * the W11 convention; run-all / the shared-pool runner / the journey files have no goldens,
 * so these pin the CONTRACTS in source):
 *   Fix 1  shared-pool reset deadline (60s, named SharedPageResetTimeout)
 *   Fix 2  journey watchdogs run a registered best-effort cleanup before process.exit(1)
 *   Fix 3  j-todo-core evalAwait surfaces page exceptions + hardCleanup verifies post-delete
 *   Fix 4  pass1 streams live; composed/appended streams carry the COMPOSED-TAP-FOLLOWS marker
 *          (parseSummary in cli/check-test-summary.cjs anchors the LAST plan — verified by this
 *          test against the real parser, read-only)
 *   Fix 5  composition refused on nonzero cancelled from EITHER tail; real sum emitted
 *   Fix 6  shared-pool log has no per-pid suffix; it-app.log is truncated at run start
 * Run: node --test tests/unit/cli/w12-gates-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runAllSrc = fs.readFileSync(path.join(root, 'run-all.mjs'), 'utf8')
const sharedSrc = fs.readFileSync(path.join(root, 'run-interactions-shared.mjs'), 'utf8')
const itSrc = fs.readFileSync(path.join(root, 'integration-ui.test.mjs'), 'utf8')
const todoSrc = fs.readFileSync(path.join(root, 'e2e-journeys/j-todo-core.test.mjs'), 'utf8')
const habitSrc = fs.readFileSync(path.join(root, 'e2e-journeys/j-habit-moment.test.mjs'), 'utf8')
const railSrc = fs.readFileSync(path.join(root, 'e2e-journeys/j-rail-stats-settings.test.mjs'), 'utf8')

test('Fix 1: shared-pool reset is bounded by a single deadline and throws a named error', () => {
  assert.ok(/RESET_DEADLINE_MS = 60000/.test(sharedSrc), 'reset deadline constant (60s) must exist')
  assert.ok(/SharedPageResetTimeout/.test(sharedSrc), 'the deadline overrun must be a NAMED error')
  assert.ok(/deadline - Date\.now\(\) > 0/.test(sharedSrc), 'the readiness loop must respect the deadline')
  assert.ok(!/within 20s'/.test(sharedSrc), 'the stale 20s-budget claim must be gone')
})

test('Fix 2: every journey watchdog races a registered cleanup (5s grace) before process.exit(1)', () => {
  for (const [name, src] of [['j-todo-core', todoSrc], ['j-habit-moment', habitSrc], ['j-rail-stats-settings', railSrc]]) {
    const wd = src.indexOf('const watchdog = setTimeout')
    assert.ok(wd > 0, `${name}: watchdog must exist`)
    const body = src.slice(wd, wd + 800)
    assert.ok(body.includes('registerCleanup') || (body.includes('cleanupFn') && body.includes('sleep(5000)')),
      `${name}: the watchdog must run the registered cleanupFn with a 5s grace before exiting`)
    assert.ok(src.includes("let cleanupFn = null") && src.includes('const registerCleanup'),
      `${name}: module-level cleanupFn + registerCleanup must exist`)
    assert.ok((src.match(/registerCleanup\(cleanup\)/g) || []).length >= 3,
      `${name}: every journey test must register its cleanup`)
  }
})

test('Fix 3: j-todo-core evalAwait surfaces page exceptions and hardCleanup verifies post-delete', () => {
  const ea = todoSrc.indexOf('const evalAwait = async')
  assert.ok(ea > 0, 'evalAwait must exist')
  assert.ok(todoSrc.slice(ea, ea + 700).includes('exceptionDetails'),
    'j-todo-core evalAwait must surface exceptionDetails (j-habit parity)')
  const hc = todoSrc.indexOf('const hardCleanup')
  const hcBody = todoSrc.slice(hc, todoSrc.indexOf('\n}', hc))
  assert.ok(hcBody.includes('LEAKED ROWS') && hcBody.includes('dbBinned'),
    'hardCleanup must re-query live AND binned rows and fail loudly naming leaks')
})

test('Fix 4: pass1 streams live; composed/appended streams carry the last-plan separator', () => {
  assert.ok(/let r = await spawnRunner\(\)/.test(runAllSrc), 'pass1 must be spawned live')
  assert.ok(runAllSrc.includes('COMPOSED-TAP-FOLLOWS'),
    'the composed stream must carry the loud separator line')
  assert.ok(runAllSrc.includes('RETRY-TAP-FOLLOWS'),
    'the appended retry tail (composition skipped) must carry a separator too')
  assert.ok(!/emitSync\(r\.stdout\) \/\/ pass1 raw TAP precedes/.test(runAllSrc),
    'the flake-retry red path must not re-emit pass1 bytes (already live-streamed)')
  // verify the parseSummary last-plan anchoring claim as a SOURCE contract — cli/check-test-summary.cjs
  // has top-level side effects (it runs run-all when required/executed with no TAP arg), so it can
  // never be require()d from a test; the anchoring logic itself was verified by reading it
  // (scan from the END for /^1\.\.\d+\s*$/, read summary lines only AFTER it — verified 2026-10-26).
  const summarySrc = fs.readFileSync(path.join(root, '../cli/check-test-summary.cjs'), 'utf8')
  const ps = summarySrc.indexOf('function parseSummary')
  const psBody = summarySrc.slice(ps, summarySrc.indexOf('}', summarySrc.indexOf("lines.slice(planIdx + 1)", ps)))
  assert.ok(psBody.includes("if (/^1\\.\\.\\d+\\s*$/.test(lines[i])) { planIdx = i; break }"),
    'parseSummary must find the LAST plan line (backward scan, first match wins)')
  assert.ok(psBody.includes('lines.slice(planIdx + 1)'),
    'parseSummary must read summary lines only AFTER the last plan')
})

test('Fix 5: composition is refused on nonzero cancelled from either tail; the real sum is emitted', () => {
  const i = runAllSrc.indexOf('cancelled2 = Number(')
  assert.ok(i > 0, 'the retry tail cancelled count must be parsed')
  const guard = runAllSrc.slice(runAllSrc.indexOf('if (planOk &&'), runAllSrc.indexOf('{', runAllSrc.indexOf('cancelled2 = Number(')))
  assert.ok(guard.includes('cancelled1 === 0 && cancelled2 === 0'),
    'the compose guard must require zero cancelled in BOTH tails')
  assert.ok(runAllSrc.includes('cancelled1 > 0 || cancelled2 > 0'),
    'a cancelled refusal branch must exist')
  assert.ok(/`# cancelled \$\{cancelled1 \+ cancelled2\}`/.test(runAllSrc),
    'the composed summary must emit the real cancelled sum')
})

test('Fix 6: shared-pool log has no per-pid suffix; it-app.log is truncated at run start', () => {
  assert.ok(sharedSrc.includes("smoke-shared-pool.log'"), 'single reused log file name')
  assert.ok(!/smoke-shared-pool-['+ ]*\+ process\.pid/.test(sharedSrc), 'no per-pid suffix')
  assert.ok(/writeFileSync\(IT_APP_LOG, ''\)/.test(itSrc), 'it-app.log must be truncated (write empty) at run start')
  assert.ok(!itSrc.includes("it-app.log', 'a"), 'appends must go through the IT_APP_LOG const with truncation at start')
})
