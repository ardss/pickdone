/**
 * D7/D8 doctrine guard (2026-10-23): a test file must register ALL its tests BEFORE the
 * first one starts — no test() registration above (before) a module-body top-level
 * `await import(...)`.
 *
 * Why a static guard: node --test --test-force-exit has TWO failure faces when the rule is
 * violated (both pinned in docs/perf-debt-ledger.md D7/D8):
 *   1. premature teardown — any test finalizing while waitingOn > subtests.length triggers
 *      harness teardown + process.exit mid-file: cancelledByParent, exit 1 with fail 0;
 *   2. SILENT TRUNCATION — if the loop drains cleanly at that moment, force-exit ends the
 *      child with EXIT 0 and every test registered below the await NEVER RUNS. The gate
 *      read "6/6 green" on an 18-test file for who knows how long (D8 evidence).
 * Timer-based mitigations cannot survive face 1; nothing can detect face 2 at runtime —
 * which is why this is a SOURCE-SHAPE guard, not a runtime check.
 *
 * Heuristic (deliberately simple): flag a file where a line starting with `await ` (column 0,
 * i.e. module body, not inside a test callback) appears AFTER the first line starting with
 * `test(` or `test('`. Column-0 awaits inside describe blocks don't exist in this repo's
 * style; indented awaits (inside tests) are not module-body suspends and are fine.
 *
 * Run: node --test tests/unit/cli/test-file-registration-order.test.mjs
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..')
const TEST_DIRS = ['tests/unit', 'tests/integration', 'tests/visual', 'tests/e2e', 'test']
  .map(d => path.join(ROOT, d))
  .filter(d => fs.existsSync(d))

function collectTestFiles (dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) collectTestFiles(p, out)
    else if (e.name.endsWith('.test.mjs')) out.push(p)
  }
  return out
}

function violation (file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)
  let firstTest = -1
  for (let i = 0; i < lines.length; i++) {
    if (/^(\s*)test\(/.test(lines[i]) === true && /^\s*test\(/.test(lines[i])) {
      // any indentation of test( counts: describe-wrapped files register through the same runner
      if (firstTest === -1) firstTest = i
    }
    if (firstTest !== -1 && /^await\s/.test(lines[i])) {
      return { line: i + 1, snippet: lines[i].trim().slice(0, 80), firstTestLine: firstTest + 1 }
    }
  }
  return null
}

test('D7/D8 doctrine: no test() registration precedes a module-body await import', () => {
  const offenders = []
  for (const dir of TEST_DIRS) {
    for (const f of collectTestFiles(dir)) {
      const v = violation(f)
      if (v) offenders.push(`${path.relative(ROOT, f)}:${v.line} (first test at :${v.firstTestLine}) → ${v.snippet}`)
    }
  }
  assert.deepEqual(offenders, [], [
    'test files register test() BEFORE a module-body top-level await import —',
    'under --test-force-exit this truncates (silent exit 0, tests below the await never run)',
    'or cancels (exit 1, fail 0). Hoist the await import above ALL test() registrations',
    '(reference pattern: commit e36814e0, doctrine in docs/perf-debt-ledger.md D7/D8).',
    'Offenders:',
    ...offenders.map(o => '  ' + o)
  ].join('\n'))
})
