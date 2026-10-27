/* W13 gate fixes (2026-10-26) — source-contract pins (same convention as w12-gates-fixes;
 * run-all / the shared-pool runner / the journey files have no TAP-fixture goldens, so these
 * pin the CONTRACTS in source, with one behavioral pin that executes the REAL source text):
 *   Fix 1  run-all cancelled counting is line-by-line (per-line anchored) — a tail carrying
 *          `# cancelled 2` yields 2 (the old un-`m`'d joined-tail exec parsed 0 forever, so
 *          the W12 absorption-refused guard never fired: fake green on cancelled tests)
 *   Fix 2  journey watchdogs are RE-ARMED per test inside the pool's 8min budget (7min), and
 *          each test's finally nulls cleanupFn (no stale-fire concurrent cleanup re-runs)
 *   Fix 3  shared-pool runTarget resolves a NAMED failure verdict on spawn 'error' (no more
 *          forever-hang + taskkill against an undefined pid)
 * Run: node --test tests/unit/cli/w13-gates-fixes.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runAllSrc = fs.readFileSync(path.join(root, 'run-all.mjs'), 'utf8')
const sharedSrc = fs.readFileSync(path.join(root, 'run-interactions-shared.mjs'), 'utf8')
const todoSrc = fs.readFileSync(path.join(root, 'e2e-journeys/j-todo-core.test.mjs'), 'utf8')
const habitSrc = fs.readFileSync(path.join(root, 'e2e-journeys/j-habit-moment.test.mjs'), 'utf8')
const railSrc = fs.readFileSync(path.join(root, 'e2e-journeys/j-rail-stats-settings.test.mjs'), 'utf8')

test('Fix 1: cancelled counting is per-line; a tail with `# cancelled 2` yields 2', () => {
  // the old un-`m`'d joined-tail exec form must be gone
  assert.ok(!/\/# cancelled\\s\+\(\\d\+\)\/\.exec\(/.test(runAllSrc),
    'the joined-tail /# cancelled\\s+(\\d+)/.exec(...) form must not remain in run-all.mjs')
  assert.ok(runAllSrc.includes('const countCancelled'),
    'run-all.mjs must count cancelled per tail line (fail-loud by construction)')
  // behavioral pin: execute the REAL source text of countCancelled against W12 Fix 5's guard
  const line = runAllSrc.split('\n').find(l => l.trim().startsWith('const countCancelled'))
  assert.ok(line, 'the countCancelled definition line must be extractable from source')
  // eslint-disable-next-line no-new-func -- deliberate: the pin runs the actual production source text
  const countCancelled = new Function(`return (${line.trim().replace(/^const countCancelled = /, '')})`)()
  const tail = ['1..3', '# pass 1', '# fail 1', '# cancelled 2']
  assert.equal(countCancelled(tail), 2, 'a tail carrying `# cancelled 2` must yield 2 (never 0)')
  assert.equal(countCancelled(['1..3', '# cancelled 0']), 0, 'a clean tail still yields 0')
})

test('Fix 2: every journey watchdog is re-armed per test inside the pool budget; finallys null cleanupFn', () => {
  for (const [name, src] of [['j-todo-core', todoSrc], ['j-habit-moment', habitSrc], ['j-rail-stats-settings', railSrc]]) {
    assert.ok(src.includes('const armWatchdog') && src.includes('clearTimeout(watchdogTimer)'),
      `${name}: registerCleanup must RE-ARM the watchdog (clear the stale timer first)`)
    const wd = src.indexOf('const watchdog = setTimeout')
    assert.ok(wd > 0, `${name}: watchdog must exist`)
    const body = src.slice(wd, wd + 800)
    assert.ok(body.includes('cleanupFn') && body.includes('sleep(5000)'),
      `${name}: the watchdog must run the registered cleanupFn with a 5s grace before exiting`)
    const wm = /const WATCHDOG_MS = (\d+) \* 60 \* 1000/.exec(src)
    assert.ok(wm, `${name}: the watchdog budget must be a named constant`)
    assert.ok(Number(wm[1]) <= 8 && Number(wm[1]) >= 5,
      `${name}: WATCHDOG_MS must sit inside the pool's 8min per-target budget (got ${wm[1]}min)`)
    assert.ok(!/setTimeout\(async \(\) => \{[\s\S]*?\n\}, 120000\)/.test(src) && !/\}, 240000\)/.test(src),
      `${name}: the once-at-module-load 120s/240s single timer must be gone`)
    assert.ok((src.match(/cleanupFn = null/g) || []).length >= 4,
      `${name}: the watchdog AND every test finally must null cleanupFn (no concurrent re-runs)`)
  }
})

test('Fix 3: shared-pool runTarget resolves a named failure verdict on spawn error', () => {
  const rt = sharedSrc.indexOf('function runTarget')
  assert.ok(rt > 0, 'runTarget must exist')
  const body = sharedSrc.slice(rt, sharedSrc.indexOf('const results = []'))
  const errHandler = body.indexOf("child2.on('error'")
  assert.ok(errHandler > 0, "runTarget must attach a child2.on('error') handler")
  const hBody = body.slice(errHandler, body.indexOf('})', errHandler))
  assert.ok(hBody.includes('clearTimeout(killer)'), 'the handler must disarm the 8min killer')
  assert.ok(hBody.includes('spawnError'), 'the handler must resolve a NAMED spawnError verdict')
  assert.ok(hBody.includes('code: 1'), 'the handler must attribute the failure (code 1)')
  assert.ok(sharedSrc.includes('spawnError') && sharedSrc.includes('[spawn error: '),
    'the pool summary must surface the spawn error on the verdict note')
})
