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
// integration-ui spawns its own Electron instance (~60s) and stays out of the quick regression - run by a dedicated check:all stage / npm run it
const EXCLUDE = new Set(['e2e.test.mjs', 'integration-ui.test.mjs'])

const KNOWN_SUITES = new Set(['unit', 'integration', 'visual'])

function discover(root, acc = []) {
  for (const e of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(root, e.name)
    if (e.isDirectory()) {
      // fixtures/ holds shared test data, not runnable specs — skip it recursively so a stray
      // *.test.mjs dropped there is never picked up as a suite member
      if (e.name === 'fixtures') continue
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
const r = spawnSync(process.execPath, ['--test', ...forwardArgs, ...files],
  { stdio: 'inherit' })
process.exit(r.status ?? 1)
