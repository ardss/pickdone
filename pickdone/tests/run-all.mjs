/**
 * Unified entry for unit/integration tests - single source of truth: auto-discovers tests/*.test.mjs, eliminating drift between three hand-written lists
 * (Historical incident: package.json and check-all each kept their own list; 2 files were once missed by npm test)
 * e2e.test.mjs needs a live Electron instance, stays out of the default regression, and runs via a separate `npm run e2e`.
 * Passes extra args to node --test, e.g.: node tests/run-all.mjs --experimental-test-coverage
 */
import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = path.dirname(fileURLToPath(import.meta.url))
// integration-ui spawns its own Electron instance (~60s) and stays out of the quick regression - run by a dedicated check:all stage / npm run it
const EXCLUDE = new Set(['e2e.test.mjs', 'integration-ui.test.mjs'])
const files = readdirSync(dir)
  .filter(f => f.endsWith('.test.mjs') && !EXCLUDE.has(f))
  .sort()
  .map(f => path.join(dir, f))

if (!files.length) { console.error('✗ no *.test.mjs found under tests/'); process.exit(1) }

// With shell:true, unquoted file paths explode when the project path contains spaces (e.g. D:My Projects): the argument string is cut at the space;
// executing the binary inside the electron package does not rely on shell lookup, so shell can be safely dropped here
const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files],
  { stdio: 'inherit' })
process.exit(r.status ?? 1)
